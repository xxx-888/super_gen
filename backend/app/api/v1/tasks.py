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
        "meta": task.meta,
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

    # 通过 scene_id 关联（单镜生成场景）
    scene_id_raw = in_data.get("scene_id") if isinstance(in_data, dict) else None
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

    return d


@router.get("", response_model=List[GenerationTaskResponse])
async def get_tasks(
    project_id: Optional[UUID] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取任务列表（含关联的剧本/集数/分镜/提示词）"""
    stmt = select(GenerationTask)

    if project_id is not None:
        stmt = stmt.where(GenerationTask.project_id == project_id)
    if status is not None:
        stmt = stmt.where(GenerationTask.status == status)

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
    """删除任务记录（已完成的生成任务也可删除，清理历史）"""
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise NotFoundException("Task not found")

    await db.delete(task)
    await db.commit()
    return {"message": "Task deleted", "task_id": str(task_id)}


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
    return logs


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

@router.post("/generate/image", response_model=GenerationTaskResponse)
async def generate_image(
    body: ImageGenerationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    单张图片生成

    流程:
    1. 创建任务记录
    2. 发送Celery异步任务
    3. 返回任务ID(前端通过WebSocket或轮询获取进度)
    """
    # 模型可用性检查
    from app.services.creation_service import _ensure_model_available
    await _ensure_model_available(db, "image")

    from app.tasks.image_gen import generate_image_task

    task = GenerationTask(
        project_id=None,  # 独立图片生成可能不关联项目
        type="image",
        model=body.model,
        input_data=body.model_dump(),
        status="pending",
    )
    db.add(task)
    await db.flush()
    await db.refresh(task)

    # 提交到Celery队列
    celery_task = generate_image_task.delay(str(task.id), body.model_dump())

    # 可以存储celery_task_id用于后续查询
    task.meta = {"celery_task_id": celery_task.id}
    await db.commit()

    return task


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

    task = GenerationTask(
        type="video",
        model=body.model,
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

    tasks = []

    for scene_id in body.scene_ids:
        task = GenerationTask(
            project_id=body.project_id,
            type="video",
            model=body.model,
            input_data={
                "scene_id": str(scene_id),
                "model": body.model,
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

    task = GenerationTask(
        type="subtitle",
        model="whisper",  # 或其他ASR模型
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
