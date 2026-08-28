"""
Admin API - 后台管理接口
"""
import json
import os
import re
from typing import List, Dict, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID, uuid4

from app.core.database import get_db
from app.core.security import get_current_admin_user, get_current_user, get_password_hash
from app.core.exceptions import NotFoundException, ConflictException, BadRequestException
from app.adapters.factory import invalidate_adapter_cache
from app.adapters.base import redact_task_meta as _redact_admin_task_meta
from app.models import (
    User, Project, GenerationTask, AIModel, PromptTemplate,
    Organization, CreditAccount, CreditTransaction, CreditPricing, Work,
    MediaState, TeamMaterial, AudioAsset, VideoAsset,
    Character, SceneBackground, Prop, Canvas, ComfyUIWorkflow,
)
from app.schemas import (
    AdminStats, ModelConfig, SystemSettingsUpdate,
    AIModelCreate, AIModelUpdate, UserCreate,
    PromptTemplateResponse, PromptTemplateCreate, PromptTemplateUpdate,
    CreditAccountResponse, CreditTransactionResponse, CreditRechargeRequest,
    PricingCreate, PricingUpdate, PricingResponse,
)

router = APIRouter()


# ==================== 统计面板 ====================

@router.get("/stats", response_model=AdminStats)
async def get_admin_stats(
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取平台统计数据（仪表盘聚合：总量/今日/成功率/积分/模型与类型分布/近7日趋势/最近失败）"""
    from datetime import datetime, timezone, timedelta
    from sqlalchemy import case

    # 展示口径用北京时间（当日零点），与 timestamptz 比较用 tz-aware datetime
    tz8 = timezone(timedelta(hours=8))
    today_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=6)

    total_users = (await db.execute(select(func.count(User.id)))).scalar() or 0
    total_projects = (await db.execute(select(func.count(Project.id)))).scalar() or 0

    total_tasks = (await db.execute(
        select(func.count(GenerationTask.id)).where(GenerationTask.deleted_at.is_(None))
    )).scalar() or 0
    tasks_by_status = dict((await db.execute(
        select(GenerationTask.status, func.count(GenerationTask.id))
        .where(GenerationTask.deleted_at.is_(None))
        .group_by(GenerationTask.status)
    )).all())

    # 今日新增
    new_users_today = (await db.execute(
        select(func.count(User.id)).where(User.created_at >= today_start)
    )).scalar() or 0
    new_tasks_today = (await db.execute(
        select(func.count(GenerationTask.id)).where(
            GenerationTask.deleted_at.is_(None),
            GenerationTask.created_at >= today_start,
        )
    )).scalar() or 0
    # 今日活跃：今日提交过任务的用户数
    active_users_today = (await db.execute(
        select(func.count(func.distinct(GenerationTask.user_id))).where(
            GenerationTask.deleted_at.is_(None),
            GenerationTask.created_at >= today_start,
            GenerationTask.user_id.isnot(None),
        )
    )).scalar() or 0

    completed = tasks_by_status.get("completed", 0)
    failed = tasks_by_status.get("failed", 0)
    finished = completed + failed
    success_rate = round(completed / finished * 100, 1) if finished else None

    # 真实本地存储占用（GB）
    from app.services.asset_downloader import get_local_storage_stats
    storage_used = round((get_local_storage_stats().get("total_size_mb") or 0) / 1024, 2)

    # 模型使用 Top6
    popular_models = [
        {"model": m or "未知", "count": c}
        for m, c in (await db.execute(
            select(GenerationTask.model, func.count(GenerationTask.id))
            .where(GenerationTask.deleted_at.is_(None), GenerationTask.model.isnot(None))
            .group_by(GenerationTask.model)
            .order_by(func.count(GenerationTask.id).desc())
            .limit(6)
        )).all()
    ]

    # 任务类型分布
    tasks_by_type = dict((await db.execute(
        select(GenerationTask.type, func.count(GenerationTask.id))
        .where(GenerationTask.deleted_at.is_(None))
        .group_by(GenerationTask.type)
    )).all())

    # 近 7 日趋势（北京时间日期；failed 单列计数）
    daily_rows = (await db.execute(
        select(
            func.to_char(func.timezone("Asia/Shanghai", GenerationTask.created_at), "MM-DD").label("d"),
            func.count(GenerationTask.id),
            func.count(case((GenerationTask.status == "failed", 1))),
        ).where(
            GenerationTask.deleted_at.is_(None),
            GenerationTask.created_at >= week_start,
        ).group_by("d")
    )).all()
    daily_map = {d: (c, f) for d, c, f in daily_rows}
    tasks_daily = []
    for i in range(7):
        day_bj = (datetime.now(tz8) - timedelta(days=6 - i)).strftime("%m-%d")
        c, f = daily_map.get(day_bj, (0, 0))
        tasks_daily.append({"date": day_bj, "count": c, "failed": f})

    # 积分：全类型流水汇总 + 今日消耗 + 余额合计
    tx_rows = (await db.execute(
        select(CreditTransaction.type, func.coalesce(func.sum(CreditTransaction.amount), 0))
        .group_by(CreditTransaction.type)
    )).all()
    tx_map = {t: s for t, s in tx_rows}
    total_credits_consumed = int(abs(tx_map.get("consume", 0)))
    credits_consumed_today = int(abs((await db.execute(
        select(func.coalesce(func.sum(CreditTransaction.amount), 0)).where(
            CreditTransaction.type == "consume",
            CreditTransaction.created_at >= today_start,
        )
    )).scalar() or 0))
    total_credits_balance = int((await db.execute(
        select(func.coalesce(func.sum(CreditAccount.balance), 0))
    )).scalar() or 0)

    # 最近失败任务（5 条）
    recent_failed_rows = (await db.execute(
        select(GenerationTask).where(
            GenerationTask.deleted_at.is_(None),
            GenerationTask.status == "failed",
        ).order_by(GenerationTask.created_at.desc()).limit(5)
    )).scalars().all()
    recent_failed_tasks = [
        {
            "id": str(t.id),
            "type": t.type,
            "model": t.model,
            "error": (t.error_message or "")[:150],
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in recent_failed_rows
    ]

    return AdminStats(
        total_users=total_users,
        active_users_today=active_users_today,
        total_projects=total_projects,
        total_tasks=total_tasks,
        tasks_by_status=tasks_by_status,
        storage_used=storage_used,
        popular_models=popular_models,
        new_users_today=new_users_today,
        new_tasks_today=new_tasks_today,
        task_success_rate=success_rate,
        total_credits_consumed=total_credits_consumed,
        credits_consumed_today=credits_consumed_today,
        total_credits_balance=total_credits_balance,
        tasks_by_type=tasks_by_type,
        tasks_daily=tasks_daily,
        recent_failed_tasks=recent_failed_tasks,
    )


# ==================== 用户管理 ====================

@router.get("/users")
async def admin_get_users(
    page: int = 1,
    page_size: int = 20,
    search: str = None,
    role: str = None,
    status: str = None,
    sort: str = "created_at",        # created_at | task_count | credits_consumed | project_count
    order: str = "desc",             # asc | desc
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员查看用户列表：服务端分页/搜索/筛选/排序 + 每行聚合(项目/任务/积分/最近活跃)。

    返回 {items, total, page, page_size, summary}；summary 为全量口径的统计卡数据
    （总用户/今日新增/7日活跃/管理员数），不受筛选影响。
    """
    from datetime import datetime, timezone, timedelta

    tz8 = timezone(timedelta(hours=8))
    today_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=6)

    stmt = select(User)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(or_(User.email.ilike(pattern), User.nickname.ilike(pattern)))
    if role:
        stmt = stmt.where(User.role == role)
    if status is not None:
        stmt = stmt.where(User.is_active == (status == "active"))

    users = (await db.execute(stmt)).scalars().all()

    # ---- 聚合：项目数 / 任务数+积分+最近活跃（group_by 避免 N+1）----
    proj_cnt: Dict[str, int] = {}
    if users:
        uid_list = [u.id for u in users]
        rows = await db.execute(
            select(Project.user_id, func.count(Project.id))
            .where(Project.user_id.in_(uid_list)).group_by(Project.user_id)
        )
        proj_cnt = {str(uid): c or 0 for uid, c in rows.all()}

        task_rows = await db.execute(
            select(
                GenerationTask.user_id,
                func.count(GenerationTask.id),
                func.coalesce(func.sum(GenerationTask.credits_consumed), 0),
                func.max(GenerationTask.created_at),
            ).where(
                GenerationTask.user_id.in_(uid_list),
                GenerationTask.deleted_at.is_(None),
            ).group_by(GenerationTask.user_id)
        )
        task_stat = {
            str(uid): {"count": c or 0, "credits": credits or 0, "last": last}
            for uid, c, credits, last in task_rows.all()
        }
    else:
        task_stat = {}

    def _ts(uid_str: str, key: str):
        return task_stat.get(uid_str, {}).get(key, 0)

    items = [{
        "id": str(u.id),
        "email": u.email,
        "nickname": u.nickname,
        "avatar_url": u.avatar_url,
        "role": u.role,
        "is_active": u.is_active,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "project_count": proj_cnt.get(str(u.id), 0),
        "task_count": _ts(str(u.id), "count"),
        "credits_consumed": _ts(str(u.id), "credits"),
        "last_active": task_stat.get(str(u.id), {}).get("last").isoformat()
        if task_stat.get(str(u.id), {}).get("last") else None,
    } for u in users]

    # ---- 排序（白名单；聚合字段按内存值排）----
    sort_keys = {
        "created_at": lambda r: r["created_at"] or "",
        "task_count": lambda r: r["task_count"],
        "credits_consumed": lambda r: r["credits_consumed"],
        "project_count": lambda r: r["project_count"],
    }
    key_fn = sort_keys.get(sort, sort_keys["created_at"])
    items.sort(key=key_fn, reverse=(order != "asc"))

    # ---- summary：全量口径（不随筛选变化）----
    summary = {
        "total": (await db.execute(select(func.count(User.id)))).scalar() or 0,
        "today_new": (await db.execute(
            select(func.count(User.id)).where(User.created_at >= today_start)
        )).scalar() or 0,
        "active_7d": (await db.execute(
            select(func.count(func.distinct(GenerationTask.user_id))).where(
                GenerationTask.deleted_at.is_(None),
                GenerationTask.created_at >= week_start,
                GenerationTask.user_id.isnot(None),
            )
        )).scalar() or 0,
        "admin_count": (await db.execute(
            select(func.count(User.id)).where(User.role == "admin")
        )).scalar() or 0,
    }

    total = len(items)
    offset = (page - 1) * page_size
    return {
        "items": items[offset:offset + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "summary": summary,
    }


@router.put("/users/{user_id}/role")
async def update_user_role(
    user_id: str,
    body: dict,  # {"role": "admin" | "user"}
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """修改用户角色"""
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user:
        raise NotFoundException("User not found")

    new_role = body.get("role")
    if new_role:
        user.role = new_role

    await db.commit()
    return {"message": "User role updated", "user_id": str(user.id), "role": user.role}


@router.post("/users/{user_id}/toggle-status")
async def toggle_user_status(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """启用/禁用用户账户"""
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user:
        raise NotFoundException("User not found")

    user.is_active = not user.is_active
    await db.commit()
    return {
        "message": "User status toggled",
        "user_id": str(user.id),
        "is_active": user.is_active,
    }


@router.post("/users", response_model=dict)
async def admin_create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员创建新用户"""
    # 邮箱唯一性校验
    existing = await db.execute(select(User).where(User.email == body.email))
    if existing.scalar_one_or_none():
        raise ConflictException("该邮箱已被注册")

    user = User(
        email=body.email,
        hashed_password=get_password_hash(body.password),
        nickname=body.nickname,
        role="user",
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {
        "id": str(user.id),
        "email": user.email,
        "nickname": user.nickname,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.delete("/users/{user_id}")
async def admin_delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员删除用户"""
    # 防止管理员删除自己
    if str(admin.id) == user_id:
        raise ConflictException("不能删除当前登录的管理员账户")

    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user:
        raise NotFoundException("User not found")

    await db.delete(user)
    await db.commit()
    return {"message": "User deleted", "user_id": user_id}


@router.get("/users/{user_id}")
async def admin_get_user_detail(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员查看用户详情"""
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException("User not found")
    return {
        "id": str(user.id),
        "email": user.email,
        "nickname": user.nickname,
        "avatar_url": user.avatar_url,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.put("/users/{user_id}")
async def admin_update_user(
    user_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员编辑用户信息(昵称/角色)。

    邮箱注册后不可修改（业务要求），即使请求体带 email 也忽略。
    """
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException("User not found")
    # 邮箱不参与更新（注册后锁定）
    if "nickname" in body:
        user.nickname = body["nickname"]
    if "avatar_url" in body:
        user.avatar_url = body["avatar_url"]
    if "role" in body and body["role"] in ("admin", "user"):
        user.role = body["role"]
    await db.commit()
    return {
        "id": str(user.id), "email": user.email, "nickname": user.nickname,
        "avatar_url": user.avatar_url, "role": user.role,
    }


@router.post("/users/{user_id}/reset-password")
async def admin_reset_user_password(
    user_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员重置用户密码"""
    new_password = body.get("new_password") or body.get("password")
    if not new_password or len(new_password) < 8:
        from app.core.exceptions import BadRequestException
        raise BadRequestException("Password must be at least 8 characters")
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException("User not found")
    user.hashed_password = get_password_hash(new_password)
    await db.commit()
    return {"message": "Password reset", "user_id": user_id}


@router.post("/users/batch-status")
async def admin_batch_user_status(
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """批量启用/禁用用户。body: {ids: [uuid...], active: bool}"""
    ids = body.get("ids") or []
    active = bool(body.get("active"))
    if not ids:
        raise BadRequestException("ids 不能为空")
    # 不允许管理员禁用自己（避免把自己锁出后台）
    self_id = str(admin.id)
    target_ids = [UUID(i) for i in ids if str(i) != self_id]
    skipped = len(ids) - len(target_ids)
    if not target_ids:
        raise ConflictException("不能对当前登录的管理员执行批量状态操作")
    result = await db.execute(select(User).where(User.id.in_(target_ids)))
    users = result.scalars().all()
    for u in users:
        u.is_active = active
    await db.commit()
    return {
        "message": f"已{'启用' if active else '禁用'} {len(users)} 个用户",
        "updated": len(users),
        "skipped_self": skipped,
    }


@router.get("/users/{user_id}/detail")
async def admin_get_user_detail_rich(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """用户富详情：基础信息 + 使用统计 + 所属团队(含积分余额/个人配额) + 最近任务 + 积分流水"""
    from app.models import Membership, Script, Scene

    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException("User not found")
    uid = user.id

    # 使用统计
    project_count = (await db.execute(
        select(func.count(Project.id)).where(Project.user_id == uid)
    )).scalar() or 0
    task_total = (await db.execute(
        select(func.count(GenerationTask.id)).where(
            GenerationTask.user_id == uid, GenerationTask.deleted_at.is_(None))
    )).scalar() or 0
    task_done = (await db.execute(
        select(func.count(GenerationTask.id)).where(
            GenerationTask.user_id == uid, GenerationTask.deleted_at.is_(None),
            GenerationTask.status == "completed")
    )).scalar() or 0
    task_failed = (await db.execute(
        select(func.count(GenerationTask.id)).where(
            GenerationTask.user_id == uid, GenerationTask.deleted_at.is_(None),
            GenerationTask.status == "failed")
    )).scalar() or 0
    credits_consumed = (await db.execute(
        select(func.coalesce(func.sum(GenerationTask.credits_consumed), 0)).where(
            GenerationTask.user_id == uid, GenerationTask.deleted_at.is_(None))
    )).scalar() or 0
    scene_count = (await db.execute(
        select(func.count(Scene.id)).where(Scene.script_id.in_(
            select(Script.id).where(Script.project_id.in_(
                select(Project.id).where(Project.user_id == uid))))
        )
    )).scalar() or 0

    # 所属团队（Membership → Organization → CreditAccount + 个人配额）
    from app.models import CreditAllocation
    orgs: List[Dict[str, Any]] = []
    m_rows = await db.execute(
        select(Membership, Organization)
        .join(Organization, Membership.org_id == Organization.id)
        .where(Membership.user_id == uid, Membership.is_active == True)  # noqa: E712
    )
    for m, o in m_rows.all():
        acct = (await db.execute(
            select(CreditAccount).where(CreditAccount.org_id == o.id)
        )).scalar_one_or_none()
        alloc = (await db.execute(
            select(CreditAllocation).where(
                CreditAllocation.org_id == o.id, CreditAllocation.user_id == uid)
        )).scalar_one_or_none()
        orgs.append({
            "org_id": str(o.id),
            "org_name": o.name,
            "is_personal": bool(o.is_personal),
            "member_role": m.role,
            "balance": acct.balance if acct else None,
            "quota": alloc.quota if alloc else None,
            "quota_used": alloc.used if alloc else None,
        })

    # 最近任务 10 条
    recent_tasks = (await db.execute(
        select(GenerationTask).where(
            GenerationTask.user_id == uid, GenerationTask.deleted_at.is_(None))
        .order_by(GenerationTask.created_at.desc()).limit(10)
    )).scalars().all()
    tasks_list = [{
        "id": str(t.id), "type": t.type, "status": t.status, "model": t.model,
        "credits_consumed": t.credits_consumed or 0,
        "progress": t.progress or 0,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    } for t in recent_tasks]

    # 最近积分流水 5 笔
    tx_rows = (await db.execute(
        select(CreditTransaction).where(CreditTransaction.user_id == uid)
        .order_by(CreditTransaction.created_at.desc()).limit(5)
    )).scalars().all()
    tx_list = [{
        "id": str(t.id), "type": t.type, "amount": t.amount,
        "balance_after": t.balance_after, "remark": t.remark,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    } for t in tx_rows]

    return {
        "id": str(user.id),
        "email": user.email,
        "nickname": user.nickname,
        "avatar_url": user.avatar_url,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "stats": {
            "project_count": project_count,
            "scene_count": scene_count,
            "task_total": task_total,
            "task_done": task_done,
            "task_failed": task_failed,
            "success_rate": round(task_done / (task_done + task_failed) * 100, 1)
            if (task_done + task_failed) else None,
            "credits_consumed": credits_consumed,
        },
        "orgs": orgs,
        "recent_tasks": tasks_list,
        "recent_transactions": tx_list,
    }


# ==================== 项目管理 ====================

@router.get("/projects")
async def admin_get_projects(
    page: int = 1,
    page_size: int = 20,
    user_id: str = None,
    status: str = None,
    search: str = None,
    sort: str = "updated_at",       # updated_at | created_at | task_count | scene_count | credits_used
    order: str = "desc",
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员查看所有项目：服务端分页/筛选/排序 + 所有者信息 + 内容规模统计。

    返回 {items, total, page, page_size, summary}；summary 为全量口径
    （总项目/7日活跃/制作中/已归档）。
    """
    from datetime import datetime, timezone, timedelta
    from sqlalchemy import func as sa_func
    from app.models import (
        Script, Scene, Character, Prop, SceneBackground, ProjectMember, Canvas, GenerationTask,
    )

    tz8 = timezone(timedelta(hours=8))
    week_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6)

    stmt = select(Project)
    if user_id:
        stmt = stmt.where(Project.user_id == UUID(user_id))
    if status:
        stmt = stmt.where(Project.status == status)
    if search:
        stmt = stmt.where(Project.name.ilike(f"%{search}%"))

    projects = (await db.execute(stmt)).scalars().all()

    # ---- summary：全量口径（不随筛选变化）----
    summary = {
        "total": (await db.execute(select(func.count(Project.id)))).scalar() or 0,
        "active_7d": (await db.execute(
            select(func.count(Project.id)).where(Project.updated_at >= week_start)
        )).scalar() or 0,
        "producing": (await db.execute(
            select(func.count(Project.id)).where(Project.status == "producing")
        )).scalar() or 0,
        "archived": (await db.execute(
            select(func.count(Project.id)).where(Project.status == "archived")
        )).scalar() or 0,
    }

    # 批量查所有者邮箱
    owner_ids = list(set(str(p.user_id) for p in projects if p.user_id))
    owner_map = {}
    if owner_ids:
        u_result = await db.execute(select(User).where(User.id.in_([UUID(uid) for uid in owner_ids])))
        for u in u_result.scalars().all():
            owner_map[str(u.id)] = {"email": u.email, "nickname": u.nickname}

    # 批量查每个项目的任务数 + 积分消耗 + 成功率分量
    proj_ids = [p.id for p in projects]
    task_stats = {}
    if proj_ids:
        stat_result = await db.execute(
            select(
                GenerationTask.project_id,
                sa_func.count(GenerationTask.id),
                sa_func.coalesce(sa_func.sum(GenerationTask.credits_consumed), 0),
                sa_func.count().filter(GenerationTask.status == "completed"),
            ).where(
                GenerationTask.project_id.in_(proj_ids),
                GenerationTask.deleted_at.is_(None),
            ).group_by(GenerationTask.project_id)
        )
        for pid, cnt, credits, done in stat_result.all():
            task_stats[str(pid)] = {
                "task_count": cnt or 0, "credits_used": credits or 0, "done": done or 0,
            }

    # 批量统计每个项目的「内容规模」：剧本数 / 成员数 / 分镜数 / 角色数 / 物品数 / 场景数
    content_stats: Dict[str, Dict[str, int]] = {str(pid): {} for pid in proj_ids}

    async def _aggregate(fk_col, key):
        """按 ORM 外键列聚合计数（如 Script.project_id），结果并入 content_stats"""
        if not proj_ids:
            return
        rows = await db.execute(
            select(fk_col, sa_func.count())
            .where(fk_col.in_(proj_ids))
            .group_by(fk_col)
        )
        for pid, cnt in rows.all():
            content_stats.setdefault(str(pid), {})[key] = cnt or 0

    await _aggregate(Script.project_id, "script_count")
    await _aggregate(Character.project_id, "character_count")
    await _aggregate(Prop.project_id, "prop_count")
    await _aggregate(SceneBackground.project_id, "scene_background_count")
    await _aggregate(ProjectMember.project_id, "member_count")
    await _aggregate(Canvas.project_id, "canvas_count")

    # 分镜(Scene)挂在 Script 下，需要先聚合到 script 再汇总到 project
    if proj_ids:
        scene_rows = await db.execute(
            select(Scene.script_id, sa_func.count())
            .where(Scene.script_id.in_(
                select(Script.id).where(Script.project_id.in_(proj_ids))
            ))
            .group_by(Scene.script_id)
        )
        scene_per_script = {str(sid): cnt or 0 for sid, cnt in scene_rows.all()}
        script_proj_rows = await db.execute(
            select(Script.id, Script.project_id).where(Script.project_id.in_(proj_ids))
        )
        project_scene_count: Dict[str, int] = {}
        for sid, pid in script_proj_rows.all():
            project_scene_count[str(pid)] = project_scene_count.get(str(pid), 0) + scene_per_script.get(str(sid), 0)
        for pid, cnt in project_scene_count.items():
            content_stats.setdefault(pid, {})["scene_count"] = cnt

    def _cs(pid_str: str, key: str) -> int:
        return content_stats.get(pid_str, {}).get(key, 0)

    items = [
        {
            "id": str(p.id),
            "user_id": str(p.user_id) if p.user_id else None,
            "owner_email": owner_map.get(str(p.user_id), {}).get("email", "-") if p.user_id else "-",
            "owner_nickname": owner_map.get(str(p.user_id), {}).get("nickname", "-") if p.user_id else "-",
            "name": p.name,
            "description": p.description,
            "status": p.status,
            "cover_image_url": p.cover_image_url,
            "task_count": task_stats.get(str(p.id), {}).get("task_count", 0),
            "credits_used": task_stats.get(str(p.id), {}).get("credits_used", 0),
            "success_rate": round(
                task_stats.get(str(p.id), {}).get("done", 0)
                / task_stats.get(str(p.id), {}).get("task_count", 0) * 100, 1
            ) if task_stats.get(str(p.id), {}).get("task_count") else None,
            # 内容规模统计
            "script_count": _cs(str(p.id), "script_count"),
            "member_count": _cs(str(p.id), "member_count"),
            "scene_count": _cs(str(p.id), "scene_count"),
            "character_count": _cs(str(p.id), "character_count"),
            "prop_count": _cs(str(p.id), "prop_count"),
            "scene_background_count": _cs(str(p.id), "scene_background_count"),
            "canvas_count": _cs(str(p.id), "canvas_count"),
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        }
        for p in projects
    ]

    sort_keys = {
        "updated_at": lambda r: r["updated_at"] or "",
        "created_at": lambda r: r["created_at"] or "",
        "task_count": lambda r: r["task_count"],
        "scene_count": lambda r: r["scene_count"],
        "credits_used": lambda r: r["credits_used"],
    }
    key_fn = sort_keys.get(sort, sort_keys["updated_at"])
    items.sort(key=key_fn, reverse=(order != "asc"))

    total = len(items)
    offset = (page - 1) * page_size
    return {
        "items": items[offset:offset + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "summary": summary,
    }


@router.get("/projects/{project_id}/detail")
async def admin_get_project_detail_rich(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """项目富详情：基本信息 + 内容规模 + 任务统计(状态/类型分布) + 成员列表 + 最近任务"""
    from app.models import (
        Script, Scene, Character, Prop, SceneBackground, ProjectMember, Canvas, Episode,
    )
    from sqlalchemy import func as sa_func

    result = await db.execute(select(Project).where(Project.id == UUID(project_id)))
    project = result.scalar_one_or_none()
    if not project:
        raise NotFoundException("Project not found")
    pid = project.id

    owner = (await db.execute(select(User).where(User.id == project.user_id))).scalar_one_or_none()

    # 内容规模
    async def _count(model, where):
        return (await db.execute(select(func.count(model.id)).where(where))).scalar() or 0

    script_ids_q = select(Script.id).where(Script.project_id == pid)
    content = {
        "script_count": await _count(Script, Script.project_id == pid),
        "scene_count": await _count(Scene, Scene.script_id.in_(script_ids_q)),
        "episode_count": await _count(Episode, Episode.script_id.in_(script_ids_q)),
        "character_count": await _count(Character, Character.project_id == pid),
        "prop_count": await _count(Prop, Prop.project_id == pid),
        "scene_background_count": await _count(SceneBackground, SceneBackground.project_id == pid),
        "canvas_count": await _count(Canvas, Canvas.project_id == pid),
    }

    # 任务统计（状态/类型分布）
    status_rows = (await db.execute(
        select(GenerationTask.status, func.count(GenerationTask.id))
        .where(GenerationTask.project_id == pid, GenerationTask.deleted_at.is_(None))
        .group_by(GenerationTask.status)
    )).all()
    status_dist = {s: c for s, c in status_rows}
    type_rows = (await db.execute(
        select(GenerationTask.type, func.count(GenerationTask.id))
        .where(GenerationTask.project_id == pid, GenerationTask.deleted_at.is_(None))
        .group_by(GenerationTask.type)
    )).all()
    type_dist = {t: c for t, c in type_rows}
    task_total = sum(status_dist.values()) or 0
    credits_used = (await db.execute(
        select(func.coalesce(func.sum(GenerationTask.credits_consumed), 0)).where(
            GenerationTask.project_id == pid, GenerationTask.deleted_at.is_(None))
    )).scalar() or 0

    # 成员列表
    member_rows = (await db.execute(
        select(ProjectMember, User)
        .join(User, ProjectMember.user_id == User.id)
        .where(ProjectMember.project_id == pid)
    )).all()
    members = [{
        "user_id": str(m.user_id), "nickname": u.nickname, "email": u.email,
        "role": m.role,
        "joined_at": m.created_at.isoformat() if m.created_at else None,
    } for m, u in member_rows]

    # 最近任务 10 条
    recent = (await db.execute(
        select(GenerationTask).where(
            GenerationTask.project_id == pid, GenerationTask.deleted_at.is_(None))
        .order_by(GenerationTask.created_at.desc()).limit(10)
    )).scalars().all()
    recent_tasks = [{
        "id": str(t.id), "type": t.type, "status": t.status, "model": t.model,
        "credits_consumed": t.credits_consumed or 0, "progress": t.progress or 0,
        "error_message": (t.error_message or "")[:120] or None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    } for t in recent]

    done = status_dist.get("completed", 0)
    failed = status_dist.get("failed", 0)
    return {
        "id": str(pid),
        "name": project.name,
        "description": project.description,
        "status": project.status,
        "cover_image_url": project.cover_image_url,
        "owner": {
            "id": str(project.user_id),
            "email": owner.email if owner else None,
            "nickname": owner.nickname if owner else None,
        },
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
        "content": content,
        "tasks": {
            "total": task_total,
            "status_dist": status_dist,
            "type_dist": type_dist,
            "success_rate": round(done / (done + failed) * 100, 1) if (done + failed) else None,
            "credits_used": credits_used,
        },
        "members": members,
        "recent_tasks": recent_tasks,
    }


@router.delete("/projects/{project_id}")
async def admin_delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员强制删除项目"""
    result = await db.execute(select(Project).where(Project.id == UUID(project_id)))
    project = result.scalar_one_or_none()

    if not project:
        raise NotFoundException("Project not found")

    await db.delete(project)
    await db.commit()
    return {"message": "Project deleted"}


# ==================== 作品管理 (画廊) ====================

@router.get("/works")
async def admin_get_works(
    page: int = 1,
    page_size: int = 20,
    search: str = None,
    is_public: bool = None,
    sort: str = "created_at",      # created_at | published_at | like_count | view_count
    order: str = "desc",
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员查看画廊作品(含作者信息, 支持搜索/公开状态筛选/排序 + 汇总统计)"""
    from datetime import datetime, timezone, timedelta

    stmt = select(Work)

    if search:
        stmt = stmt.where(Work.title.ilike(f"%{search}%"))
    if is_public is not None:
        stmt = stmt.where(Work.is_public == is_public)

    count_result = await db.execute(
        select(func.count()).select_from(stmt.subquery())
    )
    total = count_result.scalar() or 0

    sort_cols = {
        "created_at": Work.created_at,
        "published_at": Work.published_at,
        "like_count": Work.like_count,
        "view_count": Work.view_count,
    }
    sort_col = sort_cols.get(sort, Work.created_at)
    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size).order_by(
        sort_col.desc() if order != "asc" else sort_col.asc()
    )
    result = await db.execute(stmt)
    works = result.scalars().all()

    # ---- summary：全量口径（不随筛选变化）----
    tz8 = timezone(timedelta(hours=8))
    today_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0)
    summary = {
        "total": (await db.execute(select(func.count(Work.id)))).scalar() or 0,
        "public": (await db.execute(
            select(func.count(Work.id)).where(Work.is_public == True)  # noqa: E712
        )).scalar() or 0,
        "today_new": (await db.execute(
            select(func.count(Work.id)).where(Work.created_at >= today_start)
        )).scalar() or 0,
        "total_likes": (await db.execute(
            select(func.coalesce(func.sum(Work.like_count), 0))
        )).scalar() or 0,
    }

    # 批量查作者信息
    author_ids = list(set(w.user_id for w in works))
    author_map = {}
    if author_ids:
        u_result = await db.execute(select(User).where(User.id.in_(author_ids)))
        for u in u_result.scalars().all():
            author_map[u.id] = {"email": u.email, "nickname": u.nickname}

    return {
        "items": [
            {
                "id": str(w.id),
                "title": w.title,
                "description": w.description,
                "cover_url": w.cover_url,
                "video_url": w.video_url,
                "is_public": w.is_public,
                "view_count": w.view_count or 0,
                "like_count": w.like_count or 0,
                "tags": w.tags or [],
                "source_type": w.source_type,
                "author": author_map.get(w.user_id),
                "published_at": w.published_at.isoformat() if w.published_at else None,
                "created_at": w.created_at.isoformat() if w.created_at else None,
            }
            for w in works
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "summary": summary,
    }


@router.put("/works/{work_id}/visibility")
async def admin_set_work_visibility(
    work_id: str,
    body: dict,  # {"is_public": true(上架) / false(下架)}
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员上架/下架作品"""
    result = await db.execute(select(Work).where(Work.id == UUID(work_id)))
    work = result.scalar_one_or_none()

    if not work:
        raise NotFoundException("Work not found")

    is_public = body.get("is_public")
    if not isinstance(is_public, bool):
        raise BadRequestException("is_public must be a boolean")

    work.is_public = is_public
    await db.commit()
    await db.refresh(work)
    return {
        "message": "Work visibility updated",
        "work_id": str(work.id),
        "is_public": work.is_public,
    }


@router.delete("/works/{work_id}")
async def admin_delete_work(
    work_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员删除作品(work_likes 点赞记录由数据库级联删除)"""
    result = await db.execute(select(Work).where(Work.id == UUID(work_id)))
    work = result.scalar_one_or_none()

    if not work:
        raise NotFoundException("Work not found")

    await db.delete(work)
    await db.commit()
    return {"message": "Work deleted"}


@router.post("/works/batch-visibility")
async def admin_batch_work_visibility(
    body: dict,   # {"ids": [...], "is_public": bool}
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """批量上架/下架作品"""
    ids = body.get("ids") or []
    is_public = body.get("is_public")
    if not ids:
        raise BadRequestException("ids 不能为空")
    if not isinstance(is_public, bool):
        raise BadRequestException("is_public must be a boolean")
    result = await db.execute(
        select(Work).where(Work.id.in_([UUID(i) for i in ids]))
    )
    works = result.scalars().all()
    for w in works:
        w.is_public = is_public
    await db.commit()
    return {
        "message": f"已{'上架' if is_public else '下架'} {len(works)} 个作品",
        "updated": len(works),
    }


@router.post("/works/batch-delete")
async def admin_batch_delete_works(
    body: dict,   # {"ids": [...]}
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """批量删除作品（点赞记录由数据库级联删除）"""
    ids = body.get("ids") or []
    if not ids:
        raise BadRequestException("ids 不能为空")
    result = await db.execute(
        select(Work).where(Work.id.in_([UUID(i) for i in ids]))
    )
    works = result.scalars().all()
    for w in works:
        await db.delete(w)
    await db.commit()
    return {"message": f"已删除 {len(works)} 个作品", "deleted": len(works)}


# ==================== 生成媒体资源管理 ====================

# 任务类型 → 媒体类型（图片/视频/音频）
_MEDIA_TYPE_BY_TASK_TYPE = {"image": "image", "video": "video", "audio": "audio", "tts": "audio"}
# 来源标识 → 显示名
_MEDIA_SOURCE_LABELS = {"task": "生成任务", "material": "素材库", "asset": "项目资产",
                        "resource": "图片资源", "canvas": "画布"}

# 按扩展名推断媒体类型（画布 graph_data 里的 URL 没有显式类型字段）
_MEDIA_EXT_TYPES = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "image", ".bmp": "image", ".heic": "image", ".heif": "image",
    ".mp4": "video", ".mov": "video", ".webm": "video", ".mkv": "video",
    ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".aac": "audio",
    ".ogg": "audio", ".flac": "audio",
}


def _classify_media_url(u: Any) -> Optional[str]:
    """判断字符串是否媒体 URL 并推断类型；非媒体返回 None。
    /uploads/<category>/ 路径优先按目录推断，否则按扩展名。"""
    if not isinstance(u, str):
        return None
    if not (u.startswith(("/uploads/", "uploads/")) or u.startswith(("http://", "https://"))):
        return None
    m = re.search(r"/uploads/(image|video|audio)/", u)
    if m:
        return m.group(1)
    ext = os.path.splitext(u.split("?")[0])[1].lower()
    return _MEDIA_EXT_TYPES.get(ext)


def _collect_media_urls(value: Any, out: list) -> None:
    """递归收集 JSON 结构（画布节点 data）里的所有媒体 URL。"""
    if isinstance(value, str):
        if _classify_media_url(value):
            out.append(value)
    elif isinstance(value, list):
        for v in value:
            _collect_media_urls(v, out)
    elif isinstance(value, dict):
        for v in value.values():
            _collect_media_urls(v, out)


def _strip_url_from_json(value: Any, url: str) -> Any:
    """递归摘除 JSON 结构（画布 graph_data）中的指定 URL：
    字符串字段→置 None，列表→剔除元素。返回处理后的新结构。"""
    if isinstance(value, str):
        return None if value == url else value
    if isinstance(value, list):
        return [_strip_url_from_json(v, url) for v in value if v != url]
    if isinstance(value, dict):
        return {k: (None if v == url else _strip_url_from_json(v, url)) for k, v in value.items()}
    return value


@router.get("/media")
async def admin_list_media(
    page: int = 1,
    page_size: int = 20,
    type: str = None,      # image / video / audio
    status: str = None,    # normal / disabled
    source: str = None,    # task / material / asset / resource / canvas
    search: str = None,    # 匹配 文件名/URL/提示词/项目/用户
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """统一媒体库：生成任务输出 + 素材库上传 + 项目音视频资产。

    每个文件 URL 一条记录（跨来源去重，优先级 生成任务 > 素材库 > 项目资产）；
    禁用状态与显示名存在 media_states 表（按 URL），禁用的本地文件由
    media_guard 拦截（/uploads/... 返回 403）。
    """
    import os
    from app.core.config import settings as _settings

    items_by_url: Dict[str, Dict[str, Any]] = {}

    def _put(url: str, item: Dict[str, Any]) -> None:
        if url and url not in items_by_url:
            items_by_url[url] = item

    # ---- 来源A：生成任务输出 ----
    task_types = [k for k, v in _MEDIA_TYPE_BY_TASK_TYPE.items() if not type or v == type]
    result = await db.execute(
        select(GenerationTask).where(
            GenerationTask.deleted_at.is_(None),
            GenerationTask.output_urls.isnot(None),
            GenerationTask.type.in_(task_types),
        ).order_by(GenerationTask.created_at.desc())
    )
    tasks = result.scalars().all()
    user_ids = {t.user_id for t in tasks if t.user_id}
    project_ids = {t.project_id for t in tasks if t.project_id}
    users, projects = {}, {}
    if user_ids:
        rs = await db.execute(select(User).where(User.id.in_(user_ids)))
        users = {u.id: u for u in rs.scalars().all()}
    if project_ids:
        rs = await db.execute(select(Project).where(Project.id.in_(project_ids)))
        projects = {p.id: p for p in rs.scalars().all()}
    for t in tasks:
        prompt = str((t.input_data or {}).get("prompt") or ""
                     if isinstance(t.input_data, dict) else "")
        user = users.get(t.user_id)
        project = projects.get(t.project_id)
        for url in (t.output_urls or []):
            if not isinstance(url, str) or not url:
                continue
            _put(url, {
                "source": "task", "ref_id": str(t.id), "url": url,
                "type": _MEDIA_TYPE_BY_TASK_TYPE.get(t.type, t.type),
                "orig_name": url.split("/")[-1],
                "prompt": prompt[:120],
                "user": {"email": user.email, "nickname": user.nickname} if user else None,
                "project_title": project.name if project else None,
                "size_bytes": None, "created_at": t.created_at,
                "_search": " ".join(filter(None, [
                    url, url.split("/")[-1], prompt,
                    project.name if project else "",
                    f"{user.nickname} {user.email}" if user else "",
                ])).lower(),
            })

    # ---- 来源B：素材库上传（图片/视频/音频） ----
    if not type or type in ("image", "video", "audio"):
        rs = await db.execute(
            select(TeamMaterial).where(TeamMaterial.category == type if type else TeamMaterial.category.in_(["image", "video", "audio"]))
            .order_by(TeamMaterial.created_at.desc())
        )
        mat_users = {}
        m_user_ids = {m.uploaded_by for m in rs.scalars().all() if m.uploaded_by}
        if m_user_ids:
            u2 = await db.execute(select(User).where(User.id.in_(m_user_ids)))
            mat_users = {u.id: u for u in u2.scalars().all()}
        rs = await db.execute(
            select(TeamMaterial).where(TeamMaterial.category == type if type else TeamMaterial.category.in_(["image", "video", "audio"]))
            .order_by(TeamMaterial.created_at.desc())
        )
        for m in rs.scalars().all():
            user = mat_users.get(m.uploaded_by)
            _put(m.url, {
                "source": "material", "ref_id": str(m.id), "url": m.url,
                "type": m.category,
                "orig_name": m.name or m.url.split("/")[-1],
                "prompt": "",
                "user": {"email": user.email, "nickname": user.nickname} if user else None,
                "project_title": None,
                "size_bytes": m.size_bytes or None,
                "created_at": m.created_at,
                "_search": " ".join(filter(None, [
                    m.url, m.name or "",
                    f"{user.nickname} {user.email}" if user else "",
                ])).lower(),
            })

    # ---- 来源C：项目音视频资产（上传的参考音频/视频） ----
    if not type or type in ("audio", "video"):
        for Model, media_type in ((AudioAsset, "audio"), (VideoAsset, "video")):
            rs = await db.execute(select(Model).order_by(Model.created_at.desc()))
            asset_rows = rs.scalars().all()
            a_project_ids = {a.project_id for a in asset_rows if a.project_id}
            a_projects = {}
            if a_project_ids:
                p2 = await db.execute(select(Project).where(Project.id.in_(a_project_ids)))
                a_projects = {p.id: p for p in p2.scalars().all()}
            for a in asset_rows:
                project = a_projects.get(a.project_id)
                _put(a.url, {
                    "source": "asset", "ref_id": str(a.id), "url": a.url,
                    "type": media_type,
                    "orig_name": a.name or a.url.split("/")[-1],
                    "prompt": (a.content or "")[:120],
                    "user": None,
                    "project_title": project.name if project else None,
                    "size_bytes": None,
                    "created_at": a.created_at,
                    "_search": " ".join(filter(None, [
                        a.url, a.name or "", a.content or "",
                        project.name if project else "",
                    ])).lower(),
                })

    # ---- 来源D：项目图片资源（角色/场景/道具的主图，画布上传图片会同步到这里） ----
    if not type or type == "image":
        for Model, rtype in ((Character, "角色"), (SceneBackground, "场景"), (Prop, "道具")):
            rs = await db.execute(select(Model).where(Model.image_url.isnot(None)))
            rows = rs.scalars().all()
            r_project_ids = {o.project_id for o in rows if o.project_id}
            r_projects = {}
            if r_project_ids:
                p3 = await db.execute(select(Project).where(Project.id.in_(r_project_ids)))
                r_projects = {p.id: p for p in p3.scalars().all()}
            for o in rows:
                url = o.image_url
                if not isinstance(url, str) or not url:
                    continue
                project = r_projects.get(o.project_id)
                _put(url, {
                    "source": "resource", "ref_id": str(o.id), "url": url,
                    "type": "image",
                    "orig_name": o.name or url.split("/")[-1],
                    "prompt": "",
                    "user": None,
                    "project_title": project.name if project else None,
                    "size_bytes": None,
                    "created_at": o.created_at,
                    "_search": " ".join(filter(None, [url, o.name or "",
                                                      project.name if project else ""])).lower(),
                })

    # ---- 来源E：画布节点媒体（graph_data 里的上传/生成结果/参考 URL） ----
    if not type or type in ("image", "video", "audio"):
        rs = await db.execute(select(Canvas).order_by(Canvas.updated_at.desc()))
        canvas_rows = rs.scalars().all()
        cv_users, cv_projects = {}, {}
        cv_user_ids = {c.user_id for c in canvas_rows if c.user_id}
        cv_project_ids = {c.project_id for c in canvas_rows if c.project_id}
        if cv_user_ids:
            u3 = await db.execute(select(User).where(User.id.in_(cv_user_ids)))
            cv_users = {u.id: u for u in u3.scalars().all()}
        if cv_project_ids:
            p4 = await db.execute(select(Project).where(Project.id.in_(cv_project_ids)))
            cv_projects = {p.id: p for p in p4.scalars().all()}
        for c in canvas_rows:
            nodes = (c.graph_data or {}).get("nodes") if isinstance(c.graph_data, dict) else None
            if not nodes:
                continue
            user = cv_users.get(c.user_id)
            project = cv_projects.get(c.project_id)
            user_text = f"{user.nickname} {user.email}" if user else ""
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                data = node.get("data") or {}
                urls: list = []
                _collect_media_urls(data, urls)
                if not urls:
                    continue
                node_name = (data.get("label") or data.get("name") or data.get("fileName")
                             or node.get("type") or "画布节点")
                seen_in_node = set()
                for u in urls:
                    if u in seen_in_node:
                        continue
                    seen_in_node.add(u)
                    mt = _classify_media_url(u)
                    if type and mt != type:
                        continue
                    _put(u, {
                        "source": "canvas", "ref_id": str(c.id), "url": u,
                        "type": mt or "image",
                        "orig_name": f"{node_name}（{c.name}）",
                        "prompt": "",
                        "user": {"email": user.email, "nickname": user.nickname} if user else None,
                        "project_title": project.name if project else None,
                        "size_bytes": None,
                        "created_at": c.updated_at or c.created_at,
                        "_search": " ".join(filter(None, [
                            u, node_name, c.name, project.name if project else "", user_text,
                        ])).lower(),
                    })

    items = list(items_by_url.values())

    # 覆盖管理员状态（禁用/显示名）
    states = {}
    if items:
        rs = await db.execute(select(MediaState).where(MediaState.url.in_([i["url"] for i in items])))
        states = {s.url: s for s in rs.scalars().all()}

    for i in items:
        st = states.get(i["url"])
        i["disabled"] = bool(st and st.disabled)
        i["name"] = (st.name if st and st.name else None) or i["orig_name"]
        i["storage"] = "remote" if i["url"].startswith(("http://", "https://")) else "local"
        i["source_label"] = _MEDIA_SOURCE_LABELS.get(i["source"], i["source"])
        # 本地文件补充大小；size=-1 表示文件已缺失（记录还在）
        if i["source"] != "material" and i["storage"] == "local":
            rel = i["url"].split("/uploads/", 1)[-1]
            abs_path = os.path.join(_settings.STORAGE_LOCAL_PATH, rel)
            try:
                i["size_bytes"] = os.path.getsize(abs_path) if os.path.exists(abs_path) else -1
            except OSError:
                pass

    # ---- summary：全量口径（来源叠加后、筛选前统计）----
    summary = {
        "total": len(items),
        "disabled": sum(1 for i in items if i["disabled"]),
        "image": sum(1 for i in items if i["type"] == "image"),
        "video": sum(1 for i in items if i["type"] == "video"),
        "audio": sum(1 for i in items if i["type"] == "audio"),
        "total_bytes": sum(i.get("size_bytes") or 0 for i in items if (i.get("size_bytes") or 0) > 0),
    }

    if search:
        kw = search.lower()
        items = [i for i in items if kw in i["_search"]]
    if status == "disabled":
        items = [i for i in items if i["disabled"]]
    elif status == "normal":
        items = [i for i in items if not i["disabled"]]
    if source:
        items = [i for i in items if i["source"] == source]

    from datetime import datetime as _dt, timezone as _tz
    _epoch = _dt(1970, 1, 1, tzinfo=_tz.utc)
    items.sort(key=lambda i: i["created_at"] or _epoch, reverse=True)
    total = len(items)
    start = (page - 1) * page_size
    for i in items[start:start + page_size]:
        i.pop("_search", None)
        i["created_at"] = i["created_at"].isoformat() if i["created_at"] else None

    return {
        "items": items[start:start + page_size], "total": total,
        "page": page, "page_size": page_size, "summary": summary,
    }


@router.put("/media")
async def admin_update_media(
    body: dict,  # {url, disabled?: bool, name?: string}
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新媒体属性（按 URL，对所有来源生效）：禁用/启用（本地文件立即 403）、重命名。"""
    url = body.get("url")
    if not url:
        raise BadRequestException("url 必填")

    r = await db.execute(select(MediaState).where(MediaState.url == url))
    state = r.scalar_one_or_none()
    if state is None:
        state = MediaState(url=url[:512])
        db.add(state)

    if "disabled" in body:
        state.disabled = bool(body["disabled"])
    if isinstance(body.get("name"), str):
        state.name = body["name"].strip()[:200] or None

    await db.commit()
    from app.core.media_guard import invalidate_disabled_cache
    invalidate_disabled_cache()
    return {"message": "updated", "disabled": state.disabled, "name": state.name}


@router.post("/media/delete")
async def admin_delete_media(
    body: dict,  # {items: [{source, ref_id, url}, ...]} 支持批量
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """删除媒体：删本地 /uploads 文件或文件服务器远端文件，并移除对应来源记录
    （生成任务→从 output_urls 摘除；素材库→删素材记录；项目资产→删资产记录）。
    生成任务本身保留作审计。"""
    items = body.get("items") or []
    if not items:
        raise BadRequestException("items 不能为空")

    from app.services.storage import get_storage_singleton
    from app.services.file_server import get_file_server_config
    from app.models import MediaState, TeamMaterial, AudioAsset, VideoAsset
    import httpx
    storage = get_storage_singleton()
    fs_base, fs_key = await get_file_server_config()

    async def _delete_backing_file(url: str) -> bool:
        """删除底层文件（本地或文件服务器）；返回是否删除成功"""
        if url.startswith(("/uploads/", "uploads/")):
            try:
                await storage.delete(url)
                return True
            except Exception:
                return False
        if fs_base and url.startswith(fs_base.rstrip("/")):
            path = url[len(fs_base.rstrip("/")):].lstrip("/")
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.delete(
                        f"{fs_base.rstrip('/')}/{path}",
                        headers={"Authorization": f"Bearer {fs_key}"} if fs_key else {},
                    )
                return resp.status_code < 400
            except Exception:
                return False
        return False  # 未知/外部存储

    deleted, unlinked = 0, 0
    for it in items:
        source, ref_id, url = it.get("source"), it.get("ref_id"), it.get("url")
        if not url:
            continue

        file_deleted = await _delete_backing_file(url)
        if file_deleted:
            deleted += 1
        else:
            unlinked += 1

        # ---- 跨来源清理引用：同一 URL 可能被多处引用（画布节点/任务输出/
        # 素材库/项目资产/图片资源主图），全部摘除避免悬挂引用 ----
        refs_cleaned = 0
        try:
            # 1) 生成任务输出（任务记录保留作审计）
            r = await db.execute(select(GenerationTask).where(
                GenerationTask.output_urls.any(url), GenerationTask.deleted_at.is_(None)))
            for task in r.scalars().all():
                task.output_urls = [u for u in (task.output_urls or []) if u != url]
                refs_cleaned += 1
            # 2) 素材库记录
            r = await db.execute(select(TeamMaterial).where(TeamMaterial.url == url))
            for m in r.scalars().all():
                await db.delete(m)
                refs_cleaned += 1
            # 3) 项目音视频资产
            for Model in (AudioAsset, VideoAsset):
                r = await db.execute(select(Model).where(Model.url == url))
                for a in r.scalars().all():
                    await db.delete(a)
                    refs_cleaned += 1
            # 4) 图片资源主图（角色/场景/道具）：只解除绑定，不删资源本身
            for Model in (Character, SceneBackground, Prop):
                r = await db.execute(select(Model).where(Model.image_url == url))
                for obj in r.scalars().all():
                    obj.image_url = None
                    refs_cleaned += 1
            # 5) 画布节点数据：递归摘除该 URL（字符串→None、列表→剔除）
            r = await db.execute(select(Canvas))
            for c in r.scalars().all():
                graph = c.graph_data
                if not isinstance(graph, dict):
                    continue
                if url not in json.dumps(graph, ensure_ascii=False):
                    continue
                c.graph_data = _strip_url_from_json(graph, url)
                refs_cleaned += 1
        except Exception:
            pass  # 引用清理失败不阻断文件删除结果

        # 清理状态记录
        r = await db.execute(select(MediaState).where(MediaState.url == url))
        st = r.scalar_one_or_none()
        if st:
            await db.delete(st)

    await db.commit()
    from app.core.media_guard import invalidate_disabled_cache
    invalidate_disabled_cache()
    return {"message": "ok", "deleted": deleted, "unlinked": unlinked}


# ==================== 任务监控 ====================

@router.get("/tasks")
async def admin_get_tasks(
    page: int = 1,
    page_size: int = 20,
    type: str = None,
    status: str = None,
    model: str = None,
    user_id: str = None,
    search: str = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员监控所有生成任务（含项目名 + 完整参数 + 积分）

    支持类型/状态/模型/创建人筛选 + 模型名/提示词模糊搜索。
    返回分页结构 { items, total, page, page_size, summary }；
    summary 为全量口径统计卡数据（总任务/今日新增/进行中/今日失败）。
    """
    from datetime import datetime, timezone, timedelta

    # 基础查询（带过滤）
    base = select(GenerationTask).where(GenerationTask.deleted_at.is_(None))
    if type:
        base = base.where(GenerationTask.type == type)
    if status:
        base = base.where(GenerationTask.status == status)
    if model:
        base = base.where(GenerationTask.model == model)
    if user_id:
        base = base.join(Project, GenerationTask.project_id == Project.id).where(
            Project.user_id == UUID(user_id)
        )
    if search:
        pattern = f"%{search}%"
        base = base.where(or_(
            GenerationTask.model.ilike(pattern),
            GenerationTask.input_data["prompt"].astext.ilike(pattern),
        ))

    # 先统计满足条件的总数（分页器需要）
    from sqlalchemy import func as sa_func
    count_result = await db.execute(select(sa_func.count()).select_from(base.subquery()))
    total = count_result.scalar() or 0

    # ---- summary：全量口径（不随筛选变化）----
    tz8 = timezone(timedelta(hours=8))
    today_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0)
    _alive = GenerationTask.deleted_at.is_(None)
    summary = {
        "total": (await db.execute(
            select(sa_func.count(GenerationTask.id)).where(_alive)
        )).scalar() or 0,
        "today_new": (await db.execute(
            select(sa_func.count(GenerationTask.id)).where(_alive, GenerationTask.created_at >= today_start)
        )).scalar() or 0,
        "running": (await db.execute(
            select(sa_func.count(GenerationTask.id)).where(
                _alive, GenerationTask.status.in_(("pending", "processing")))
        )).scalar() or 0,
        "today_failed": (await db.execute(
            select(sa_func.count(GenerationTask.id)).where(
                _alive, GenerationTask.status == "failed",
                GenerationTask.created_at >= today_start)
        )).scalar() or 0,
    }

    # 再取当前页数据
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    offset = (page - 1) * page_size
    stmt = base.offset(offset).limit(page_size).order_by(GenerationTask.created_at.desc())
    result = await db.execute(stmt)
    tasks = result.scalars().all()

    # 批量查项目名
    proj_ids = list(set(t.project_id for t in tasks if t.project_id))
    proj_map = {}
    if proj_ids:
        p_result = await db.execute(select(Project).where(Project.id.in_(proj_ids)))
        for p in p_result.scalars().all():
            proj_map[str(p.id)] = p.name

    # 批量查任务创建人（优先 nickname，回退 email）
    user_ids = list(set(t.user_id for t in tasks if t.user_id))
    user_map: Dict[str, str] = {}
    if user_ids:
        from app.models import User
        u_result = await db.execute(select(User).where(User.id.in_(user_ids)))
        for u in u_result.scalars().all():
            user_map[str(u.id)] = u.nickname or u.email

    # 批量补关联：分镜/集数/剧本（scene_id 优先列，历史任务回退 input_data）
    from app.models import Scene, Episode, Script
    scene_map: Dict[str, Any] = {}
    raw_scene_ids = {
        str(t.scene_id or ((t.input_data or {}).get("scene_id") if isinstance(t.input_data, dict) else None))
        for t in tasks
    } - {"None", ""}
    if raw_scene_ids:
        s_result = await db.execute(select(Scene).where(Scene.id.in_(raw_scene_ids)))
        for s in s_result.scalars().all():
            scene_map[str(s.id)] = s
    ep_ids = {str(s.episode_id) for s in scene_map.values() if s.episode_id} | {
        str(t.episode_id) for t in tasks if t.episode_id
    } - {"None"}
    ep_map: Dict[str, Any] = {}
    if ep_ids:
        e_result = await db.execute(select(Episode).where(Episode.id.in_(ep_ids)))
        for e in e_result.scalars().all():
            ep_map[str(e.id)] = e
    script_ids = {str(s.script_id) for s in scene_map.values() if s.script_id} | {
        str(e.script_id) for e in ep_map.values() if e.script_id
    } - {"None"}
    script_map: Dict[str, str] = {}
    if script_ids:
        sc_result = await db.execute(select(Script).where(Script.id.in_(script_ids)))
        for scr in sc_result.scalars().all():
            script_map[str(scr.id)] = scr.title

    def _linkage(t: GenerationTask) -> Dict[str, Any]:
        scene_sequence = episode_number = script_title = None
        sc = scene_map.get(str(t.scene_id or ((t.input_data or {}).get("scene_id") if isinstance(t.input_data, dict) else None) or ""))
        if sc is not None:
            scene_sequence = sc.sequence
        ep = ep_map.get(str(t.episode_id)) if t.episode_id else None
        if ep is None and sc is not None and sc.episode_id:
            ep = ep_map.get(str(sc.episode_id))
        if ep is not None:
            episode_number = ep.number
            if ep.script_id:
                script_title = script_map.get(str(ep.script_id))
        if script_title is None and sc is not None and sc.script_id:
            script_title = script_map.get(str(sc.script_id))
        if script_title is None:
            # 资源生图等任务在 meta 里直接记了来源剧本
            _m = t.meta or {}
            if isinstance(_m, dict) and _m.get("script_title"):
                script_title = _m.get("script_title")
        return {
            "scene_id": str(sc.id) if sc is not None else None,
            "scene_sequence": scene_sequence,
            "episode_number": episode_number,
            "script_title": script_title,
        }

    items = [
        {
            "id": str(t.id),
            "project_id": str(t.project_id) if t.project_id else None,
            "project_name": proj_map.get(str(t.project_id), "-") if t.project_id else "-",
            "user_id": str(t.user_id) if t.user_id else None,
            "user_name": user_map.get(str(t.user_id), "-") if t.user_id else "-",
            "episode_id": str(t.episode_id) if t.episode_id else None,
            **_linkage(t),
            "type": t.type,
            "model": t.model,
            "status": t.status,
            "progress": t.progress,
            "credits_consumed": t.credits_consumed or 0,
            "input_data": t.input_data,
            "output_urls": t.output_urls or [],
            "error_message": t.error_message,
            # 历史 meta.logs 可能含 base64 超长字符串，返回前脱敏避免接口响应过大（曾导致 10s+ 卡顿）
            "meta": _redact_admin_task_meta(t.meta),
            "started_at": t.started_at.isoformat() if t.started_at else None,
            "deleted_at": t.deleted_at.isoformat() if t.deleted_at else None,
            "completed_at": t.completed_at.isoformat() if t.completed_at else None,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        }
        for t in tasks
    ]
    return {"items": items, "total": total, "page": page, "page_size": page_size, "summary": summary}


@router.post("/tasks/cancel-all-pending")
async def cancel_all_pending_tasks(
    user_id: str = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """取消所有未完成任务（pending + processing，可按用户过滤）。

    卡住的任务大多处于 processing（视频任务提交后即为 processing），
    只处理 pending 会漏掉它们；轮询协程会读到 cancelled 状态并自动停止。
    """
    stmt = select(GenerationTask).where(
        GenerationTask.status.in_(["pending", "processing"])
    )

    if user_id:
        stmt = stmt.join(Project, GenerationTask.project_id == Project.id).where(
            Project.user_id == UUID(user_id)
        )

    result = await db.execute(stmt)
    tasks = result.scalars().all()

    count = 0
    for task in tasks:
        task.status = "cancelled"
        count += 1

    await db.commit()
    return {
        "message": f"Cancelled {count} unfinished tasks",
        "cancelled_count": count,
    }


@router.post("/tasks/batch-delete")
async def admin_batch_delete_tasks(
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """批量删除任务记录。

    credit_transactions.task_id 外键为 ON DELETE SET NULL：
    删除任务时关联的积分流水会自动解除关联并保留，不会丢账。
    """
    from sqlalchemy import delete as sa_delete
    ids = body.get("ids") if isinstance(body, dict) else None
    if not isinstance(ids, list) or not ids:
        raise BadRequestException("ids 不能为空")
    uuids = []
    for tid in ids:
        try:
            uuids.append(UUID(str(tid)))
        except (ValueError, AttributeError, TypeError):
            continue
    if not uuids:
        raise BadRequestException("ids 中没有合法的任务 ID")
    result = await db.execute(sa_delete(GenerationTask).where(GenerationTask.id.in_(uuids)))
    await db.commit()
    return {
        "message": f"Deleted {result.rowcount or 0} tasks",
        "deleted_count": result.rowcount or 0,
        "requested": len(ids),
    }


# ==================== 模型配置管理 ====================

def _mask_api_key(key: Optional[str]) -> Optional[str]:
    """api_key 脱敏返回：保留首尾各 4 位，中间打码（过短则整体打码）。

    编辑保存时前端把脱敏值原样传回，PUT 端点检测到 **** 会跳过更新，
    保持原 key 不变；test 端点始终从 DB 读原始 key，不受影响。
    """
    if not key:
        return key
    if len(key) <= 10:
        return "****"
    return f"{key[:4]}****{key[-4:]}"


def _model_config_resp(m: AIModel) -> ModelConfig:
    """模型配置响应统一脱敏 api_key。"""
    return ModelConfig(
        id=m.id, name=m.name, type=m.type, provider=m.provider,
        endpoint=m.endpoint, api_key=_mask_api_key(m.api_key), config=m.config or {},
        is_enabled=m.is_enabled, priority=m.priority,
        cost_per_request=m.cost_per_request, description=m.description,
    )


@router.get("/models", response_model=list[ModelConfig])
async def get_model_configs(
    type: str = None,
    provider: str = None,
    enabled: bool = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取AI模型配置列表(支持按类型/提供方/启用状态筛选；api_key 脱敏返回)"""
    stmt = select(AIModel)

    if type:
        stmt = stmt.where(AIModel.type == type)
    if provider:
        stmt = stmt.where(AIModel.provider == provider)
    if enabled is not None:
        stmt = stmt.where(AIModel.is_enabled == enabled)

    stmt = stmt.order_by(AIModel.priority.desc(), AIModel.created_at.desc())
    result = await db.execute(stmt)
    models = result.scalars().all()

    return [_model_config_resp(m) for m in models]


@router.post("/models", response_model=ModelConfig, status_code=201)
async def create_model_config(
    body: AIModelCreate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """创建模型配置"""
    model = AIModel(
        name=body.name,
        type=body.type,
        provider=body.provider,
        endpoint=body.endpoint,
        api_key=body.api_key,
        config=body.config or {},
        is_enabled=body.is_enabled,
        priority=body.priority,
        cost_per_request=body.cost_per_request,
        description=body.description,
    )
    db.add(model)
    await db.commit()
    await db.refresh(model)
    invalidate_adapter_cache()  # 让新配置立即生效

    return _model_config_resp(model)


@router.put("/models/{model_id}", response_model=ModelConfig)
async def update_model_config(
    model_id: str,
    body: AIModelUpdate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新模型配置(API Key、参数等)

    api_key 传入值含 ****（脱敏值原样回传）时跳过更新，保持原 key；
    需要换 key 时输入完整新值即可。
    """
    result = await db.execute(select(AIModel).where(AIModel.id == model_id))
    model = result.scalar_one_or_none()

    if not model:
        raise NotFoundException("Model not found")

    update_data = body.model_dump(exclude_unset=True)
    if isinstance(update_data.get("api_key"), str) and "****" in update_data["api_key"]:
        update_data.pop("api_key")
    for field, value in update_data.items():
        setattr(model, field, value)

    # JSONB 字段需要显式标记变更（SQLAlchemy 对 JSONB 的变更检测有限）
    if "config" in update_data:
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(model, "config")

    await db.commit()
    await db.refresh(model)
    invalidate_adapter_cache()  # 让更新后的配置立即生效

    return _model_config_resp(model)


@router.delete("/models/{model_id}")
async def delete_model_config(
    model_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """删除模型配置"""
    result = await db.execute(select(AIModel).where(AIModel.id == model_id))
    model = result.scalar_one_or_none()

    if not model:
        raise NotFoundException("Model not found")

    await db.delete(model)
    await db.commit()
    invalidate_adapter_cache()  # 让删除后的配置立即生效
    return {"message": "Model deleted", "model_id": model_id}


@router.post("/models/{model_id}/test")
async def test_model_connection(
    model_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """测试模型连接是否正常。智谱模型会发起真实最小请求验证 API Key 有效性。"""
    result = await db.execute(select(AIModel).where(AIModel.id == model_id))
    model = result.scalar_one_or_none()

    if not model:
        raise NotFoundException("Model not found")

    # 智谱：发起真实连通测试（用最快方式：cogview-3-flash + standard，约 8 秒）
    if model.provider in ("zhipu", "glm"):
        try:
            from app.adapters.zhipu_adapter import ZhipuAdapter
            adapter = ZhipuAdapter({
                "provider": model.provider,
                "type": model.type,
                "endpoint": model.endpoint,
                "api_key": model.api_key,
                "config": model.config or {},
            })
            if not adapter.api_key:
                return {"status": "failed", "message": "API Key 未配置"}
            # test_connection 内部会用最快方式（cogview-3-flash + standard）验证 API Key
            ok = await adapter.test_connection()
            if ok:
                return {"status": "success",
                        "message": f"智谱 {model.name} 连接正常（API Key 有效，测试用时约 8 秒）"}
            return {"status": "failed",
                    "message": f"连接失败，请检查 API Key 和端点（base={adapter.base_url}）"}
        except Exception as e:
            return {"status": "failed", "message": f"智谱测试异常: {str(e)[:200]}"}

    # MiniMax 系列（官方 / 优云智算 CompShare 渠道）：用假 task_id 探测鉴权（非 401 即 Key 有效）
    if model.provider in ("minimax", "h3", "hailuo",
                          "minimax_compshare", "minimax-compshare", "compshare"):
        try:
            from app.adapters.factory import get_adapter
            adapter = get_adapter({
                "provider": model.provider,
                "type": model.type,
                "endpoint": model.endpoint,
                "api_key": model.api_key,
                "config": model.config or {},
            })
            if not getattr(adapter, "api_key", None):
                return {"status": "failed", "message": "API Key 未配置"}
            ok = await adapter.test_connection()
            if ok:
                return {"status": "success",
                        "message": f"{model.name} 连接正常（API Key 鉴权通过，base={adapter.base_url}）"}
            return {"status": "failed",
                    "message": f"连接失败，请检查 API Key 和端点（base={getattr(adapter, 'base_url', '')}）"}
        except Exception as e:
            return {"status": "failed", "message": f"测试异常: {str(e)[:200]}"}

    # LLM（非智谱）：走 LLMClient 测试
    if model.type == "llm":
        return {"status": "success", "message": f"LLM {model.name} 配置已保存，将在 Agent 调用时验证"}

    # 基础联通性判断：配置了端点或本地模型即视为可连通
    if model.provider == "local" or (model.endpoint and model.endpoint.startswith("http")):
        return {"status": "success", "message": f"模型 {model.name} 配置有效"}

    return {
        "status": "failed",
        "message": "模型未配置有效的端点 URL，请检查端点设置",
    }


# ==================== 提示词模板管理 ====================

def _pt_to_response(pt: PromptTemplate) -> PromptTemplateResponse:
    return PromptTemplateResponse(
        id=pt.id, name=pt.name, category=pt.category, mode=pt.mode,
        content=pt.content, description=pt.description,
        variables=pt.variables or {}, is_enabled=pt.is_enabled,
        is_default=pt.is_default, priority=pt.priority,
    )


@router.get("/prompt-templates", response_model=list[PromptTemplateResponse])
async def list_prompt_templates(
    category: str = None,
    mode: str = None,
    enabled: bool = None,
    search: str = None,   # 名称/内容模糊
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取提示词模板列表（支持按分类/模式/启用状态筛选 + 搜索）"""
    stmt = select(PromptTemplate)
    if category:
        stmt = stmt.where(PromptTemplate.category == category)
    if mode:
        stmt = stmt.where(PromptTemplate.mode == mode)
    if enabled is not None:
        stmt = stmt.where(PromptTemplate.is_enabled == enabled)
    if search:
        pat = f"%{search}%"
        stmt = stmt.where(or_(PromptTemplate.name.ilike(pat), PromptTemplate.content.ilike(pat)))
    stmt = stmt.order_by(PromptTemplate.priority.desc(), PromptTemplate.created_at.desc())
    result = await db.execute(stmt)
    return [_pt_to_response(pt) for pt in result.scalars().all()]


@router.post("/prompt-templates", response_model=PromptTemplateResponse, status_code=201)
async def create_prompt_template(
    body: PromptTemplateCreate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """创建提示词模板。若 is_default=True，自动取消同 category+mode 下其它模板的默认标记。"""
    if body.is_default:
        await _clear_default_flag(db, body.category, body.mode)
    pt = PromptTemplate(
        name=body.name, category=body.category, mode=body.mode,
        content=body.content, description=body.description,
        variables=body.variables or {}, is_enabled=body.is_enabled,
        is_default=body.is_default, priority=body.priority,
    )
    db.add(pt)
    await db.commit()
    await db.refresh(pt)
    return _pt_to_response(pt)


@router.put("/prompt-templates/{template_id}", response_model=PromptTemplateResponse)
async def update_prompt_template(
    template_id: str,
    body: PromptTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新提示词模板"""
    result = await db.execute(select(PromptTemplate).where(PromptTemplate.id == template_id))
    pt = result.scalar_one_or_none()
    if not pt:
        raise NotFoundException("Prompt template not found")

    update_data = body.model_dump(exclude_unset=True)
    # 若改为默认，先清除同分类下的其它默认
    if update_data.get("is_default"):
        new_cat = update_data.get("category", pt.category)
        new_mode = update_data.get("mode", pt.mode)
        await _clear_default_flag(db, new_cat, new_mode, exclude_id=template_id)

    for field, value in update_data.items():
        setattr(pt, field, value)
    if "variables" in update_data:
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(pt, "variables")

    await db.commit()
    await db.refresh(pt)
    return _pt_to_response(pt)


@router.delete("/prompt-templates/{template_id}")
async def delete_prompt_template(
    template_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """删除提示词模板"""
    result = await db.execute(select(PromptTemplate).where(PromptTemplate.id == template_id))
    pt = result.scalar_one_or_none()
    if not pt:
        raise NotFoundException("Prompt template not found")
    await db.delete(pt)
    await db.commit()
    return {"message": "Prompt template deleted", "template_id": template_id}


@router.post("/prompt-templates/{template_id}/duplicate", response_model=PromptTemplateResponse, status_code=201)
async def duplicate_prompt_template(
    template_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """复制提示词模板（基于现有模板微调的常见操作）"""
    result = await db.execute(select(PromptTemplate).where(PromptTemplate.id == template_id))
    src = result.scalar_one_or_none()
    if not src:
        raise NotFoundException("Prompt template not found")
    copy = PromptTemplate(
        id=str(uuid4()),
        name=f"{src.name}（副本）",
        category=src.category,
        mode=src.mode,
        content=src.content,
        description=src.description,
        variables=src.variables,
        is_enabled=False,   # 副本默认禁用，避免抢占默认选用
        is_default=False,
        priority=src.priority,
    )
    db.add(copy)
    await db.commit()
    await db.refresh(copy)
    return _pt_to_response(copy)


# ==================== 积分计价规则 ====================

async def _pricing_to_response(p: CreditPricing, model_name_map: Dict[str, str] = None) -> PricingResponse:
    model_name_map = model_name_map or {}
    return PricingResponse(
        id=str(p.id),
        ai_model_id=str(p.ai_model_id) if p.ai_model_id else None,
        ai_model_name=model_name_map.get(str(p.ai_model_id)) if p.ai_model_id else None,
        task_type=p.task_type,
        resolution=p.resolution,
        size=p.size,
        billing_mode=p.billing_mode,
        credits=p.credits,
        priority=p.priority,
        is_enabled=p.is_enabled,
        note=p.note,
        created_at=p.created_at.isoformat() if p.created_at else None,
        updated_at=p.updated_at.isoformat() if p.updated_at else None,
    )


async def _resolve_model_names(db: AsyncSession, rules: List[CreditPricing]) -> Dict[str, str]:
    """批量取规则关联的 AIModel 名字，便于前端展示。"""
    mids = list({str(r.ai_model_id) for r in rules if r.ai_model_id})
    name_map: Dict[str, str] = {}
    if mids:
        mr = await db.execute(select(AIModel).where(AIModel.id.in_(mids)))
        for m in mr.scalars().all():
            name_map[str(m.id)] = m.name
    return name_map


@router.get("/pricing", response_model=List[PricingResponse])
async def list_pricing(
    task_type: str = None,
    ai_model_id: str = None,
    enabled: bool = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取计价规则列表（支持按任务类型/模型/启用状态筛选）"""
    stmt = select(CreditPricing)
    if task_type:
        stmt = stmt.where(CreditPricing.task_type == task_type)
    if ai_model_id:
        stmt = stmt.where(CreditPricing.ai_model_id == ai_model_id)
    if enabled is not None:
        stmt = stmt.where(CreditPricing.is_enabled == enabled)
    stmt = stmt.order_by(
        CreditPricing.task_type.asc(), CreditPricing.priority.desc(), CreditPricing.created_at.desc()
    )
    result = await db.execute(stmt)
    rules = result.scalars().all()
    name_map = await _resolve_model_names(db, rules)
    return [await _pricing_to_response(r, name_map) for r in rules]


@router.post("/pricing", response_model=PricingResponse, status_code=201)
async def create_pricing(
    body: PricingCreate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """创建计价规则"""
    p = CreditPricing(
        ai_model_id=body.ai_model_id or None,
        task_type=body.task_type,
        resolution=body.resolution or None,
        size=body.size or None,
        billing_mode=body.billing_mode or "fixed",
        credits=body.credits,
        priority=body.priority,
        is_enabled=body.is_enabled,
        note=body.note,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    name_map = await _resolve_model_names(db, [p])
    return await _pricing_to_response(p, name_map)


@router.put("/pricing/{pricing_id}", response_model=PricingResponse)
async def update_pricing(
    pricing_id: str,
    body: PricingUpdate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新计价规则"""
    result = await db.execute(select(CreditPricing).where(CreditPricing.id == pricing_id))
    p = result.scalar_one_or_none()
    if not p:
        raise NotFoundException("Pricing rule not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "ai_model_id":
            value = value or None
        setattr(p, field, value)
    await db.commit()
    await db.refresh(p)
    name_map = await _resolve_model_names(db, [p])
    return await _pricing_to_response(p, name_map)


@router.delete("/pricing/{pricing_id}")
async def delete_pricing(
    pricing_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """删除计价规则"""
    result = await db.execute(select(CreditPricing).where(CreditPricing.id == pricing_id))
    p = result.scalar_one_or_none()
    if not p:
        raise NotFoundException("Pricing rule not found")
    await db.delete(p)
    await db.commit()
    return {"message": "Pricing rule deleted", "pricing_id": pricing_id}


@router.post("/pricing/{pricing_id}/duplicate", response_model=PricingResponse, status_code=201)
async def duplicate_pricing(
    pricing_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """复制计价规则（同模型不同分辨率/尺寸挨个配置的高频场景）"""
    result = await db.execute(select(CreditPricing).where(CreditPricing.id == pricing_id))
    src = result.scalar_one_or_none()
    if not src:
        raise NotFoundException("Pricing rule not found")
    copy = CreditPricing(
        ai_model_id=src.ai_model_id,
        task_type=src.task_type,
        resolution=src.resolution,
        size=src.size,
        billing_mode=src.billing_mode,
        credits=src.credits,
        priority=src.priority,
        is_enabled=False,  # 副本默认禁用，改完再启用避免抢占命中
        note=(src.note or "") + "（副本）" if src.note else "副本",
    )
    db.add(copy)
    await db.commit()
    await db.refresh(copy)
    return await _pricing_to_response(copy)


@router.post("/pricing/batch-delete")
async def batch_delete_pricing(
    body: dict,   # {"ids": [...]}
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """批量删除计价规则"""
    ids = body.get("ids") or []
    if not ids:
        raise BadRequestException("ids 不能为空")
    result = await db.execute(select(CreditPricing).where(CreditPricing.id.in_(ids)))
    rules = result.scalars().all()
    for r in rules:
        await db.delete(r)
    await db.commit()
    return {"message": f"已删除 {len(rules)} 条规则", "deleted": len(rules)}


class PricingEstimateRequest(BaseModel):
    """命中测试入参：模拟一次任务提交，看命中哪条规则、扣多少积分"""
    task_type: str
    ai_model_id: Optional[str] = None
    resolution: Optional[str] = None
    size: Optional[str] = None
    duration: int = 5


@router.post("/pricing/estimate")
async def estimate_pricing(
    body: PricingEstimateRequest,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """命中测试：按给定参数跑一遍算价，返回命中的规则与积分数。

    用于配完规则后立即验证命中逻辑是否正确（与任务扣费同一条 resolve_cost 链路）。
    """
    from app.services.pricing_service import resolve_cost, normalize_resolution
    cost = await resolve_cost(
        db, body.task_type,
        model_id=UUID(body.ai_model_id) if body.ai_model_id else None,
        params={"resolution": body.resolution, "size": body.size, "duration": body.duration},
    )
    return {
        "cost": cost,
        "matched": cost is not None,
        "task_type": body.task_type,
        "resolution": normalize_resolution(body.resolution) if body.resolution else None,
        "size": body.size,
        "duration": body.duration,
        "hint": "未命中任何启用规则，任务将回退内置默认价" if cost is None else None,
    }


async def _clear_default_flag(db: AsyncSession, category: str, mode: str, exclude_id: str = None):
    """清除指定 category+mode 下其它模板的 is_default 标记（保证唯一默认）。"""
    stmt = select(PromptTemplate).where(
        PromptTemplate.category == category,
        PromptTemplate.mode == mode,
        PromptTemplate.is_default == True,  # noqa: E712
    )
    if exclude_id:
        stmt = stmt.where(PromptTemplate.id != exclude_id)
    result = await db.execute(stmt)
    for other in result.scalars().all():
        other.is_default = False


# ==================== 系统设置 ====================

@router.get("/settings", response_model=dict)
async def get_system_settings(
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取系统设置"""
    from app.models import SystemSettings

    result = await db.execute(select(SystemSettings))
    settings_list = result.scalars().all()

    return {s.key: s.value for s in settings_list}


@router.put("/settings")
async def update_system_settings(
    body: SystemSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新系统设置"""
    from app.models import SystemSettings

    for key, value in body.settings.items():
        result = await db.execute(
            select(SystemSettings).where(SystemSettings.key == key)
        )
        setting = result.scalar_one_or_none()

        if setting:
            setting.value = value
        else:
            new_setting = SystemSettings(key=key, value=value)
            db.add(new_setting)

    await db.commit()
    # 清缓存让新设置立即生效
    from app.services.settings_service import invalidate_cache as invalidate_settings_cache
    invalidate_settings_cache()
    return {"message": "Settings updated successfully"}


class FileServerTestRequest(BaseModel):
    """文件服务器连通性测试请求（不传则用已保存/环境变量配置）"""
    url: Optional[str] = None
    api_key: Optional[str] = None


@router.post("/settings/file-server/test")
async def test_file_server(
    body: FileServerTestRequest,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """测试文件服务器连通性：healthz + 小文件上传/下载/删除全链路。"""
    import httpx

    url = (body.url or "").strip()
    api_key = (body.api_key or "").strip()
    if not url:
        # 未传则用已保存的设置（DB 优先，回退 .env）
        from app.services.file_server import get_file_server_config
        url, api_key = await get_file_server_config()
    if not url:
        return {"status": "failed", "message": "未配置文件服务器地址（也不存在环境变量兜底）"}

    base = url.rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            # 1) 健康检查
            hz = await client.get(f"{base}/healthz")
            if hz.status_code != 200:
                return {"status": "failed", "message": f"健康检查失败：HTTP {hz.status_code}"}

            # 2) 鉴权上传小文件
            probe = b"\x00\x00\x00\x20ftypisom" + b"probe" * 100
            up = await client.post(f"{base}/upload",
                                   files={"file": ("probe-test.mp4", probe, "video/mp4")},
                                   headers=headers)
            if up.status_code == 401:
                return {"status": "failed", "message": "API Key 无效（上传返回 401）"}
            if up.status_code != 200:
                return {"status": "failed", "message": f"上传失败：HTTP {up.status_code} {up.text[:100]}"}
            up_data = up.json()
            file_url = up_data.get("url") or ""
            if not file_url.startswith(("http://", "https://")):
                file_url = base + "/" + file_url.lstrip("/")
            path = up_data.get("path") or file_url.split("/files/", 1)[-1]

            # 3) 公开下载（渠道拉取不带鉴权，必须可匿名访问）
            dl = await client.get(file_url)
            dl_ok = dl.status_code == 200 and len(dl.content) == len(probe)

            # 4) 清理探针文件
            try:
                await client.delete(f"{base}/files/{path}", headers=headers)
            except Exception:
                pass

        if not dl_ok:
            return {"status": "failed", "message": f"文件直链下载失败（HTTP {dl.status_code}），请检查公网可达性"}
        return {"status": "success",
                "message": f"连通正常：上传/直链下载/鉴权全部通过（直链 {file_url}）"}
    except Exception as e:
        return {"status": "failed", "message": f"连接失败: {str(e)[:150]}"}


# ==================== ComfyUI 工作流库 (M8) ====================

class ComfyWorkflowCreate(BaseModel):
    name: str
    description: Optional[str] = None
    graph: Dict[str, Any]


class ComfyWorkflowUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_enabled: Optional[bool] = None


@router.get("/comfyui-workflows", response_model=list)
async def list_comfy_workflows(
    search: str = None,
    format: str = None,       # ui / api
    enabled: bool = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """ComfyUI 工作流列表（含解析元信息摘要；支持搜索/格式/状态筛选）"""
    stmt = select(ComfyUIWorkflow)
    if search:
        pat = f"%{search}%"
        stmt = stmt.where(or_(
            ComfyUIWorkflow.name.ilike(pat),
            ComfyUIWorkflow.description.ilike(pat),
        ))
    if format:
        stmt = stmt.where(ComfyUIWorkflow.format == format)
    if enabled is not None:
        stmt = stmt.where(ComfyUIWorkflow.is_enabled == enabled)
    rows = (await db.execute(
        stmt.order_by(ComfyUIWorkflow.created_at.desc())
    )).scalars().all()
    return [
        {
            "id": str(w.id), "name": w.name, "description": w.description,
            "format": w.format, "node_count": w.node_count,
            "is_enabled": w.is_enabled,
            "models": (w.meta or {}).get("models", []),
            "sampler": (w.meta or {}).get("sampler"),
            "created_at": w.created_at.isoformat() if w.created_at else None,
        }
        for w in rows
    ]


@router.post("/comfyui-workflows", status_code=201)
async def import_comfy_workflow(
    body: ComfyWorkflowCreate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """导入 ComfyUI 工作流 JSON（自动识别 UI/API 格式并解析校验）"""
    from app.services.comfyui_workflow import detect_format, parse_workflow
    fmt = detect_format(body.graph)
    if fmt is None:
        raise BadRequestException(
            "无法识别的工作流格式：应为 ComfyUI 编辑器导出的 UI 格式"
            "（含 nodes/links）或 API 格式（节点id→{class_type,inputs}）")
    meta = parse_workflow(body.graph, fmt)
    node_count = len(meta["node_types"]) and sum(meta["node_types"].values()) or (
        len(body.graph) if fmt == "api" else len(body.graph.get("nodes", [])))
    wf = ComfyUIWorkflow(
        name=body.name.strip()[:120] or "未命名工作流",
        description=body.description,
        format=fmt, graph=body.graph, meta=meta, node_count=node_count,
    )
    db.add(wf)
    await db.commit()
    await db.refresh(wf)
    return {"id": str(wf.id), "name": wf.name, "format": fmt,
            "node_count": node_count, "meta": meta}


@router.get("/comfyui-workflows/{wf_id}")
async def get_comfy_workflow(
    wf_id: UUID,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """工作流详情（原 JSON + 元信息 + 两种格式的导出预览）"""
    from app.services.comfyui_workflow import build_export
    wf = await db.get(ComfyUIWorkflow, wf_id)
    if not wf:
        raise NotFoundException("工作流不存在")
    api_payload, warnings = build_export(wf.format, wf.graph)
    return {
        "id": str(wf.id), "name": wf.name, "description": wf.description,
        "format": wf.format, "node_count": wf.node_count,
        "is_enabled": wf.is_enabled, "meta": wf.meta,
        "graph": wf.graph,
        "api_preview": api_payload,
        "convert_warnings": warnings,
        "created_at": wf.created_at.isoformat() if wf.created_at else None,
    }


@router.put("/comfyui-workflows/{wf_id}")
async def update_comfy_workflow(
    wf_id: UUID,
    body: ComfyWorkflowUpdate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    wf = await db.get(ComfyUIWorkflow, wf_id)
    if not wf:
        raise NotFoundException("工作流不存在")
    if body.name is not None:
        wf.name = body.name.strip()[:120] or wf.name
    if body.description is not None:
        wf.description = body.description
    if body.is_enabled is not None:
        wf.is_enabled = body.is_enabled
    await db.commit()
    return {"message": "updated"}


@router.delete("/comfyui-workflows/{wf_id}")
async def delete_comfy_workflow(
    wf_id: UUID,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    wf = await db.get(ComfyUIWorkflow, wf_id)
    if not wf:
        raise NotFoundException("工作流不存在")
    await db.delete(wf)
    await db.commit()
    return {"message": "deleted"}


@router.get("/comfyui-workflows/{wf_id}/export")
async def export_comfy_workflow(
    wf_id: UUID,
    format: str = "api",
    prompt: Optional[str] = None,
    negative: Optional[str] = None,
    seed: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    model: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """导出工作流。

    format=api（默认）：可直接执行的 /prompt 载荷（UI 格式自动转换；
      占位符 {{prompt}}/{{negative}}/{{seed}}/{{width}}/{{height}}/{{model}}
      按查询参数替换，未传的占位符原样保留）
    format=ui：原始 UI 格式（可直接加载进 ComfyUI 编辑器）
    """
    from app.services.comfyui_workflow import build_export
    from fastapi.responses import JSONResponse
    import re as _re
    wf = await db.get(ComfyUIWorkflow, wf_id)
    if not wf:
        raise NotFoundException("工作流不存在")
    overrides = {k: v for k, v in {
        "prompt": prompt, "negative": negative, "seed": seed,
        "width": width, "height": height, "model": model}.items() if v is not None}
    # HTTP 头只接受 latin-1，文件名去非 ASCII（中文名走 filename* 亦可，这里取简）
    safe_name = _re.sub(r"[^A-Za-z0-9_-]+", "_", wf.name).strip("_") or "workflow"
    if format == "ui":
        return JSONResponse(wf.graph, headers={
            "Content-Disposition": f'attachment; filename="{safe_name}-ui.json"'})
    payload, _warnings = build_export(wf.format, wf.graph, overrides or None)
    return JSONResponse(payload, headers={
        "Content-Disposition": f'attachment; filename="{safe_name}-api.json"'})


# ==================== 系统日志 ====================

@router.get("/logs", response_model=list)
async def get_system_logs(
    level: str = None,   # 兼容参数：审计日志无级别，忽略
    source: str = None,  # 兼容参数：语义等同 action（操作类型过滤）
    action: str = None,  # edit/reset_password/disable/enable/role_change/invite/credits_allocate
    start_time: str = None,
    end_time: str = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """系统操作日志：operation_logs 审计表（成员管理/角色/密码/积分分配等）。

    start_time/end_time 为 ISO 格式；limit 上限 500。
    """
    from datetime import datetime
    from app.models import OperationLog

    stmt = select(OperationLog)
    act = action or source
    if act:
        stmt = stmt.where(OperationLog.action == act)
    try:
        if start_time:
            stmt = stmt.where(OperationLog.created_at >= datetime.fromisoformat(start_time))
        if end_time:
            stmt = stmt.where(OperationLog.created_at <= datetime.fromisoformat(end_time))
    except ValueError:
        raise BadRequestException("start_time/end_time 需为 ISO 时间格式")
    stmt = stmt.order_by(OperationLog.created_at.desc()).limit(min(max(1, limit), 500))
    rows = (await db.execute(stmt)).scalars().all()
    if not rows:
        return []

    # 批量补齐操作人/被操作人信息
    uids = {r.operator_id for r in rows if r.operator_id} | {r.target_user_id for r in rows if r.target_user_id}
    users = {}
    if uids:
        rs = await db.execute(select(User).where(User.id.in_(uids)))
        users = {u.id: u for u in rs.scalars().all()}

    def _brief(uid):
        u = users.get(uid)
        return {"email": u.email, "nickname": u.nickname} if u else None

    return [
        {
            "id": str(r.id),
            "action": r.action,
            "detail": r.detail,
            "meta": r.meta or {},
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "org_id": str(r.org_id) if r.org_id else None,
            "operator": _brief(r.operator_id),
            "target_user": _brief(r.target_user_id),
        }
        for r in rows
    ]


# ==================== 存储管理 ====================

async def _collect_referenced_upload_paths(db: AsyncSession) -> set:
    """收集所有仍被数据库引用的本地 /uploads 相对路径。

    保守全集（宁多勿漏，多查几处也不能把在用文件判成孤儿）：
    生成任务输出+输入参数（含软删除的审计记录）、分镜生成结果/封面/meta、
    角色主图+多图列表、场景/道具主图、音视频资产、素材库、画布 graph_data、
    集成片封面/meta、作品画廊封面+视频、禁用状态表（禁用≠可删）。
    """
    refs: set = set()

    def _add(url):
        if not isinstance(url, str) or not url:
            return
        if url.startswith("/uploads/"):
            refs.add(url[len("/uploads/"):])
        elif url.startswith("uploads/"):
            refs.add(url[len("uploads/"):])

    def _walk_json(value):
        urls: list = []
        _collect_media_urls(value, urls)
        for u in urls:
            _add(u)

    from app.models import Scene, Episode

    # 生成任务：输出 + 输入参数
    rs = await db.execute(select(GenerationTask))
    for t in rs.scalars().all():
        for u in (t.output_urls or []):
            _add(u)
        if isinstance(t.input_data, dict):
            _walk_json(t.input_data)

    # 分镜：生成视频/封面/meta
    rs = await db.execute(select(Scene))
    for s in rs.scalars().all():
        _add(s.generated_video_url)
        _add(s.thumbnail_url)
        _walk_json(s.meta or {})

    # 角色（主图+多图列表）/场景/道具（主图）+ meta 兜底
    for Model, with_images in ((Character, True), (SceneBackground, False), (Prop, False)):
        rs = await db.execute(select(Model))
        for o in rs.scalars().all():
            _add(o.image_url)
            if with_images and isinstance(o.images, list):
                for u in o.images:
                    _add(u)
            _walk_json(o.meta or {})

    # 音视频资产 / 素材库
    for Model in (AudioAsset, VideoAsset, TeamMaterial):
        rs = await db.execute(select(Model))
        for o in rs.scalars().all():
            _add(o.url)

    # 画布 graph_data 递归
    rs = await db.execute(select(Canvas))
    for c in rs.scalars().all():
        _walk_json(c.graph_data or {})

    # 集成片封面/meta、作品画廊封面+视频
    rs = await db.execute(select(Episode))
    for e in rs.scalars().all():
        _add(e.cover_image_url)
        _walk_json(e.meta or {})
    rs = await db.execute(select(Work))
    for w in rs.scalars().all():
        _add(w.video_url)
        _add(w.cover_url)

    # 禁用状态表：禁用中的文件不能当孤儿删（管理员可能重新启用）
    rs = await db.execute(select(MediaState))
    for m in rs.scalars().all():
        _add(m.url)

    return refs


@router.get("/storage/stats")
async def get_storage_stats(
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取存储使用统计：本地 uploads 目录（按类别）+ 文件服务器（已配置时）。"""
    from app.services.asset_downloader import get_local_storage_stats

    local = get_local_storage_stats()

    file_server: Dict[str, Any] = {"configured": False}
    try:
        from app.services.file_server import get_file_server_config
        import httpx
        base, key = await get_file_server_config()
        if base:
            file_server = {"configured": True, "url": base}
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{base.rstrip('/')}/stats", headers=headers)
                if resp.status_code == 200:
                    file_server["stats"] = resp.json()
                else:
                    file_server["error"] = f"HTTP {resp.status_code}"
    except Exception as e:
        file_server["error"] = str(e)[:150]

    return {"local": local, "file_server": file_server}


@router.post("/storage/cleanup")
async def cleanup_orphaned_files(
    dry_run: bool = True,
    min_age_hours: int = 24,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """扫描（默认）或清理本地 uploads 中的孤立文件。

    孤立 = 文件存在于 uploads 目录但无任何数据库引用（全来源比对，见
    _collect_referenced_upload_paths）。判定保守：任一来源引用即保留；
    刚落盘不足 min_age_hours 的文件一律跳过（避免误删上传/生成中的在途文件）；
    dry_run=True 只返回清单不删文件。
    """
    import time
    from app.core.config import settings as _settings

    base = _settings.STORAGE_LOCAL_PATH
    refs = await _collect_referenced_upload_paths(db)
    cutoff = time.time() - max(1, min_age_hours) * 3600

    orphans: list = []
    for root, _dirs, files in os.walk(base):
        for f in files:
            abs_p = os.path.join(root, f)
            rel = os.path.relpath(abs_p, base).replace("\\", "/")
            if rel in refs:
                continue
            try:
                st = os.stat(abs_p)
                if st.st_mtime > cutoff:
                    continue  # 在途新文件，跳过
                orphans.append((rel, st.st_size))
            except OSError:
                continue

    total_bytes = sum(s for _, s in orphans)
    result: Dict[str, Any] = {
        "orphan_count": len(orphans),
        "total_size_mb": round(total_bytes / 1048576, 2),
        "files": [{"path": p, "size_mb": round(s / 1048576, 2)} for p, s in orphans[:500]],
    }

    if dry_run:
        return {"dry_run": True, **result}

    deleted = errors = 0
    freed_bytes = 0
    for p, s in orphans:
        try:
            os.remove(os.path.join(base, p))
            deleted += 1
            freed_bytes += s
        except OSError:
            errors += 1
    return {"dry_run": False, "deleted": deleted, "errors": errors,
            "freed_mb": round(freed_bytes / 1048576, 2), **result}


# ==================== 积分管理 (M1) ====================

@router.get("/credits/accounts")
async def list_credit_accounts(
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """所有团队的积分账户列表（含团队名，供管理后台展示）"""
    # join Organization 拿到团队名，避免前端只能展示 org_id 截断
    stmt = (
        select(CreditAccount, Organization)
        .outerjoin(Organization, CreditAccount.org_id == Organization.id)
        .order_by(CreditAccount.created_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()
    return [
        {
            "id": str(acc.id),
            "org_id": str(acc.org_id),
            "org_name": org.name if org else "-",
            "is_personal": org.is_personal if org else False,
            "balance": acc.balance,
            "allocated": acc.allocated,
            "total_recharged": acc.total_recharged,
            "total_consumed": acc.total_consumed,
        }
        for acc, org in rows
    ]


@router.post("/credits/{org_id}/recharge", response_model=CreditAccountResponse)
async def recharge_credits(
    org_id: UUID,
    body: CreditRechargeRequest,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """手动给团队充值积分"""
    from app.services.credit_service import recharge
    # 校验团队存在
    result = await db.execute(select(Organization).where(Organization.id == org_id))
    org = result.scalar_one_or_none()
    if org is None:
        raise NotFoundException("Organization not found", resource="Organization")

    account = await recharge(db, org_id, body.amount, operator_id=admin.id, remark=body.remark)
    return account


@router.get("/credits/transactions")
async def list_all_transactions(
    org_id: UUID | None = None,
    type: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """全局积分流水(可按团队/类型筛选，含团队名)"""
    # join Organization 拿团队名，前端直接展示中文团队名
    stmt = (
        select(CreditTransaction, Organization)
        .outerjoin(Organization, CreditTransaction.org_id == Organization.id)
    )
    if org_id is not None:
        stmt = stmt.where(CreditTransaction.org_id == org_id)
    if type is not None:
        stmt = stmt.where(CreditTransaction.type == type)
    stmt = stmt.order_by(CreditTransaction.created_at.desc()).limit(min(limit, 500))
    result = await db.execute(stmt)
    rows = result.all()
    return [
        {
            "id": str(tx.id),
            "org_id": str(tx.org_id),
            "org_name": org.name if org else "-",
            "is_personal": org.is_personal if org else False,
            "user_id": str(tx.user_id) if tx.user_id else None,
            "project_id": str(tx.project_id) if tx.project_id else None,
            "task_id": str(tx.task_id) if tx.task_id else None,
            "type": tx.type,
            "amount": tx.amount,
            "balance_after": tx.balance_after,
            "model": tx.model,
            "remark": tx.remark,
            "created_at": tx.created_at.isoformat() if tx.created_at else None,
        }
        for tx, org in rows
    ]


# ==================== 本地存储统计 ====================

@router.get("/storage-stats")
async def get_local_storage_stats(
    admin=Depends(get_current_admin_user),
):
    """获取本地 uploads 目录的存储统计 (仅 admin).

    返回各类别 (image/video/audio) 的文件数与总大小 (MB), 以及合计大小.
    用于监控 AI 生成产物落盘占用. 用 os.scandir 遍历, 不访问数据库.
    """
    from app.services.asset_downloader import get_local_storage_stats as _stats

    return _stats()
