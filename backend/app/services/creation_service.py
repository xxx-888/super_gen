"""
Creation Service - AI 创作工作流业务逻辑 (M5)

统一编排各类生成任务:
1. 构建 GenInput
2. 扣减积分(预估)
3. 创建 GenerationTask
4. 调用适配器(同步执行; 后续可改 Celery 异步)
5. 写回结果; 失败退还积分

对标目标网站创作面板: 融合生图/图生视频/首尾帧/对口型/TTS/图片改创.
"""
import logging
from uuid import UUID, uuid4
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import BadRequestException, GenerationFailedException
from app.models import GenerationTask, AIModel
from app.adapters.base import GenInput, GenElement, GenResult
from app.adapters.factory import get_adapter_for_task_type, _find_model_config_from_db
from app.services.credit_service import consume as consume_credits, refund as refund_credits

logger = logging.getLogger(__name__)


# 任务类型 -> 积分单价 + 适配器能力方法名
TASK_SPECS = {
    "fusion":        {"cost_key": "CREDITS_COST_TEXT_TO_IMAGE",  "method": "fusion_generate"},
    "image":         {"cost_key": "CREDITS_COST_TEXT_TO_IMAGE",  "method": "text_to_image"},
    "image_to_video":{"cost_key": "CREDITS_COST_IMAGE_TO_VIDEO", "method": "image_to_video"},
    "first_last_frame": {"cost_key": "CREDITS_COST_IMAGE_TO_VIDEO", "method": "first_last_frame_video"},
    "lip_sync":      {"cost_key": "CREDITS_COST_LIP_SYNC",       "method": "lip_sync"},
    "tts":           {"cost_key": "CREDITS_COST_TTS",            "method": "tts"},
    "image_edit":    {"cost_key": "CREDITS_COST_TEXT_TO_IMAGE",  "method": "image_edit"},
}


def _get_cost(task_type: str, params: Optional[Dict[str, Any]] = None) -> int:
    """计算单次任务积分成本。

    视频任务按分辨率+时长计费：
    - 768P：1 积分/秒
    - 2K：2 积分/秒
    图片任务固定 1 积分/张。
    """
    spec = TASK_SPECS.get(task_type)
    if not spec:
        raise BadRequestException(f"Unknown task type: {task_type}")
    base_cost = getattr(settings, spec["cost_key"], 1)

    # 视频类任务按分辨率+时长精细计费
    if params and task_type in ("image_to_video", "first_last_frame", "fusion"):
        resolution = params.get("resolution", "768P")
        duration = int(params.get("duration", 5) or 5)
        if resolution in ("2K", "2k", "1080p", "1080P"):
            return duration * 2  # 2K: 2积分/秒
        else:
            return duration * 1  # 768P/720p: 1积分/秒

    return base_cost


def _build_input(task_type: str, params: Dict[str, Any]) -> GenInput:
    """从请求参数构建 GenInput."""
    elements = [GenElement(**e) for e in (params.get("elements") or [])]
    # 把文生图相关参数（quality/watermark_enabled/resolution）收进 extra，供适配器读取
    extra = dict(params.get("extra") or {})
    for k in ("quality", "watermark_enabled", "resolution"):
        if k in params and k not in extra:
            extra[k] = params[k]
    return GenInput(
        prompt=params.get("prompt", ""),
        elements=elements,
        size=params.get("size", "16:9"),
        count=int(params.get("count", 1)),
        image_url=params.get("image_url"),
        first_frame_url=params.get("first_frame_url"),
        last_frame_url=params.get("last_frame_url"),
        video_url=params.get("video_url"),
        audio_url=params.get("audio_url"),
        text=params.get("text"),
        voice_id=params.get("voice_id"),
        duration=params.get("duration"),
        extra=extra,
    )


async def _ensure_model_available(db: "AsyncSession", task_type: str) -> None:
    """检查后台是否为该任务类型配置了可用的 AI 模型。

    未配置时抛 BadRequestException，阻止任务创建（避免用 Placeholder 浪费积分）。
    检查逻辑与 get_adapter_for_task_type 一致：先查 DB 的 AIModel 表，再查环境变量。
    """
    from app.core.config import settings
    # DB 查询：按 task_type 映射到 AIModel.type
    mc = await _find_model_config_from_db(task_type, db)
    if mc is not None:
        # 有 DB 配置，且 provider 不是占位
        provider = mc.get("provider", "")
        if provider and provider not in ("placeholder",):
            return
    # 环境变量兜底（智谱）
    if getattr(settings, "LLM_API_KEY", None) and getattr(settings, "LLM_PROVIDER", "") == "zhipu":
        return
    # 无任何可用模型
    type_label = {
        "image_to_video": "图生视频",
        "first_last_frame": "首尾帧生成",
        "fusion": "融合生成",
        "image": "文生图",
        "image_edit": "图片改创",
    }.get(task_type, task_type)
    raise BadRequestException(
        f"未配置「{type_label}」的 AI 模型，无法生成。请在「后台管理 → 配置模型」"
        f"添加对应 type 的记录并启用后重试。"
    )


async def _async_poll_adapter(
    task_id_str: str,
    remote_task_id: str,
    adapter_name: str,
    model_config: Optional[Dict[str, Any]],
    org_id: UUID,
    user_id: UUID,
    scene_id: Optional[UUID],
) -> None:
    """后台轮询适配器的异步任务结果（如 MiniMax H3），完成后写回 DB。

    每 5 秒查询一次，最多 6 分钟（72 次）。成功后下载视频、回写 Scene。
    """
    import asyncio
    from datetime import datetime, timezone
    from app.core.database import AsyncSessionLocal
    from app.models import GenerationTask, Scene
    from sqlalchemy.orm.attributes import flag_modified

    poll_interval = 5
    max_polls = 72  # 6 分钟
    logger.info(f"[AsyncPoll] Start polling {adapter_name} task {remote_task_id} (db_task={task_id_str})")

    # 获取适配器实例（从 model_config 重建）
    adapter = None
    if model_config:
        from app.adapters.factory import get_adapter
        adapter = get_adapter(model_config)

    for attempt in range(max_polls):
        await asyncio.sleep(poll_interval)
        try:
            async with AsyncSessionLocal() as db:
                # 检查任务是否已被取消
                t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id_str))
                task = t.scalar_one_or_none()
                if task and task.status == "cancelled":
                    logger.info(f"[AsyncPoll] Task {task_id_str} cancelled, stop polling")
                    return

                # 轮询适配器
                if adapter and hasattr(adapter, "poll_result"):
                    result = await adapter.poll_result(remote_task_id)
                else:
                    logger.warning(f"[AsyncPoll] Adapter {adapter_name} has no poll_result method")
                    return

                if result.meta.get("poll_pending"):
                    # 还在处理，更新进度
                    if task:
                        task.progress = min(90, 20 + attempt * 1)
                        await db.commit()
                    continue

                # 完成（成功或失败）
                if result.success:
                    if task:
                        task.status = "completed"
                        task.progress = 100
                        task.completed_at = datetime.now(timezone.utc)
                        task.output_urls = result.urls
                        task.meta = {**(task.meta or {}), "result_meta": result.meta}
                    # 回写 Scene
                    if scene_id and result.urls:
                        sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
                        sc = sc_t.scalar_one_or_none()
                        if sc:
                            sc.status = "completed"
                            sc.generated_video_url = result.urls[0]
                            sc.thumbnail_url = result.urls[0]
                            sc_meta = dict(sc.meta or {})
                            sc_meta["last_generation"] = {
                                "task_id": task_id_str, "remote_task_id": remote_task_id,
                                "generated_at": datetime.now(timezone.utc).isoformat(),
                            }
                            sc.meta = sc_meta
                            flag_modified(sc, "meta")
                    await db.commit()
                    logger.info(f"[AsyncPoll] Task {task_id_str} completed: {result.urls}")
                else:
                    if task:
                        task.status = "failed"
                        task.error_message = result.error[:500] if result.error else "unknown"
                        task.completed_at = datetime.now(timezone.utc)
                    if scene_id:
                        sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
                        sc = sc_t.scalar_one_or_none()
                        if sc:
                            sc.status = "failed"
                    await db.commit()
                    # 退还积分
                    await refund_credits(db, org_id, task.credits_consumed if task else 0,
                                         user_id=user_id, model="auto",
                                         remark=f"异步任务失败退还: {remote_task_id}")
                    logger.warning(f"[AsyncPoll] Task {task_id_str} failed: {result.error}")
                return

        except Exception as e:
            logger.warning(f"[AsyncPoll] Poll {task_id_str} attempt {attempt+1} error: {e}")
            continue

    # 超时
    try:
        async with AsyncSessionLocal() as db:
            t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id_str))
            task = t.scalar_one_or_none()
            if task and task.status == "processing":
                task.status = "failed"
                task.error_message = f"轮询超时（{max_polls * poll_interval}秒）"
                task.completed_at = datetime.now(timezone.utc)
                await db.commit()
                logger.warning(f"[AsyncPoll] Task {task_id_str} poll timeout")
    except Exception as e:
        logger.error(f"[AsyncPoll] Timeout writeback error: {e}")


async def submit_creation(
    db: AsyncSession,
    org_id: UUID,
    user_id: UUID,
    task_type: str,
    params: Dict[str, Any],
    project_id: Optional[UUID] = None,
    episode_id: Optional[UUID] = None,
    model: str = "auto",
    model_config: Optional[Dict[str, Any]] = None,
    scene_id: Optional[UUID] = None,
) -> Dict[str, Any]:
    """提交创作任务(同步执行: 扣积分 -> 建任务 -> 调适配器 -> 写结果).

    若传入 scene_id，生成成功后会回写 Scene（generated_video_url/thumbnail_url/status）。
    返回任务摘要(含输出URL).
    """
    if task_type not in TASK_SPECS:
        raise BadRequestException(f"Unsupported creation type: {task_type}")

    # 模型可用性检查：视频生成类任务必须有真实模型配置，否则拒绝创建任务
    # （避免静默用 PlaceholderAdapter 产出占位内容，浪费用户积分）
    if model_config is None:
        await _ensure_model_available(db, task_type)

    cost = _get_cost(task_type, params) * int(params.get("count", 1) or 1)
    spec = TASK_SPECS[task_type]
    inp = _build_input(task_type, params)

    # 1. 扣积分
    tx = await consume_credits(
        db, org_id, cost, user_id=user_id, project_id=project_id,
        model=model, remark=f"创作任务: {task_type}",
    )

    # 2. 建任务记录（scene_id 存入 input_data，便于后续关联查询）
    input_data = {**params, "task_type": task_type}
    if scene_id is not None:
        input_data["scene_id"] = str(scene_id)
    # 任务类型归一化：视频生成类(image_to_video/first_last_frame/fusion)统一记为 "video"，
    # 图片生成类(image/image_edit)记为 "image"，音频类记为 "audio"。
    # 这样前端素材区按 type 过滤时能正确区分图片/视频。
    _VIDEO_TASK_TYPES = {"image_to_video", "first_last_frame", "fusion", "video"}
    _IMAGE_TASK_TYPES = {"image", "image_edit"}
    if task_type in _VIDEO_TASK_TYPES:
        db_type = "video"
    elif task_type in _IMAGE_TASK_TYPES:
        db_type = "image"
    elif task_type in ("tts", "lip_sync"):
        db_type = "audio"
    else:
        db_type = "image"
    task = GenerationTask(
        project_id=project_id, episode_id=episode_id,
        type=db_type,
        model=model,
        input_data=input_data,
        status="processing", progress=10,
        credits_consumed=cost,
        started_at=datetime.now(timezone.utc),
        meta={"org_tx_id": str(getattr(tx, "id", uuid4()))},
    )
    db.add(task)
    await db.flush()
    task_id = task.id

    # 标记 Scene 为"生成中"（让其他用户/页面看到该分镜正在生成，避免重复提交）
    if scene_id is not None:
        from app.models import Scene as _Scene
        sc_pre = await db.execute(select(_Scene).where(_Scene.id == scene_id))
        sc_obj = sc_pre.scalar_one_or_none()
        if sc_obj:
            sc_obj.status = "generating"
    await db.flush()

    # 3. 调适配器
    try:
        adapter = await get_adapter_for_task_type(task_type, model_config, db)
        method = getattr(adapter, spec["method"])
        result: GenResult = await method(inp)

        if not result.success:
            raise GenerationFailedException(
                f"Adapter returned error: {result.error}", model=model
            )

        # 异步轮询模式：适配器只提交了任务（如 MiniMax），返回 remote_task_id
        # 立即返回 processing 状态，后台 asyncio.create_task 轮询结果
        if result.meta.get("async_poll") and result.meta.get("remote_task_id"):
            remote_task_id = result.meta["remote_task_id"]
            # 更新任务记录为 processing + 存 remote_task_id
            t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
            task = t.scalar_one()
            task.status = "processing"
            task.progress = 20
            task.meta = {**(task.meta or {}), "remote_task_id": remote_task_id,
                         "adapter": result.meta.get("adapter", "unknown")}
            await db.commit()

            # 启动后台轮询（独立 DB session）
            import asyncio
            asyncio.create_task(_async_poll_adapter(
                str(task_id), remote_task_id, result.meta.get("adapter", "unknown"),
                model_config, org_id, user_id, scene_id,
            ))

            return {
                "task_id": str(task_id),
                "status": "processing",
                "urls": [],
                "credits_consumed": task.credits_consumed,
                "remote_task_id": remote_task_id,
            }

        # 4. 写回结果
        t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        task = t.scalar_one()
        task.status = "completed"
        task.progress = 100
        task.completed_at = datetime.now(timezone.utc)
        task.output_urls = result.urls
        task.meta = {**(task.meta or {}), "result_meta": result.meta,
                     "adapter": result.meta.get("adapter", "unknown")}
        if result.credits_cost and result.credits_cost != cost:
            task.credits_consumed = result.credits_cost

        # 5. 回写 Scene（单镜生成场景）
        if scene_id is not None:
            from app.models import Scene
            from sqlalchemy.orm.attributes import flag_modified
            sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
            sc = sc_t.scalar_one_or_none()
            if sc is not None:
                sc.status = "completed"
                sc.generated_video_url = result.urls[0] if result.urls else None
                sc.thumbnail_url = result.urls[0] if result.urls else None
                # meta 记录本次生成参数（模型/模式/时间），便于详情展示
                sc_meta = dict(sc.meta or {})
                sc_meta["last_generation"] = {
                    "model": model,
                    "task_type": task_type,
                    "task_id": str(task_id),
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "params": {k: v for k, v in params.items() if k not in ("elements",)},
                }
                sc.meta = sc_meta
                flag_modified(sc, "meta")
        await db.flush()

        return {
            "task_id": str(task_id),
            "status": "completed",
            "urls": result.urls,
            "credits_consumed": task.credits_consumed,
        }

    except Exception as e:
        logger.error(f"Creation task {task_id} ({task_type}) failed: {e}")
        # 写失败
        t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        task = t.scalar_one()
        task.status = "failed"
        task.error_message = str(e)[:500]
        task.completed_at = datetime.now(timezone.utc)
        # 回写 Scene 失败状态
        if scene_id is not None:
            from app.models import Scene
            sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
            sc = sc_t.scalar_one_or_none()
            if sc is not None:
                sc.status = "failed"
        await db.flush()
        # 退还积分
        await refund_credits(db, org_id, cost, user_id=user_id, model=model,
                             remark=f"任务失败退还: {task_type}")
        raise
