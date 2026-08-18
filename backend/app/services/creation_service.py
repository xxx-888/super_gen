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
from app.adapters.base import GenInput, GenElement, GenResult, append_logs
from app.adapters.factory import get_adapter_for_task_type, _find_model_config_from_db, resolve_model_info
from app.services.credit_service import consume as consume_credits, refund as refund_credits
from app.services import pricing_service

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

    轮询超时优先级（从高到低）：
      1. 模型 config 显式配置的 max_poll_seconds（针对单个模型）
      2. 后台「系统设置」的 task_poll_timeout_seconds（全局默认，默认 600 秒）
    轮询间隔 poll_interval 默认 5 秒，可被模型 config 覆盖。
    成功后下载视频、回写 Scene。
    """
    import asyncio
    from datetime import datetime, timezone
    from app.core.database import AsyncSessionLocal
    from app.models import GenerationTask, Scene
    from sqlalchemy.orm.attributes import flag_modified

    # 轮询参数：模型 config 显式配置优先；否则用后台「系统设置」的全局默认
    # （task_poll_timeout_seconds，默认 600 秒）。适配器自身的默认值不再参与运行时决策，
    # 避免 MiniMax 300 秒这类偏小的默认值把正常生成中的任务误判超时。
    adapter = None
    if model_config:
        from app.adapters.factory import get_adapter
        adapter = get_adapter(model_config)

    # 读取后台全局默认超时（带 30 秒缓存）。后台任务没有请求级 db，这里单独开一个 session。
    from app.services.settings_service import get_task_poll_timeout
    async with AsyncSessionLocal() as _settings_db:
        max_poll_seconds = await get_task_poll_timeout(_settings_db)
    poll_interval = 5
    if model_config:
        cfg_inner = model_config.get("config", {}) if isinstance(model_config.get("config"), dict) else {}
        if cfg_inner.get("poll_interval"):
            try:
                poll_interval = max(1, int(cfg_inner["poll_interval"]))
            except (TypeError, ValueError):
                pass
        # 模型 config 显式配置的 max_poll_seconds 优先级最高（单个模型可单独调）
        if cfg_inner.get("max_poll_seconds"):
            try:
                max_poll_seconds = max(60, int(cfg_inner["max_poll_seconds"]))
            except (TypeError, ValueError):
                pass
    max_polls = max(1, max_poll_seconds // poll_interval)
    logger.info(
        f"[AsyncPoll] Start polling {adapter_name} task {remote_task_id} "
        f"(db_task={task_id_str}, interval={poll_interval}s, timeout={max_polls * poll_interval}s)"
    )

    for attempt in range(max_polls):
        await asyncio.sleep(poll_interval)
        try:
            async with AsyncSessionLocal() as db:
                # 检查任务是否已被取消
                t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id_str))
                task = t.scalar_one_or_none()
                if task and task.status == "cancelled":
                    logger.info(f"[AsyncPoll] Task {task_id_str} cancelled, stop polling")
                    # 兜底:取消时恢复分镜状态(cancel 端点已回写一次,这里覆盖
                    # 其他把任务标成 cancelled 的路径,以及两处写入的竞态)
                    if scene_id:
                        try:
                            sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
                            sc = sc_t.scalar_one_or_none()
                            if sc and sc.status == "generating":
                                sc.status = "failed"
                                await db.commit()
                        except Exception as ce:
                            logger.warning(f"[AsyncPoll] 取消回写分镜状态失败: {ce}")
                    return

                # 轮询适配器
                if adapter and hasattr(adapter, "poll_result"):
                    result = await adapter.poll_result(remote_task_id)
                else:
                    logger.warning(f"[AsyncPoll] Adapter {adapter_name} has no poll_result method")
                    return

                # 把适配器产出的日志累积进 task.meta.logs
                def _merge_logs(base_meta: Optional[Dict[str, Any]]):
                    """把 result.meta.logs 累积进 base_meta.logs，返回新 dict。"""
                    new_meta = dict(base_meta or {})
                    existing = list(new_meta.get("logs") or [])
                    incoming = (result.meta or {}).get("logs") or []
                    existing.extend(incoming)
                    new_meta["logs"] = existing
                    return new_meta

                if result.meta.get("poll_pending"):
                    # 还在处理，更新进度；若有日志（如轮询异常）也累积进去
                    if task:
                        task.progress = min(90, 20 + attempt * 1)
                        if (result.meta or {}).get("logs"):
                            task.meta = _merge_logs(task.meta)
                            flag_modified(task, "meta")
                        await db.commit()
                    continue

                # 完成（成功或失败）
                if result.success:
                    if task:
                        task.status = "completed"
                        task.progress = 100
                        task.completed_at = datetime.now(timezone.utc)
                        task.output_urls = result.urls
                        merged = _merge_logs({**(task.meta or {}), "result_meta": result.meta})
                        merged = append_logs(merged, "info", "scene_writeback",
                                             f"异步轮询完成，任务标记 completed，输出 {len(result.urls or [])} 个文件")
                        task.meta = merged
                        flag_modified(task, "meta")
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
                        merged = _merge_logs(task.meta)
                        merged = append_logs(merged, "error", "scene_writeback",
                                             f"异步任务失败: {result.error[:200] if result.error else 'unknown'}")
                        task.meta = merged
                        flag_modified(task, "meta")
                    if scene_id:
                        sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
                        sc = sc_t.scalar_one_or_none()
                        if sc:
                            sc.status = "failed"
                    await db.commit()
                    # 退还积分
                    await refund_credits(db, org_id, task.credits_consumed if task else 0,
                                         user_id=user_id, model=(task.model if task else "auto"),
                                         task_id=(task.id if task else None),
                                         remark=f"异步任务失败退还: {remote_task_id}")
                    logger.warning(f"[AsyncPoll] Task {task_id_str} failed: {result.error}")
                return

        except Exception as e:
            logger.warning(f"[AsyncPoll] Poll {task_id_str} attempt {attempt+1} error: {e}")
            continue

    # 超时：与失败路径一致——回写 Scene.status=failed + 退积分 + 记日志
    try:
        async with AsyncSessionLocal() as db:
            t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id_str))
            task = t.scalar_one_or_none()
            if task and task.status == "processing":
                timeout_secs = max_polls * poll_interval
                task.status = "failed"
                task.error_message = f"轮询超时（{timeout_secs}秒）"
                task.completed_at = datetime.now(timezone.utc)
                task.meta = append_logs(task.meta, "error", "scene_writeback",
                                        f"轮询超时（{timeout_secs}秒），任务标记失败")
                flag_modified(task, "meta")
                # 回写 Scene 失败状态（修复 bug：原超时路径漏了 Scene 回写）
                if scene_id is not None:
                    sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
                    sc = sc_t.scalar_one_or_none()
                    if sc is not None:
                        sc.status = "failed"
                        flag_modified(sc, "meta")
                await db.commit()
                # 退还积分（修复 bug：原超时路径漏了退积分）
                await refund_credits(db, org_id, task.credits_consumed,
                                     user_id=user_id, model=(task.model if task else "auto"),
                                     task_id=(task.id if task else None),
                                     remark=f"异步任务超时退还: {remote_task_id}")
                logger.warning(f"[AsyncPoll] Task {task_id_str} poll timeout, scene {scene_id} -> failed")
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
    async_submit: bool = False,
) -> Dict[str, Any]:
    """提交创作任务.

    async_submit=False（默认）：同步执行（扣积分→建任务→调适配器→写结果），阻塞等待。
    async_submit=True：创建任务后立即返回 task_id，适配器在后台异步执行。
                      前端用 GET /tasks/{task_id} 轮询结果。

    若传入 scene_id，生成成功后会回写 Scene。
    """
    if task_type not in TASK_SPECS:
        raise BadRequestException(f"Unsupported creation type: {task_type}")

    # 模型可用性检查：视频生成类任务必须有真实模型配置，否则拒绝创建任务
    # （避免静默用 PlaceholderAdapter 产出占位内容，浪费用户积分）
    if model_config is None:
        await _ensure_model_available(db, task_type)

    spec = TASK_SPECS[task_type]
    inp = _build_input(task_type, params)

    # 解析真实模型 + 其 AIModel.id（一次查库，供按模型计价 & 记录真实模型复用）
    model_info = await resolve_model_info(task_type, model_config, db)
    actual_model = model_info["model"] or model

    # 计价：先查 credit_pricing 规则（按模型/分辨率/尺寸），无命中回退 _get_cost 兜底
    cost = await pricing_service.resolve_cost(db, task_type, model_id=model_info["id"], params=params)
    if cost is None:
        cost = _get_cost(task_type, params)
    cost = cost * int(params.get("count", 1) or 1)

    # 1. 扣积分
    tx = await consume_credits(
        db, org_id, cost, user_id=user_id, project_id=project_id,
        model=actual_model, remark=f"创作任务: {task_type}",
    )

    # 2. 建任务记录（scene_id 存入 input_data，便于后续关联查询）
    input_data = {**params, "task_type": task_type}
    if scene_id is not None:
        input_data["scene_id"] = str(scene_id)
    # 任务类型归一化：视频生成类(image_to_video/first_last_frame)记为 "video"，
    # 图片生成类(image/image_edit/fusion)记为 "image"，音频类记为 "audio"。
    # fusion 是图片生成链路（文生图/融合生图/图生图都走 /creation/fusion）；
    # 纯视频模型的 fusion→视频降级在 API 层已把 task_type 改为 image_to_video。
    _VIDEO_TASK_TYPES = {"image_to_video", "first_last_frame", "video"}
    _IMAGE_TASK_TYPES = {"image", "image_edit", "fusion"}
    if task_type in _VIDEO_TASK_TYPES:
        db_type = "video"
    elif task_type in _IMAGE_TASK_TYPES:
        db_type = "image"
    elif task_type in ("tts", "lip_sync"):
        db_type = "audio"
    else:
        db_type = "image"
    # 关联分镜落列；episode_id 未传时从分镜回填（任务队列/视频预览可按 剧本/集/分镜 追溯）
    task_episode_id = episode_id
    if scene_id is not None and task_episode_id is None:
        from app.models import Scene as _SceneModel
        _sc = (await db.execute(select(_SceneModel).where(_SceneModel.id == scene_id))).scalar_one_or_none()
        if _sc is not None:
            task_episode_id = _sc.episode_id

    task = GenerationTask(
        project_id=project_id, episode_id=task_episode_id,
        scene_id=scene_id,
        user_id=user_id,
        type=db_type,
        model=actual_model,
        input_data=input_data,
        status="processing", progress=10,
        credits_consumed=cost,
        started_at=datetime.now(timezone.utc),
        meta={"org_tx_id": str(getattr(tx, "id", uuid4()))},
    )
    db.add(task)
    await db.flush()
    task_id = task.id
    # 把扣费流水挂到本任务（consume 发生在建任务前，此处回写 task_id）
    if tx is not None and getattr(tx, "id", None) is not None and tx.task_id is None:
        tx.task_id = task_id
        await db.flush()

    # 标记 Scene 为"生成中"（让其他用户/页面看到该分镜正在生成，避免重复提交）
    if scene_id is not None:
        from app.models import Scene as _Scene
        sc_pre = await db.execute(select(_Scene).where(_Scene.id == scene_id))
        sc_obj = sc_pre.scalar_one_or_none()
        if sc_obj:
            sc_obj.status = "generating"
    await db.flush()

    # 异步提交模式：创建 task 后立即返回 task_id，适配器在后台执行
    if async_submit:
        await db.commit()
        from app.core.background import spawn_background
        spawn_background(_async_run_adapter(
            str(task_id), task_type, params, model, model_config,
            org_id, user_id, scene_id,
        ))
        return {
            "task_id": str(task_id),
            "status": "processing",
            "urls": [],
            "credits_consumed": cost,
        }

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
            # 更新任务记录为 processing + 存 remote_task_id + 累积提交日志
            t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
            task = t.scalar_one()
            task.status = "processing"
            task.progress = 20
            from sqlalchemy.orm.attributes import flag_modified as _flag
            submit_meta = {**(task.meta or {}), "remote_task_id": remote_task_id,
                           "adapter": result.meta.get("adapter", "unknown")}
            # 累积适配器提交阶段产出的日志
            incoming_logs = (result.meta or {}).get("logs") or []
            if incoming_logs:
                submit_meta["logs"] = list((task.meta or {}).get("logs") or []) + incoming_logs
                _flag(task, "meta")
            task.meta = submit_meta
            await db.commit()

            # 启动后台轮询（独立 DB session）
            from app.core.background import spawn_background
            spawn_background(_async_poll_adapter(
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

        # 4. 写回结果（累积适配器日志）
        t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        task = t.scalar_one()
        task.status = "completed"
        task.progress = 100
        task.completed_at = datetime.now(timezone.utc)
        task.output_urls = result.urls
        done_meta = {**(task.meta or {}), "result_meta": result.meta,
                     "adapter": result.meta.get("adapter", "unknown")}
        # 累积适配器产出的日志
        incoming_logs = (result.meta or {}).get("logs") or []
        if incoming_logs:
            done_meta["logs"] = list((task.meta or {}).get("logs") or []) + incoming_logs
        task.meta = append_logs(done_meta, "info", "scene_writeback",
                                f"同步任务完成，输出 {len(result.urls or [])} 个文件")
        from sqlalchemy.orm.attributes import flag_modified as _flag_done
        _flag_done(task, "meta")
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
        task.meta = append_logs(task.meta, "error", "scene_writeback",
                                f"同步任务失败: {str(e)[:200]}")
        from sqlalchemy.orm.attributes import flag_modified as _flag_fail
        _flag_fail(task, "meta")
        # 回写 Scene 失败状态
        if scene_id is not None:
            from app.models import Scene
            sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
            sc = sc_t.scalar_one_or_none()
            if sc is not None:
                sc.status = "failed"
        await db.flush()
        # 退还积分
        await refund_credits(db, org_id, cost, user_id=user_id, model=actual_model,
                             task_id=task_id,
                             remark=f"任务失败退还: {task_type}")
        raise


async def _async_run_adapter(
    task_id_str: str, task_type: str, params: Dict[str, Any],
    model: str, model_config: Optional[Dict[str, Any]],
    org_id: UUID, user_id: UUID, scene_id: Optional[UUID],
):
    """后台异步执行适配器（async_submit 模式用）。

    用独立的 DB session，执行适配器调用 + 写回结果。
    前端通过 GET /tasks/{task_id} 轮询状态。
    """
    from app.core.database import AsyncSessionLocal
    from uuid import UUID as _UUID
    task_id = _UUID(task_id_str)
    cost = _get_cost(task_type, params) * int(params.get("count", 1) or 1)
    try:
        async with AsyncSessionLocal() as db:
            spec = TASK_SPECS[task_type]
            inp = _build_input(task_type, params)
            adapter = await get_adapter_for_task_type(task_type, model_config, db=db)
            method = getattr(adapter, spec["method"])
            result: GenResult = await method(inp)

            if not result.success:
                raise Exception(f"Adapter error: {result.error}")

            # 异步轮询模式（MiniMax 等）
            if result.meta.get("async_poll") and result.meta.get("remote_task_id"):
                remote_task_id = result.meta["remote_task_id"]
                t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
                task = t.scalar_one()
                task.meta = {**(task.meta or {}), "remote_task_id": remote_task_id}
                await db.commit()
                await _async_poll_adapter(
                    task_id_str, remote_task_id, result.meta.get("adapter", "unknown"),
                    model_config, org_id, user_id, scene_id,
                )
                return

            # 同步完成：写回结果
            t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
            task = t.scalar_one()
            task.status = "completed"
            task.progress = 100
            task.completed_at = datetime.now(timezone.utc)
            task.output_urls = result.urls
            task.meta = {**(task.meta or {}), "adapter": result.meta.get("adapter", "unknown")}
            # 回写 Scene
            if scene_id is not None:
                from app.models import Scene
                sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
                sc = sc_t.scalar_one_or_none()
                if sc is not None:
                    sc.status = "completed"
                    sc.generated_video_url = result.urls[0] if result.urls else None
                    sc.thumbnail_url = result.urls[0] if result.urls else None
            await db.commit()
            logger.info(f"Async creation task {task_id} completed: {len(result.urls)} outputs")

    except Exception as e:
        logger.error(f"Async creation task {task_id} failed: {e}")
        try:
            async with AsyncSessionLocal() as db:
                t = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
                task = t.scalar_one()
                task.status = "failed"
                task.error_message = str(e)[:500]
                task.completed_at = datetime.now(timezone.utc)
                if scene_id is not None:
                    from app.models import Scene
                    sc_t = await db.execute(select(Scene).where(Scene.id == scene_id))
                    sc = sc_t.scalar_one_or_none()
                    if sc is not None:
                        sc.status = "failed"
                await refund_credits(db, org_id, cost, user_id=user_id, model=model,
                                    task_id=task_id,
                                    remark=f"异步任务失败退还: {task_type}")
                await db.commit()
        except Exception as e2:
            logger.error(f"Failed to write error status for task {task_id}: {e2}")
