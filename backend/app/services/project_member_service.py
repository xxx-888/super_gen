"""
Project Member Service - 项目成员管理业务逻辑

职责:
- 项目成员 CRUD (列表/邀请/改角色/移除)
- 权限校验: 只有项目 owner/manager 或项目创建者/团队管理员可管理成员
- 项目创建时自动添加创建者为 owner
"""
from uuid import UUID
from typing import Optional, List, Dict, Any
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundException, BadRequestException, ConflictException, ForbiddenException
from app.core.security import get_password_hash
from app.models import ProjectMember, Project, User, Membership


PROJECT_ROLES = ["owner", "manager", "editor", "viewer"]
ROLE_LABELS = {"owner": "负责人", "manager": "管理者", "editor": "编辑", "viewer": "只读"}


async def list_members(db: AsyncSession, project_id: UUID) -> List[Dict[str, Any]]:
    """项目成员列表(含用户信息)."""
    stmt = (
        select(ProjectMember, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id, ProjectMember.is_active == True)
        .order_by(ProjectMember.created_at.asc())
    )
    result = await db.execute(stmt)
    rows = result.all()
    return [{
        "id": str(m.id),
        "user_id": str(u.id),
        "email": u.email,
        "nickname": m.role and (u.nickname or u.email),
        "avatar_url": u.avatar_url,
        "role": m.role,
        "is_active": m.is_active,
        "joined_at": m.created_at.isoformat() if m.created_at else None,
    } for m, u in rows]


async def get_member_role(db: AsyncSession, project_id: UUID, user_id: UUID) -> Optional[str]:
    """获取用户在项目中的角色(无则 None)."""
    r = await db.execute(
        select(ProjectMember.role).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == user_id
        )
    )
    return r.scalar_one_or_none()


async def add_member(
    db: AsyncSession, project_id: UUID, email: str, role: str = "editor",
    added_by: Optional[UUID] = None,
) -> ProjectMember:
    """添加项目成员(按邮箱, 用户须已是团队成员)."""
    if role not in PROJECT_ROLES:
        raise BadRequestException(f"Invalid role: {role}")

    # 查用户
    r = await db.execute(select(User).where(User.email == email))
    user = r.scalar_one_or_none()
    if user is None:
        raise NotFoundException(f"用户 {email} 不存在", resource="User")

    # 检查是否已是成员
    exist = await db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == user.id
        )
    )
    if exist.scalar_one_or_none():
        raise ConflictException("该用户已是项目成员")

    pm = ProjectMember(project_id=project_id, user_id=user.id, role=role, added_by=added_by)
    db.add(pm)
    await db.flush()
    await db.refresh(pm)
    return pm


async def update_member_role(
    db: AsyncSession, project_id: UUID, user_id: UUID, role: str
) -> ProjectMember:
    """修改成员角色."""
    if role not in PROJECT_ROLES:
        raise BadRequestException(f"Invalid role: {role}")
    r = await db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == user_id
        )
    )
    pm = r.scalar_one_or_none()
    if pm is None:
        raise NotFoundException("成员不存在", resource="ProjectMember")
    if pm.role == "owner":
        raise BadRequestException("不能修改负责人角色")
    pm.role = role
    await db.flush()
    await db.refresh(pm)
    return pm


async def remove_member(db: AsyncSession, project_id: UUID, user_id: UUID) -> None:
    """移除项目成员."""
    r = await db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == user_id
        )
    )
    pm = r.scalar_one_or_none()
    if pm is None:
        raise NotFoundException("成员不存在", resource="ProjectMember")
    if pm.role == "owner":
        raise BadRequestException("不能移除项目负责人")
    await db.delete(pm)
    await db.flush()


async def ensure_owner_on_create(
    db: AsyncSession, project_id: UUID, user_id: UUID
) -> None:
    """项目创建时, 自动把创建者加为 owner."""
    pm = ProjectMember(project_id=project_id, user_id=user_id, role="owner")
    db.add(pm)
    await db.flush()


async def can_manage_members(
    db: AsyncSession, project_id: UUID, user_id: UUID, is_platform_admin: bool = False
) -> bool:
    """是否有权管理项目成员(平台admin / 项目owner,manager / 项目创建者)."""
    if is_platform_admin:
        return True
    # 项目角色
    role = await get_member_role(db, project_id, user_id)
    if role in ("owner", "manager"):
        return True
    # 项目创建者
    pr = await db.execute(select(Project).where(Project.id == project_id))
    project = pr.scalar_one_or_none()
    if project and str(project.user_id) == str(user_id):
        return True
    return False
