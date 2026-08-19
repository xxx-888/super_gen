"""
Episode Service - 集(片段)管理业务逻辑 (M4)

职责:
- Episode CRUD + 排序 + 状态机流转
- 一键成片: 编排整集生成流水线(创建 GenerationTask, 扣积分, 推进状态)
- 智能审片 / 此步后停止 辅助开关
"""
from uuid import UUID
from typing import Optional, List, Dict, Any
from sqlalchemy import select, func, and_, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    NotFoundException, BadRequestException, ForbiddenException,
)
from app.models import (
    Episode, Scene, GenerationTask, Project, Script, Work, SceneAsset,
    EPISODE_STATUS_ASSET, EPISODE_STATUS_PENDING_SUBMIT,
    EPISODE_STATUS_VIDEO_EDITING, EPISODE_STATUS_COMPLETED, EPISODE_STATUSES,
)
from app.services.credit_service import consume as consume_credits


# 状态流转图: 每个状态允许的下一状态
_STATUS_TRANSITIONS = {
    EPISODE_STATUS_ASSET: [EPISODE_STATUS_PENDING_SUBMIT],
    EPISODE_STATUS_PENDING_SUBMIT: [EPISODE_STATUS_VIDEO_EDITING, EPISODE_STATUS_ASSET],
    EPISODE_STATUS_VIDEO_EDITING: [EPISODE_STATUS_COMPLETED, EPISODE_STATUS_PENDING_SUBMIT],
    EPISODE_STATUS_COMPLETED: [EPISODE_STATUS_VIDEO_EDITING],  # 可回退重新编辑
}


# ==================== CRUD ====================

async def list_episodes(
    db: AsyncSession, project_id: UUID,
    status: Optional[str] = None, search: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """集列表(含分镜数/任务进度统计)."""
    stmt = select(Episode).where(Episode.project_id == project_id)
    if status:
        stmt = stmt.where(Episode.status == status)
    if search:
        stmt = stmt.where(Episode.title.ilike(f"%{search}%"))
    stmt = stmt.order_by(Episode.sort_order.asc(), Episode.number.desc())
    result = await db.execute(stmt)
    episodes = result.scalars().all()

    out = []
    for ep in episodes:
        # 统计分镜数与完成数
        scene_count = await db.execute(
            select(func.count(Scene.id)).where(Scene.episode_id == ep.id)
        )
        completed_count = await db.execute(
            select(func.count(Scene.id)).where(
                Scene.episode_id == ep.id, Scene.status == "completed"
            )
        )
        out.append(_to_dict(ep, scene_count.scalar() or 0, completed_count.scalar() or 0))
    return out


async def get_episode(db: AsyncSession, project_id: UUID, episode_id: UUID) -> Episode:
    r = await db.execute(
        select(Episode).where(Episode.id == episode_id, Episode.project_id == project_id)
    )
    ep = r.scalar_one_or_none()
    if ep is None:
        raise NotFoundException("Episode not found", resource="Episode")
    return ep


async def create_episode(
    db: AsyncSession, project_id: UUID,
    number: Optional[int] = None,
    title: Optional[str] = None,
    script_id: Optional[UUID] = None,
) -> Episode:
    """新建集. number 自动递增(若未指定)."""
    if number is None:
        r = await db.execute(
            select(func.max(Episode.number)).where(Episode.project_id == project_id)
        )
        number = (r.scalar() or 0) + 1
    if title is None:
        title = f"第{number}集"

    # 校验集号唯一
    exist = await db.execute(
        select(Episode).where(Episode.project_id == project_id, Episode.number == number)
    )
    if exist.scalar_one_or_none():
        raise BadRequestException(f"Episode number {number} already exists")

    # sort_order 默认按 number 倒序(最新在前)
    ep = Episode(
        project_id=project_id, number=number, title=title,
        script_id=script_id, sort_order=number,
    )
    db.add(ep)
    await db.flush()
    await db.refresh(ep)  # 回填 server_default (created_at 等)
    return ep


async def update_episode(
    db: AsyncSession, project_id: UUID, episode_id: UUID,
    title: Optional[str] = None,
    cover_image_url: Optional[str] = None,
) -> Episode:
    ep = await get_episode(db, project_id, episode_id)
    if title is not None: ep.title = title
    if cover_image_url is not None: ep.cover_image_url = cover_image_url
    await db.flush()
    await db.refresh(ep)
    return ep


async def delete_episode(db: AsyncSession, project_id: UUID, episode_id: UUID) -> None:
    """删除集（片段），级联删除其分镜、生成任务、作品。

    用原生 DELETE 先删引用 episode 的子表（generation_tasks、works），
    再删 scenes 和 scene_assets，最后删 episode。
    ORM cascade 只处理 scenes→scene_assets，generation_tasks/works 无 cascade。
    """
    ep = await get_episode(db, project_id, episode_id)
    # 1. 删除该 episode 下所有 scene 的 scene_assets
    await db.execute(
        sa_delete(SceneAsset).where(SceneAsset.scene_id.in_(
            select(Scene.id).where(Scene.episode_id == episode_id)
        ))
    )
    # 2. 删除 scenes（属于该 episode 的分镜）
    await db.execute(sa_delete(Scene).where(Scene.episode_id == episode_id))
    # 3. 删除引用该 episode 的 generation_tasks 和 works（无 ORM cascade）
    await db.execute(sa_delete(GenerationTask).where(GenerationTask.episode_id == episode_id))
    await db.execute(sa_delete(Work).where(Work.episode_id == episode_id))
    # 4. 删除 episode 本身
    await db.execute(sa_delete(Episode).where(Episode.id == episode_id))
    await db.flush()


async def reorder_episodes(
    db: AsyncSession, project_id: UUID, episode_ids: List[UUID]
) -> None:
    """按给定顺序重排集."""
    for idx, eid in enumerate(episode_ids):
        r = await db.execute(
            select(Episode).where(Episode.id == eid, Episode.project_id == project_id)
        )
        ep = r.scalar_one_or_none()
        if ep:
            ep.sort_order = len(episode_ids) - idx  # 倒序权重
    await db.flush()


# ==================== 状态机 ====================

async def transition_status(
    db: AsyncSession, project_id: UUID, episode_id: UUID, new_status: str,
) -> Episode:
    """状态流转(校验合法性)."""
    if new_status not in EPISODE_STATUSES:
        raise BadRequestException(f"Invalid status: {new_status}")
    ep = await get_episode(db, project_id, episode_id)
    allowed = _STATUS_TRANSITIONS.get(ep.status, [])
    if new_status not in allowed and new_status != ep.status:
        raise BadRequestException(
            f"Cannot transition from '{ep.status}' to '{new_status}'. Allowed: {allowed}"
        )
    ep.status = new_status
    await db.flush()
    await db.refresh(ep)
    return ep


async def set_stop_after_step(
    db: AsyncSession, project_id: UUID, episode_id: UUID, value: bool
) -> Episode:
    ep = await get_episode(db, project_id, episode_id)
    ep.stop_after_step = value
    await db.flush()
    await db.refresh(ep)
    return ep


async def set_smart_review(
    db: AsyncSession, project_id: UUID, episode_id: UUID, value: bool
) -> Episode:
    ep = await get_episode(db, project_id, episode_id)
    ep.smart_review = value
    await db.flush()
    await db.refresh(ep)
    return ep


# ==================== 一键成片 ====================

async def one_click_render(
    db: AsyncSession, project_id: UUID, episode_id: UUID,
    org_id: UUID, user_id: UUID,
) -> Dict[str, Any]:
    """一键成片: 编排整集生成流水线.

    1. 校验集内分镜，无分镜时友好提示（不推进状态）
    2. 跳过已生成完成的分镜（有视频的不重复提交/扣费）；全都已生成时提示走合并成片
    3. 扣减积分（仅按待生成分镜预估）
    4. 为每个待生成分镜创建 GenerationTask 并调适配器：
       - 异步渠道（MiniMax 等提交即返回）→ 任务保持 processing 并转后台轮询，
         完成后由 _async_poll_adapter 下载视频并回写分镜
       - 同步渠道 → 直接写回结果
    5. 推进集状态 -> video_editing
    6. 返回任务清单 + 成功/失败统计
    """
    ep = await get_episode(db, project_id, episode_id)

    # 1. 获取集内分镜
    r = await db.execute(
        select(Scene).where(Scene.episode_id == episode_id).order_by(Scene.sequence.asc())
    )
    scenes = list(r.scalars().all())

    if not scenes:
        # 无分镜: 不推进状态，友好提示用户先创建分镜
        return {
            "episode_id": str(episode_id), "tasks": [], "credits_consumed": 0,
            "scene_count": 0, "completed": 0, "failed": 0, "failed_scenes": [],
            "message": "该集暂无分镜，请先用 Agent 向导或手动创建分镜",
        }

    # 2. 只处理未完成的分镜（已生成视频的跳过，避免重复提交/扣费）
    pending_scenes = [sc for sc in scenes if not (sc.status == "completed" and sc.generated_video_url)]
    if not pending_scenes:
        return {
            "episode_id": str(episode_id), "tasks": [], "credits_consumed": 0,
            "scene_count": len(scenes), "completed": 0, "failed": 0, "failed_scenes": [],
            "message": "全部分镜已生成视频，请点击一键成片合并为完整视频（或调用合并成片接口）",
        }

    # 2.5 防重复一键成片：正在生成中（有活跃任务）的分镜不重复提交。
    # 没有可生成分镜时直接返回提示 —— 生成期间反复点击不会重复扣费/重复提交；
    # 分镜视频更新（重新生成）后状态不再是 completed，才会再次进入生成流程
    in_flight: list = []
    truly_pending: list = []
    for sc in pending_scenes:
        if sc.status == "generating":
            active_r = await db.execute(
                select(GenerationTask.id).where(
                    GenerationTask.scene_id == sc.id,
                    GenerationTask.status.in_(["pending", "processing"]),
                ).limit(1)
            )
            if active_r.scalar_one_or_none() is not None:
                in_flight.append(sc)
                continue
            # 状态残留 generating 但已无活跃任务（服务重启等异常中断）→ 自愈为待生成
        truly_pending.append(sc)
    if not truly_pending:
        msg = (f"有 {len(in_flight)} 个分镜正在生成中，请等待完成后再操作"
               if in_flight else "没有需要生成的分镜")
        return {
            "episode_id": str(episode_id), "tasks": [], "credits_consumed": 0,
            "scene_count": len(scenes), "completed": 0,
            "processing": len(in_flight), "failed": 0, "failed_scenes": [],
            "message": msg,
        }
    pending_scenes = truly_pending

    # 3. 解析真实视频模型 + 按规则计价（视频按秒，仅待生成分镜）
    from app.adapters.factory import resolve_model_info, _find_model_config_from_db
    from app.services import pricing_service
    model_config = await _find_model_config_from_db("image_to_video", db)
    model_info = await resolve_model_info("image_to_video", model_config, db)
    actual_model = model_info["model"] or "image_to_video"

    scene_costs = []
    for sc in pending_scenes:
        c = await pricing_service.resolve_cost(
            db, "image_to_video", model_id=model_info["id"],
            params={"duration": sc.duration or 5},
        )
        if c is None:
            c = settings.CREDITS_COST_IMAGE_TO_VIDEO  # 无规则兜底
        scene_costs.append(c)
    total_cost = sum(scene_costs)

    # 4. 扣减积分
    tx = await consume_credits(
        db, org_id, total_cost, user_id=user_id,
        project_id=project_id, model=actual_model,
        remark=f"一键成片: 第{ep.number}集 ({len(pending_scenes)}个分镜)",
    )
    tx_id = getattr(tx, "id", None)

    # 5. 为每个待生成分镜创建任务并调适配器
    # 先检查模型是否已配置（未配置则拒绝，避免用 Placeholder 浪费积分）
    from app.services.creation_service import (
        _ensure_model_available, _async_poll_adapter, expand_scene_prompt_with_refs,
    )
    await _ensure_model_available(db, "image_to_video")

    from app.adapters.factory import get_adapter_for_task_type
    from app.adapters.base import GenInput
    from app.core.background import spawn_background
    from sqlalchemy.orm.attributes import flag_modified as _flag_meta
    from datetime import datetime, timezone

    tasks = []
    completed = 0
    failed = 0
    failed_scenes = []
    processing = 0
    adapter = await get_adapter_for_task_type("image_to_video", model_config)
    for idx, sc in enumerate(pending_scenes):
        sc.status = "generating"
        # 展开分镜提示词里的 @引用（芯片模板/裸名 → 标准展开）并收集引用资源媒体，
        # 与分镜单发生成链路完全一致 —— 原样发送 @{type:uuid:name} 模板给模型是无效引用
        inp_prompt, ref_elements = await expand_scene_prompt_with_refs(db, sc.id, sc.prompt or "")
        task = GenerationTask(
            project_id=project_id, episode_id=episode_id,
            scene_id=sc.id,
            user_id=user_id,
            type="video", model=actual_model,
            input_data={
                "scene_id": str(sc.id), "prompt": inp_prompt,
                "creation_mode": sc.creation_mode or "image_to_video",
            },
            status="processing", credits_consumed=scene_costs[idx],
            started_at=datetime.now(timezone.utc),
            meta={"org_tx_id": str(tx_id) if tx_id else None},
        )
        db.add(task)
        await db.flush()
        # 批量扣费流水挂到首个任务（同一笔扣费覆盖多任务，其余靠 meta.org_tx_id 关联）
        if tx is not None and getattr(tx, "id", None) is not None and tx.task_id is None:
            tx.task_id = task.id

        # 立即执行适配器
        try:
            inp = GenInput(prompt=inp_prompt, duration=sc.duration or 5.0, elements=ref_elements)
            result = await adapter.image_to_video(inp)
            adapter_name = result.meta.get("adapter", "unknown")
            if result.meta.get("async_poll") and result.meta.get("remote_task_id"):
                # 异步渠道（MiniMax 等）：已提交远端，任务保持 processing 并转
                # 后台轮询；完成后 _async_poll_adapter 下载视频并回写分镜。
                # 之前把异步提交当同步结果处理（秒标 completed、urls 空、分镜
                # 无视频、无人轮询）是"任务不真正生成"的根因
                remote_task_id = result.meta["remote_task_id"]
                task.progress = 20
                task.meta = {**(task.meta or {}),
                             "remote_task_id": remote_task_id, "adapter": adapter_name}
                incoming_logs = (result.meta or {}).get("logs") or []
                if incoming_logs:
                    task.meta["logs"] = list((task.meta or {}).get("logs") or []) + incoming_logs
                _flag_meta(task, "meta")
                await db.flush()
                spawn_background(_async_poll_adapter(
                    str(task.id), remote_task_id, adapter_name,
                    model_config, org_id, user_id, sc.id,
                ))
                processing += 1
            else:
                # 同步渠道：结果即时返回
                task.status = "completed"
                task.progress = 100
                task.completed_at = datetime.now(timezone.utc)
                task.output_urls = result.urls
                task.meta = {**(task.meta or {}), "adapter": adapter_name}
                incoming_logs = (result.meta or {}).get("logs") or []
                if incoming_logs:
                    task.meta["logs"] = list((task.meta or {}).get("logs") or []) + incoming_logs
                _flag_meta(task, "meta")
                sc.status = "completed"
                sc.generated_video_url = result.urls[0] if result.urls else None
                sc.thumbnail_url = result.urls[0] if result.urls else None
                completed += 1
        except Exception as e:
            task.status = "failed"
            task.error_message = str(e)[:500]
            task.completed_at = datetime.now(timezone.utc)
            sc.status = "failed"
            failed += 1
            failed_scenes.append(sc.sequence)
        await db.flush()
        tasks.append({"task_id": str(task.id), "scene_id": str(sc.id),
                      "sequence": sc.sequence, "status": task.status})

    # 6. 集状态 -> video_editing
    ep.status = EPISODE_STATUS_VIDEO_EDITING
    ep.meta = {**(ep.meta or {}), "render_started_at": True, "task_count": len(tasks)}
    await db.flush()

    return {
        "episode_id": str(episode_id),
        "tasks": tasks,
        "credits_consumed": total_cost,
        "new_status": ep.status,
        "scene_count": len(scenes),
        "completed": completed,
        "processing": processing,
        "skipped_in_flight": len(in_flight),
        "failed": failed,
        "failed_scenes": failed_scenes,
    }


async def compose_episode(db: AsyncSession, project_id: UUID, episode_id: UUID) -> Dict[str, Any]:
    """合并成片: 所有分镜已完成时, 把分镜视频按序合并为一个完整视频(不生成任务/不扣积分).

    - 有未完成分镜时拒绝(BadRequest), 提示先生成
    - 合并结果写入 episode.meta.composed_video_url, 集状态推进到 completed
    """
    from datetime import datetime, timezone
    from app.services.video_compose import compose_videos

    ep = await get_episode(db, project_id, episode_id)

    r = await db.execute(
        select(Scene).where(Scene.episode_id == episode_id).order_by(Scene.sequence.asc())
    )
    scenes = list(r.scalars().all())
    if not scenes:
        raise BadRequestException("该集暂无分镜，无法合并成片")

    incomplete = [sc for sc in scenes if sc.status != "completed" or not sc.generated_video_url]
    if incomplete:
        seqs = ", #".join(str(sc.sequence) for sc in incomplete[:10])
        raise BadRequestException(
            f"还有 {len(incomplete)} 个分镜未完成（#{seqs}），请先生成或等待完成后再合并成片"
        )

    video_url = await compose_videos([sc.generated_video_url for sc in scenes])

    ep.meta = {
        **(ep.meta or {}),
        "composed_video_url": video_url,
        "composed_clip_count": len(scenes),
        "composed_at": datetime.now(timezone.utc).isoformat(),
    }
    ep.status = EPISODE_STATUS_COMPLETED
    await db.flush()

    return {
        "episode_id": str(episode_id),
        "video_url": video_url,
        "clip_count": len(scenes),
        "new_status": ep.status,
    }


# ==================== 内部工具 ====================

def _to_dict(ep: Episode, scene_count: int = 0, completed_count: int = 0) -> Dict[str, Any]:
    return {
        "id": str(ep.id),
        "project_id": str(ep.project_id),
        "script_id": str(ep.script_id) if ep.script_id else None,
        "number": ep.number,
        "title": ep.title,
        "status": ep.status,
        "stop_after_step": ep.stop_after_step,
        "smart_review": ep.smart_review,
        "cover_image_url": ep.cover_image_url,
        "sort_order": ep.sort_order,
        "scene_count": scene_count,
        "completed_count": completed_count,
        "composed_video_url": (ep.meta or {}).get("composed_video_url"),
        "composed_clip_count": (ep.meta or {}).get("composed_clip_count"),
        "created_at": ep.created_at.isoformat() if ep.created_at else None,
        "updated_at": ep.updated_at.isoformat() if ep.updated_at else None,
    }
