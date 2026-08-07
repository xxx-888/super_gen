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

    M4 流水线骨架(适配器为占位, M5 接真实模型):
    1. 校验集内分镜, 估算总积分
    2. 扣减积分(整体预估)
    3. 为每个未完成分镜创建 GenerationTask(图生视频)
    4. 推进集状态 -> video_editing
    5. 返回任务清单

    实际生成由 Celery worker 异步执行(M5 接适配器后真实产出).
    """
    ep = await get_episode(db, project_id, episode_id)

    # 1. 获取集内分镜
    r = await db.execute(
        select(Scene).where(Scene.episode_id == episode_id).order_by(Scene.sequence.asc())
    )
    scenes = list(r.scalars().all())

    if not scenes:
        # 无分镜: 直接标记完成占位, 便于流程联调
        ep.status = EPISODE_STATUS_VIDEO_EDITING
        ep.meta = {**(ep.meta or {}), "render_note": "无分镜, 跳过生成"}
        await db.flush()
        return {"episode_id": str(episode_id), "tasks": [], "credits_consumed": 0,
                "message": "No scenes in episode"}

    # 2. 估算积分 (每个分镜按图生视频单价)
    cost_per_scene = settings.CREDITS_COST_IMAGE_TO_VIDEO
    total_cost = cost_per_scene * len(scenes)

    # 3. 扣减积分
    tx = await consume_credits(
        db, org_id, total_cost, user_id=user_id,
        project_id=project_id, model="image_to_video",
        remark=f"一键成片: 第{ep.number}集 ({len(scenes)}个分镜)",
    )
    tx_id = getattr(tx, "id", None)

    # 4. 为每个分镜创建任务并立即用适配器执行
    # 先检查模型是否已配置（未配置则拒绝，避免用 Placeholder 浪费积分）
    from app.services.creation_service import _ensure_model_available
    await _ensure_model_available(db, "image_to_video")

    from app.adapters.factory import get_adapter_for_task_type
    from app.adapters.base import GenInput
    from datetime import datetime, timezone

    tasks = []
    adapter = await get_adapter_for_task_type("image_to_video", db=db)
    for sc in scenes:
        task = GenerationTask(
            project_id=project_id, episode_id=episode_id,
            type="video", model="image_to_video",
            input_data={
                "scene_id": str(sc.id), "prompt": sc.prompt,
                "creation_mode": sc.creation_mode or "image_to_video",
            },
            status="processing", credits_consumed=cost_per_scene,
            started_at=datetime.now(timezone.utc),
            meta={"org_tx_id": str(tx_id) if tx_id else None},
        )
        db.add(task)
        await db.flush()

        # 立即执行适配器(Placeholder: sleep+占位URL)
        try:
            inp = GenInput(prompt=sc.prompt, duration=sc.duration or 5.0)
            result = await adapter.image_to_video(inp)
            task.status = "completed"
            task.progress = 100
            task.completed_at = datetime.now(timezone.utc)
            task.output_urls = result.urls
            task.meta = {**(task.meta or {}), "adapter": "placeholder"}
            sc.status = "completed"
            sc.generated_video_url = result.urls[0] if result.urls else None
            sc.thumbnail_url = result.urls[0] if result.urls else None
        except Exception as e:
            task.status = "failed"
            task.error_message = str(e)[:500]
            task.completed_at = datetime.now(timezone.utc)
            sc.status = "failed"
        await db.flush()
        tasks.append({"task_id": str(task.id), "scene_id": str(sc.id),
                      "sequence": sc.sequence, "status": task.status})

    # 5. 集状态 -> video_editing
    ep.status = EPISODE_STATUS_VIDEO_EDITING
    ep.meta = {**(ep.meta or {}), "render_started_at": True, "task_count": len(tasks)}
    await db.flush()

    return {
        "episode_id": str(episode_id),
        "tasks": tasks,
        "credits_consumed": total_cost,
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
        "created_at": ep.created_at.isoformat() if ep.created_at else None,
        "updated_at": ep.updated_at.isoformat() if ep.updated_at else None,
    }
