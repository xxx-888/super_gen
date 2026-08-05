"""
Team Service - 团队管理业务逻辑 (M2)

职责:
- 成员管理: 邀请/编辑/重置密码/禁用/角色变更/操作日志
- 成员组 / 权限组 CRUD
- 数据看板: 积分趋势 / 项目积分排行 / 人员积分排行
- 积分统计: 按日期/项目/账号维度
- 企业素材库权限矩阵: 设置/批量设置 (含级联规则)
"""
from uuid import UUID
from datetime import datetime, date, timedelta
from typing import Optional, List, Dict, Any
from sqlalchemy import select, func, and_, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.exceptions import (
    NotFoundException, BadRequestException, ForbiddenException, ConflictException,
)
from app.core.security import get_password_hash
from app.models import (
    User, Organization, Membership, MemberGroup, PermissionGroup,
    OperationLog, TeamMaterialPermission,
    Project, CreditAccount, CreditTransaction, CreditAllocation,
)


# ==================== 成员管理 ====================

async def list_members(
    db: AsyncSession, org_id: UUID,
    search: Optional[str] = None,
    project_id: Optional[UUID] = None,
) -> List[Dict[str, Any]]:
    """团队成员列表(含用户信息、角色、积分配额、项目归属)."""
    stmt = (
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(Membership.org_id == org_id, Membership.is_active == True)
        .order_by(Membership.created_at.asc())
    )
    if search:
        stmt = stmt.where(
            (User.nickname.ilike(f"%{search}%")) | (User.email.ilike(f"%{search}%"))
        )
    result = await db.execute(stmt)
    rows = result.all()

    members = []
    for m, u in rows:
        # 积分配额
        alloc = await db.execute(
            select(CreditAllocation).where(
                CreditAllocation.org_id == org_id, CreditAllocation.user_id == u.id
            )
        )
        a = alloc.scalar_one_or_none()
        # 项目归属(该成员在该团队的项目) - owner 维度
        proj_result = await db.execute(
            select(Project.name).where(Project.org_id == org_id, Project.user_id == u.id)
        )
        project_names = [r[0] for r in proj_result.all()]

        members.append({
            "user_id": str(u.id),
            "email": u.email,
            "nickname": m.display_name or u.nickname or u.email,
            "avatar_url": u.avatar_url,
            "role": m.role,
            "is_active": m.is_active,
            "joined_at": m.created_at.isoformat() if m.created_at else None,
            "credit_quota": a.quota if a else 0,
            "credit_used": a.used if a else 0,
            "projects": project_names,
        })
    return members


async def invite_member(
    db: AsyncSession, org_id: UUID, email: str, role: str,
    display_name: Optional[str] = None, password: Optional[str] = None,
) -> Membership:
    """邀请/分配下级账户.

    若邮箱已存在用户 -> 直接加 Membership; 不存在 -> 创建用户.
    """
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        if not password:
            raise BadRequestException("Password is required for new user")
        user = User(email=email, hashed_password=get_password_hash(password), nickname=display_name)
        db.add(user)
        await db.flush()
    else:
        # 检查是否已是成员
        exist = await db.execute(
            select(Membership).where(Membership.org_id == org_id, Membership.user_id == user.id)
        )
        if exist.scalar_one_or_none():
            raise ConflictException("User is already a member")

    m = Membership(
        org_id=org_id, user_id=user.id, role=role,
        display_name=display_name or user.nickname,
    )
    db.add(m)
    await db.flush()
    return m


async def update_member(
    db: AsyncSession, org_id: UUID, user_id: UUID,
    role: Optional[str] = None, display_name: Optional[str] = None,
    operator_id: Optional[UUID] = None,
) -> Membership:
    """编辑成员(角色/显示名)."""
    m = await _get_membership(db, org_id, user_id)
    changes = {}
    if role is not None and role != m.role:
        if m.role == "owner":
            raise BadRequestException("Cannot change owner role")
        changes["role"] = (m.role, role)
        m.role = role
    if display_name is not None:
        m.display_name = display_name
    await db.flush()
    if changes:
        await _log(db, org_id, operator_id, user_id, "role_change" if "role" in changes else "edit",
                   f"修改成员信息: {changes}")
    return m


async def reset_member_password(
    db: AsyncSession, org_id: UUID, user_id: UUID, new_password: str,
    operator_id: Optional[UUID] = None,
) -> None:
    """重置成员密码."""
    if len(new_password) < 8:
        raise BadRequestException("Password must be at least 8 characters")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise NotFoundException("User not found", resource="User")
    user.hashed_password = get_password_hash(new_password)
    await db.flush()
    await _log(db, org_id, operator_id, user_id, "reset_password", "重置成员密码")


async def toggle_member_status(
    db: AsyncSession, org_id: UUID, user_id: UUID,
    operator_id: Optional[UUID] = None,
) -> Membership:
    """启用/禁用成员."""
    m = await _get_membership(db, org_id, user_id)
    if m.role == "owner":
        raise BadRequestException("Cannot disable owner")
    m.is_active = not m.is_active
    await db.flush()
    await _log(db, org_id, operator_id, user_id,
               "enable" if m.is_active else "disable",
               "启用成员" if m.is_active else "禁用成员")
    return m


async def list_member_logs(
    db: AsyncSession, org_id: UUID, user_id: Optional[UUID] = None, limit: int = 50
) -> List[OperationLog]:
    """成员操作日志."""
    stmt = select(OperationLog).where(OperationLog.org_id == org_id)
    if user_id:
        stmt = stmt.where(OperationLog.target_user_id == user_id)
    stmt = stmt.order_by(OperationLog.created_at.desc()).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def batch_update_member_projects(
    db: AsyncSession, org_id: UUID, user_ids: List[UUID], project_ids: List[UUID],
    operator_id: Optional[UUID] = None,
) -> int:
    """批量修改成员的项目归属(把指定项目 owner 改为对应成员, 这里简化为批量转移).

    M2 简化实现: 将指定项目的 user_id 批量更新. 实际"成员-项目"多对多需 M3 扩展.
    """
    count = 0
    for pid in project_ids:
        r = await db.execute(select(Project).where(Project.id == pid, Project.org_id == org_id))
        p = r.scalar_one_or_none()
        if p and user_ids:
            p.user_id = user_ids[0]  # 简化: 转给第一个成员
            count += 1
    await db.flush()
    return count


# ==================== 成员组 / 权限组 ====================

async def list_member_groups(db: AsyncSession, org_id: UUID) -> List[Dict[str, Any]]:
    result = await db.execute(
        select(MemberGroup).where(MemberGroup.org_id == org_id).order_by(MemberGroup.created_at.desc())
    )
    groups = result.scalars().all()
    out = []
    for g in groups:
        # 组长名
        leader_name = None
        if g.leader_id:
            lr = await db.execute(select(User.nickname, User.email).where(User.id == g.leader_id))
            row = lr.first()
            if row:
                leader_name = row[0] or row[1]
        out.append({
            "id": str(g.id), "name": g.name, "description": g.description,
            "leader_id": str(g.leader_id) if g.leader_id else None,
            "leader_name": leader_name,
            "member_ids": g.member_ids or [],
            "member_count": len(g.member_ids or []),
            "created_at": g.created_at.isoformat() if g.created_at else None,
        })
    return out


async def create_member_group(db: AsyncSession, org_id: UUID, name: str,
                              leader_id: Optional[UUID] = None,
                              description: Optional[str] = None,
                              member_ids: Optional[List[UUID]] = None) -> MemberGroup:
    g = MemberGroup(org_id=org_id, name=name, leader_id=leader_id,
                    description=description, member_ids=[str(x) for x in (member_ids or [])])
    db.add(g)
    await db.flush()
    return g


async def update_member_group(db: AsyncSession, org_id: UUID, group_id: UUID,
                              name: Optional[str] = None, leader_id: Optional[UUID] = None,
                              description: Optional[str] = None,
                              member_ids: Optional[List[UUID]] = None) -> MemberGroup:
    r = await db.execute(select(MemberGroup).where(MemberGroup.id == group_id, MemberGroup.org_id == org_id))
    g = r.scalar_one_or_none()
    if g is None:
        raise NotFoundException("Member group not found", resource="MemberGroup")
    if name is not None: g.name = name
    if leader_id is not None: g.leader_id = leader_id
    if description is not None: g.description = description
    if member_ids is not None: g.member_ids = [str(x) for x in member_ids]
    await db.flush()
    return g


async def delete_member_group(db: AsyncSession, org_id: UUID, group_id: UUID) -> None:
    await db.execute(
        delete(MemberGroup).where(MemberGroup.id == group_id, MemberGroup.org_id == org_id)
    )
    await db.flush()


async def list_permission_groups(db: AsyncSession, org_id: UUID) -> List[PermissionGroup]:
    result = await db.execute(
        select(PermissionGroup).where(PermissionGroup.org_id == org_id).order_by(PermissionGroup.created_at.desc())
    )
    return list(result.scalars().all())


async def create_permission_group(db: AsyncSession, org_id: UUID, name: str,
                                  description: Optional[str] = None,
                                  permissions: Optional[Dict] = None) -> PermissionGroup:
    g = PermissionGroup(org_id=org_id, name=name, description=description,
                        permissions=permissions or {})
    db.add(g)
    await db.flush()
    return g


async def update_permission_group(db: AsyncSession, org_id: UUID, group_id: UUID,
                                  name: Optional[str] = None, description: Optional[str] = None,
                                  permissions: Optional[Dict] = None) -> PermissionGroup:
    r = await db.execute(select(PermissionGroup).where(PermissionGroup.id == group_id, PermissionGroup.org_id == org_id))
    g = r.scalar_one_or_none()
    if g is None:
        raise NotFoundException("Permission group not found", resource="PermissionGroup")
    if name is not None: g.name = name
    if description is not None: g.description = description
    if permissions is not None: g.permissions = permissions
    await db.flush()
    return g


async def delete_permission_group(db: AsyncSession, org_id: UUID, group_id: UUID) -> None:
    await db.execute(
        delete(PermissionGroup).where(PermissionGroup.id == group_id, PermissionGroup.org_id == org_id)
    )
    await db.flush()


# ==================== 企业素材库权限矩阵 ====================

PERM_FIELDS = ["can_view", "can_upload", "can_download", "can_edit", "can_delete", "can_invoke"]


def _apply_cascade(perm_dict: Dict[str, bool]) -> Dict[str, bool]:
    """应用权限级联规则.

    - 授予 upload/download/edit/invoke -> 自动授予 view
    - 授予 delete -> 自动授予 edit + view
    - 取消 view -> 取消其余全部
    """
    d = dict(perm_dict)
    # 取消 view -> 全部取消
    if d.get("can_view") is False:
        for f in PERM_FIELDS:
            d[f] = False
        return d
    # 授予高权限 -> 补 view
    if any(d.get(f) for f in ["can_upload", "can_download", "can_edit", "can_invoke"]):
        d["can_view"] = True
    # 授予 delete -> 补 edit + view
    if d.get("can_delete"):
        d["can_edit"] = True
        d["can_view"] = True
    return d


async def list_material_permissions(db: AsyncSession, org_id: UUID) -> List[TeamMaterialPermission]:
    """成员权限矩阵."""
    result = await db.execute(
        select(TeamMaterialPermission).where(TeamMaterialPermission.org_id == org_id)
    )
    return list(result.scalars().all())


async def get_or_create_material_permission(db: AsyncSession, org_id: UUID, user_id: UUID) -> TeamMaterialPermission:
    r = await db.execute(
        select(TeamMaterialPermission).where(
            TeamMaterialPermission.org_id == org_id, TeamMaterialPermission.user_id == user_id
        )
    )
    p = r.scalar_one_or_none()
    if p is None:
        p = TeamMaterialPermission(org_id=org_id, user_id=user_id,
                                   can_view=True, can_upload=False, can_download=False,
                                   can_edit=False, can_delete=False, can_invoke=False)
        db.add(p)
        await db.flush()
    return p


async def set_material_permission(
    db: AsyncSession, org_id: UUID, user_id: UUID,
    permissions: Dict[str, bool],
) -> TeamMaterialPermission:
    """设置单成员素材库权限(应用级联)."""
    p = await get_or_create_material_permission(db, org_id, user_id)
    merged = {f: getattr(p, f) for f in PERM_FIELDS}
    merged.update({k: bool(v) for k, v in permissions.items() if k in PERM_FIELDS})
    merged = _apply_cascade(merged)
    for f in PERM_FIELDS:
        setattr(p, f, merged[f])
    await db.flush()
    return p


async def batch_set_material_permissions(
    db: AsyncSession, org_id: UUID, user_ids: List[UUID], permissions: Dict[str, bool],
) -> int:
    """批量设置权限."""
    cnt = 0
    for uid in user_ids:
        await set_material_permission(db, org_id, uid, permissions)
        cnt += 1
    return cnt


# ==================== 数据看板 ====================

async def get_dashboard_overview(db: AsyncSession, org_id: UUID) -> Dict[str, Any]:
    """数据看板概览: 项目总数/片段总数/积分账户."""
    proj_count = await db.execute(
        select(func.count(Project.id)).where(Project.org_id == org_id)
    )
    # 片段(Scene)通过 project 关联; 简化统计
    account = await db.execute(
        select(CreditAccount).where(CreditAccount.org_id == org_id)
    )
    acc = account.scalar_one_or_none()
    return {
        "project_count": proj_count.scalar() or 0,
        "clip_count": 0,  # M4 Episode 上线后填充
        "credit_balance": acc.balance if acc else 0,
        "credit_allocated": acc.allocated if acc else 0,
        "credit_consumed": acc.total_consumed if acc else 0,
    }


async def get_credit_trend(db: AsyncSession, org_id: UUID, days: int = 14) -> List[Dict]:
    """近N天积分消耗趋势."""
    start = date.today() - timedelta(days=days - 1)
    # 按天聚合 consume 类型的消耗(abs amount)
    result = await db.execute(
        select(
            func.date_trunc("day", CreditTransaction.created_at).label("d"),
            func.sum(func.abs(CreditTransaction.amount)).label("consumed"),
        )
        .where(
            CreditTransaction.org_id == org_id,
            CreditTransaction.type.in_(["consume"]),
            CreditTransaction.created_at >= start,
        )
        .group_by("d")
        .order_by("d")
    )
    rows = result.all()
    # 补全空白天
    by_day = {r[0].date(): int(r[1] or 0) for r in rows}
    trend = []
    for i in range(days):
        d = start + timedelta(days=i)
        trend.append({"date": d.isoformat(), "consumed": by_day.get(d, 0)})
    return trend


async def get_project_credit_ranking(db: AsyncSession, org_id: UUID, limit: int = 50) -> List[Dict]:
    """项目积分消耗排行."""
    result = await db.execute(
        select(
            Project.id, Project.name, Project.status,
            func.sum(func.abs(CreditTransaction.amount)).label("consumed"),
        )
        .outerjoin(CreditTransaction, and_(
            CreditTransaction.project_id == Project.id,
            CreditTransaction.type == "consume",
        ))
        .where(Project.org_id == org_id)
        .group_by(Project.id, Project.name, Project.status)
        .order_by(func.sum(func.abs(CreditTransaction.amount)).desc().nullslast())
        .limit(limit)
    )
    rows = result.all()
    return [{
        "project_id": str(r[0]), "name": r[1], "status": r[2],
        "consumed": int(r[3] or 0),
    } for r in rows]


async def get_member_credit_ranking(db: AsyncSession, org_id: UUID, limit: int = 50) -> List[Dict]:
    """人员积分消耗排行."""
    result = await db.execute(
        select(
            CreditTransaction.user_id,
            User.nickname, User.email,
            func.sum(func.abs(CreditTransaction.amount)).label("consumed"),
        )
        .outerjoin(User, User.id == CreditTransaction.user_id)
        .where(CreditTransaction.org_id == org_id, CreditTransaction.type == "consume")
        .group_by(CreditTransaction.user_id, User.nickname, User.email)
        .order_by(func.sum(func.abs(CreditTransaction.amount)).desc())
        .limit(limit)
    )
    rows = result.all()
    return [{
        "user_id": str(r[0]) if r[0] else None,
        "name": r[1] or r[2] or "系统",
        "consumed": int(r[3] or 0),
    } for r in rows]


# ==================== 积分统计 ====================

async def get_credit_stats(
    db: AsyncSession, org_id: UUID,
    start_date: Optional[date] = None, end_date: Optional[date] = None,
    dimension: str = "project",  # project / account
) -> Dict[str, Any]:
    """积分统计(按维度)."""
    if not start_date:
        start_date = date.today() - timedelta(days=30)
    if not end_date:
        end_date = date.today()

    result = await db.execute(
        select(
            CreditTransaction.project_id, CreditTransaction.user_id,
            CreditTransaction.type, CreditTransaction.amount,
            CreditTransaction.model, CreditTransaction.created_at,
        )
        .where(
            CreditTransaction.org_id == org_id,
            CreditTransaction.created_at >= start_date,
            CreditTransaction.created_at < end_date + timedelta(days=1),
        )
    )
    rows = result.all()

    if dimension == "account":
        # 按账号(用户)聚合
        agg: Dict[UUID, Dict] = {}
        for r in rows:
            uid = r[1]
            if uid not in agg:
                agg[uid] = {"consumed": 0, "count": 0}
            if r[2] == "consume":
                agg[uid]["consumed"] += abs(r[3])
                agg[uid]["count"] += 1
        # 补用户名
        items = []
        for uid, v in agg.items():
            ur = await db.execute(select(User.nickname, User.email).where(User.id == uid))
            row = ur.first()
            items.append({
                "user_id": str(uid),
                "name": (row[0] if row else None) or (row[1] if row else str(uid)),
                "consumed": v["consumed"], "count": v["count"],
            })
        items.sort(key=lambda x: x["consumed"], reverse=True)
        return {"dimension": "account", "items": items}
    else:
        # 按项目聚合
        agg: Dict[UUID, Dict] = {}
        for r in rows:
            pid = r[0]
            if pid is None:
                continue
            if pid not in agg:
                agg[pid] = {"consumed": 0, "count": 0}
            if r[2] == "consume":
                agg[pid]["consumed"] += abs(r[3])
                agg[pid]["count"] += 1
        items = []
        for pid, v in agg.items():
            pr = await db.execute(select(Project.name, Project.status).where(Project.id == pid))
            row = pr.first()
            items.append({
                "project_id": str(pid),
                "name": row[0] if row else str(pid),
                "status": row[1] if row else None,
                "consumed": v["consumed"], "count": v["count"],
            })
        items.sort(key=lambda x: x["consumed"], reverse=True)
        return {"dimension": "project", "items": items}


# ==================== 内部工具 ====================

async def _get_membership(db: AsyncSession, org_id: UUID, user_id: UUID) -> Membership:
    r = await db.execute(
        select(Membership).where(Membership.org_id == org_id, Membership.user_id == user_id)
    )
    m = r.scalar_one_or_none()
    if m is None:
        raise NotFoundException("Member not found in this organization", resource="Membership")
    return m


async def _log(db: AsyncSession, org_id: UUID, operator_id: Optional[UUID],
               target_user_id: UUID, action: str, detail: str) -> None:
    db.add(OperationLog(
        org_id=org_id, operator_id=operator_id,
        target_user_id=target_user_id, action=action, detail=detail,
    ))
    await db.flush()
