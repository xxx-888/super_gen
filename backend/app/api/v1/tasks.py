"""
Tasks API - 任务管理接口
"""
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from typing import List, Optional

from app.core.database import get_db
from app.core.security import get_current_user
from app.api.deps import get_current_org
from app.core.exceptions import NotFoundException
from app.models import User, GenerationTask
from app.schemas import (
    GenerationTaskResponse,
    TaskProgressUpdate,
    ImageGenerationRequest,
    VideoGenerationRequest,
    BatchVideoGenerationRequest,
    FullAutoGenerationRequest,
    SubtitleRequest,
)

router = APIRouter()


def _redact_task_meta(meta: Optional[dict]) -> dict:
    """对 task.meta 里的 logs 做超长字符串脱敏（处理历史已入库数据）。

    新任务的日志在写入时已由 base.make_log 脱敏，但 DB 里可能残留早期未脱敏的
    巨型 base64 字符串（如 MiniMax 提交日志里的图片 data URI）。这里在 API 返回前
    再跑一次 redact_large_strings，保证接口响应和前端展示都不卡。
    """
    from app.adapters.base import redact_task_meta
    return redact_task_meta(meta)


async def _enrich_task(task: GenerationTask, db: AsyncSession) -> dict:
    """把 GenerationTask ORM 转成 dict，并补全关联字段（scene/episode/script/prompt）。

    scene_id 存在 input_data JSONB 里，需要手动 join Scene → Episode → Script。
    """
    from app.models import Scene, Episode, Script
    d = {
        "id": task.id,
        "project_id": task.project_id,
        "episode_id": task.episode_id,
        "type": task.type,
        "model": task.model,
        "input_data": task.input_data or {},
        "output_urls": task.output_urls,
        "credits_consumed": task.credits_consumed or 0,
        "status": task.status,
        "progress": task.progress or 0,
        "error_message": task.error_message,
        # 历史任务可能已存入含 base64 的超长日志，返回前脱敏避免接口/页面卡顿
        "meta": _redact_task_meta(task.meta),
        "started_at": task.started_at,
        "completed_at": task.completed_at,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        # 关联字段默认 None
        "scene_sequence": None,
        "episode_number": None,
        "episode_title": None,
        "script_title": None,
        "prompt": None,
    }
    # input_data 里的 prompt（图片任务）优先；视频任务的 prompt 在 Scene 上
    in_data = task.input_data or {}
    if isinstance(in_data, dict):
        d["prompt"] = in_data.get("prompt")

    # 通过 scene_id 关联（优先用真实列；历史任务回退 input_data）
    scene_id_raw = task.scene_id or (in_data.get("scene_id") if isinstance(in_data, dict) else None)
    if scene_id_raw:
        try:
            sid = UUID(str(scene_id_raw)) if not isinstance(scene_id_raw, UUID) else scene_id_raw
            sc_result = await db.execute(select(Scene).where(Scene.id == sid))
            sc = sc_result.scalar_one_or_none()
            if sc:
                d["scene_sequence"] = sc.sequence
                if not d["prompt"]:
                    d["prompt"] = sc.prompt
                if sc.episode_id:
                    ep_result = await db.execute(select(Episode).where(Episode.id == sc.episode_id))
                    ep = ep_result.scalar_one_or_none()
                    if ep:
                        d["episode_number"] = ep.number
                        d["episode_title"] = ep.title
                if sc.script_id:
                    scr_result = await db.execute(select(Script).where(Script.id == sc.script_id))
                    scr = scr_result.scalar_one_or_none()
                    if scr:
                        d["script_title"] = scr.title
        except Exception:
            pass  # scene_id 解析失败不阻断，关联字段留空

    # 兜底：无 scene_id 但有 episode_id（创作面板提交的任务）→ 从 episode 关联
    if d["episode_number"] is None and task.episode_id:
        try:
            ep_result = await db.execute(select(Episode).where(Episode.id == task.episode_id))
            ep = ep_result.scalar_one_or_none()
            if ep:
                d["episode_number"] = ep.number
                d["episode_title"] = ep.title
                if ep.script_id:
                    scr_result = await db.execute(select(Script).where(Script.id == ep.script_id))
                    scr = scr_result.scalar_one_or_none()
                    if scr:
                        d["script_title"] = scr.title
        except Exception:
            pass

    # 再兜底：资源生图等任务在 meta 里直接记了来源剧本（解析入库时资源带 script_id）
    if d["script_title"] is None:
        _m = task.meta or {}
        if isinstance(_m, dict) and _m.get("script_title"):
            d["script_title"] = _m.get("script_title")

    return d


@router.get("", response_model=List[GenerationTaskResponse])
async def get_tasks(
    project_id: Optional[UUID] = None,
    status: Optional[str] = None,
    type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取任务列表（含关联的剧本/集数/分镜/提示词）"""
    stmt = select(GenerationTask).where(GenerationTask.deleted_at.is_(None))

    if project_id is not None:
        stmt = stmt.where(GenerationTask.project_id == project_id)
    if status is not None:
        stmt = stmt.where(GenerationTask.status == status)
    if type is not None:
        stmt = stmt.where(GenerationTask.type == type)

    stmt = stmt.order_by(GenerationTask.created_at.desc())
    result = await db.execute(stmt)
    tasks = result.scalars().all()
    # 批量补全关联字段
    return [await _enrich_task(t, db) for t in tasks]


@router.get("/{task_id}", response_model=GenerationTaskResponse)
async def get_task(
    task_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取任务详情（含关联的剧本/集数/分镜/提示词）"""
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise NotFoundException("Task not found")

    return await _enrich_task(task, db)


@router.post("/{task_id}/cancel")
async def cancel_task(
    task_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """取消任务"""
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise NotFoundException("Task not found")

    task.status = "cancelled"
    await db.commit()
    return {"message": "Task cancelled", "task_id": str(task.id)}


@router.post("/{task_id}/retry")
async def retry_task(
    task_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """重试失败的任务"""
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise NotFoundException("Task not found")

    task.status = "pending"
    task.progress = 0
    task.error_message = None
    await db.commit()
    return {"message": "Task retried", "task_id": str(task.id)}


@router.delete("/{task_id}")
async def delete_task(
    task_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除任务记录（软删除：用户侧不再显示，后台任务队列仍保留作审计底账）"""
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise NotFoundException("Task not found")

    from datetime import datetime, timezone
    task.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return {"message": "Task deleted (soft)", "task_id": str(task_id)}


@router.get("/{task_id}/logs")
async def get_task_logs(
    task_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取任务日志"""
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise NotFoundException("Task not found")

    # 从 meta 中提取日志，若无则返回空列表
    meta = task.meta or {}
    logs = meta.get("logs", [])
    # 历史日志可能含 base64 超长字符串，返回前脱敏
    from app.adapters.base import redact_large_strings
    return redact_large_strings(logs)


# ==================== WebSocket实时进度 ====================

@router.websocket("/ws/tasks/{task_id}")
async def websocket_task_progress(websocket: WebSocket, task_id: UUID):
    """
    WebSocket连接 - 实时接收任务进度更新

    使用方式:
        const ws = new WebSocket(`ws://localhost:8000/api/v1/ws/tasks/${taskId}`);
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            // 更新进度条等UI
        };
    """
    await websocket.accept()

    try:
        # 这里应该:
        # 1. 验证用户权限(从query参数获取token)
        # 2. 订阅Redis频道或Celery事件
        # 3. 将进度更新推送给客户端

        while True:
            # 保持连接活跃，等待消息
            data = await websocket.receive_text()

            if data == "ping":
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        print(f"WebSocket disconnected for task {task_id}")


# ==================== 视频生成接口 ====================

@router.post("/generate/image")
async def generate_image(
    body: ImageGenerationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    current_org=Depends(get_current_org),
):
    """单张图片生成（文生图）。

    走 creation_service.submit_creation 统一流程（模型解析 + 扣积分 + 适配器调用），
    而非废弃的 Celery 占位任务。返回任务摘要（含输出URL）。
    """
    from app.services.creation_service import submit_creation
    from app.models import AIModel
    model_name = "auto"
    model_config = None
    if body.model:
        ml_r = await db.execute(select(AIModel).where(AIModel.id == body.model))
        ml = ml_r.scalar_one_or_none()
        if ml and ml.is_enabled:
            model_name = (ml.config or {}).get("model", ml.name) or ml.name
            model_config = {
                "provider": ml.provider, "type": ml.type,
                "endpoint": ml.endpoint, "api_key": ml.api_key,
                "config": ml.config or {},
            }
    result = await submit_creation(
        db, current_org.id, current_user.id, "image",
        {"prompt": body.prompt, "count": 1, "size": "1:1"},
        model=model_name, model_config=model_config,
        scene_id=body.scene_id,
    )
    return result


@router.post("/generate/video", response_model=GenerationTaskResponse)
async def generate_video(
    body: VideoGenerationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    单个视频生成

    支持模式:
    - 文生视频 (text-to-video): 仅提供prompt
    - 图生视频 (image-to-video): 提供首帧图片 + prompt
    """
    # 模型可用性检查：必须有配置好的图生视频模型
    from app.services.creation_service import _ensure_model_available
    await _ensure_model_available(db, "image_to_video")

    from app.tasks.video_gen import generate_video_task
    from app.adapters.factory import resolve_actual_model_id
    actual_model = body.model or await resolve_actual_model_id("image_to_video", None, db) or "auto"

    task = GenerationTask(
        user_id=current_user.id,
        scene_id=body.scene_id,
        type="video",
        model=actual_model,
        input_data={**body.model_dump(), "scene_id": str(body.scene_id)},
        status="pending",
    )
    db.add(task)
    await db.flush()
    await db.refresh(task)

    celery_task = generate_video_task.delay(str(task.id), body.model_dump())
    task.meta = {"celery_task_id": celery_task.id}
    await db.commit()

    return task


@router.post("/generate/batch-video")
async def batch_generate_videos(
    body: BatchVideoGenerationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    批量视频生成

    特性:
    - 并发控制(避免同时生成过多任务)
    - 按序执行或乱序执行
    - 失败自动重试
    - 进度汇总
    """
    # 模型可用性检查
    from app.services.creation_service import _ensure_model_available
    await _ensure_model_available(db, "image_to_video")

    from app.adapters.factory import resolve_actual_model_id
    actual_model = body.model or await resolve_actual_model_id("image_to_video", None, db) or "auto"

    tasks = []

    for scene_id in body.scene_ids:
        task = GenerationTask(
            project_id=body.project_id,
            scene_id=scene_id,
            user_id=current_user.id,
            type="video",
            model=actual_model,
            input_data={
                "scene_id": str(scene_id),
                "model": actual_model,
                "parallel": body.parallel,
            },
            status="pending",
        )
        db.add(task)
        await db.flush()
        tasks.append(task)

    await db.commit()

    # 批量提交Celery任务
    from app.tasks.video_gen import batch_generate_videos_task

    batch_celery_task = batch_generate_videos_task.delay(
        [str(t.id) for t in tasks],
        body.model_dump(),
    )

    return {
        "message": f"Submitted {len(tasks)} video generation tasks",
        "task_ids": [str(t.id) for t in tasks],
        "batch_task_id": batch_celery_task.id,
    }


@router.post("/generate/batch-full")
async def full_auto_generation(
    body: FullAutoGenerationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    一键全流程自动化生成

    完整流程:
    1. 检查缺失的图片资源 → 自动生成
    2. 为每个分镜生成视频
    3. 可选: 自动添加字幕
    4. 合并最终视频

    这是ComfyUI工作流集成的理想场景
    """
    from app.services.video_pipeline import VideoPipelineService

    pipeline = VideoPipelineService(db)
    result = await pipeline.run_full_pipeline(body.project_id, body.options or {})

    return result


@router.post("/generate/subtitle")
async def generate_subtitle(
    body: SubtitleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """为视频生成字幕(使用Whisper等ASR模型)"""
    from app.tasks.subtitle import generate_subtitle_task
    from app.adapters.factory import resolve_actual_model_id
    actual_model = await resolve_actual_model_id("subtitle", None, db) or "whisper"

    task = GenerationTask(
        user_id=current_user.id,
        type="subtitle",
        model=actual_model,
        input_data=body.model_dump(),
        status="pending",
    )
    db.add(task)
    await db.flush()
    await db.refresh(task)

    celery_task = generate_subtitle_task.delay(str(task.id), body.model_dump())
    task.meta = {"celery_task_id": celery_task.id}
    await db.commit()

    return task


@router.post("/generate/remove-subtitle")
async def remove_subtitle(
    body: SubtitleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """去除视频中的字幕(使用视频修复模型)"""
    # TODO: 实现
    pass
