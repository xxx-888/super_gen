"""
Dependencies - 依赖注入与公共依赖
"""
from fastapi import Depends, Header, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional, Dict, Any
from uuid import UUID

from app.core.database import get_db
from app.core.security import get_current_user, get_current_admin_user
from app.core.exceptions import NotFoundException, ForbiddenException
from app.models import User, Project, Script, Organization, Membership


class CommonQueryParams:
    """通用查询参数"""

    def __init__(
        self,
        page: int = Query(1, ge=1, description="页码"),
        page_size: int = Query(20, ge=1, le=100, description="每页数量"),
        sort_by: Optional[str] = Query(None, description="排序字段"),
        sort_order: str = Query("desc", pattern="^(asc|desc)$", description="排序方向"),
    ):
        self.page = page
        self.page_size = page_size
        self.sort_by = sort_by
        self.sort_order = sort_order

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size

    def get_sort_params(self, default_sort: str = "created_at") -> tuple:
        """获取排序参数"""
        return (
            self.sort_by or default_sort,
            True if self.sort_order == "asc" else False,
        )


class PaginationParams:
    """分页参数(简化版)"""

    def __init__(
        self,
        skip: int = Query(0, ge=0),
        limit: int = Query(20, ge=1, le=100),
    ):
        self.skip = skip
        self.limit = limit


# ==================== 项目权限检查 ====================

async def verify_project_ownership(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    验证项目访问权限（读取级别，所有成员可访问）。

    允许访问的条件（满足任一）：
    1. 平台管理员
    2. 项目创建者（project.user_id）
    3. 该项目的成员（ProjectMember 表中有记录，任意角色）

    写操作权限请用 require_project_role 依赖。
    """
    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()

    if project is None:
        raise NotFoundException("Project not found", resource="Project")

    # 管理员或创建者直接放行
    if current_user.role == "admin" or project.user_id == current_user.id:
        return project

    # 检查是否是项目成员
    from app.models import ProjectMember
    member_result = await db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == current_user.id,
        )
    )
    member = member_result.scalar_one_or_none()
    if member is None:
        raise ForbiddenException("You don't have access to this project")

    # 把成员角色挂到 project 上，供后续写操作检查
    project._member_role = member.role
    return project


def require_project_role(allowed_roles: list):
    """工厂函数：返回一个依赖，校验当前用户在该项目的角色是否在 allowed_roles 中。

    角色层级: owner > manager > editor > viewer
    - viewer: 只读（GET 用 verify_project_ownership 即可）
    - editor: 可编辑资源/片段/分镜
    - manager: 可管理成员
    - owner: 全权
    平台 admin 始终放行。
    """
    async def _checker(
        project_id: UUID,
        db: AsyncSession = Depends(get_db),
        current_user: User = Depends(get_current_user),
    ):
        if current_user.role == "admin":
            return True
        result = await db.execute(select(Project).where(Project.id == project_id))
        project = result.scalar_one_or_none()
        if project is None:
            raise NotFoundException("Project not found", resource="Project")
        # 创建者是 owner
        if project.user_id == current_user.id:
            return True
        # 查成员角色
        from app.models import ProjectMember
        m_result = await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == current_user.id,
            )
        )
        member = m_result.scalar_one_or_none()
        if member is None or member.role not in allowed_roles:
            raise ForbiddenException(f"Required project role: {allowed_roles}")
        return True
    return _checker


# ==================== 资源权限检查 ====================

async def verify_resource_ownership(
    resource_type: str,
    resource_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    验证资源所有权(角色/场景/道具/音频)
    """
    model_map = {
        "character": ("app.models.Character", "project_id"),
        "scene_bg": ("app.models.SceneBackground", "project_id"),
        "prop": ("app.models.Prop", "project_id"),
        "audio": ("app.models.AudioAsset", "project_id"),
        "script": ("app.models.Script", "project_id"),
        "scene": ("app.models.Scene", "script_id"),  # 特殊处理
    }

    if resource_type not in model_map:
        raise NotFoundException(f"Invalid resource type: {resource_type}")

    # 动态导入模型
    module_path, fk_field = model_map[resource_type]
    parts = module_path.rsplit(".", 1)
    module = __import__(parts[0], fromlist=[parts[1]])
    Model = getattr(module, parts[1])

    result = await db.execute(select(Model).where(Model.id == resource_id))
    resource = result.scalar_one_or_none()

    if not resource:
        raise NotFoundException(
            f"{resource_type.capitalize()} not found",
            resource=resource_type,
        )

    # 获取项目ID
    if resource_type == "scene":
        # 场景需要通过剧本获取项目ID
        script_result = await db.execute(
            select(Script).where(Script.id == resource.script_id)
        )
        script = script_result.scalar_one_or_none()
        project_id = script.project_id if script else None
    else:
        project_id = getattr(resource, fk_field)

    # 检查权限
    if current_user.role != "admin":
        project_result = await db.execute(
            select(Project).where(Project.id == project_id)
        )
        project = project_result.scalar_one_or_none()

        if project and project.user_id != current_user.id:
            raise ForbiddenException("You don't have access to this resource")

    return resource


# ==================== 团队/组织相关 ====================

async def get_current_org(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Organization:
    """
    获取当前选中的团队.

    - 优先使用 user.active_org_id
    - 若未设置/失效, 回退到 personal org (兼容历史用户)
    """
    org = None
    if current_user.active_org_id:
        result = await db.execute(
            select(Organization).where(Organization.id == current_user.active_org_id)
        )
        org = result.scalar_one_or_none()

    if org is None:
        # 回退: 查找 personal org
        result = await db.execute(
            select(Organization).where(
                Organization.owner_id == current_user.id,
                Organization.is_personal == True,
            )
        )
        org = result.scalar_one_or_none()
        if org is not None:
            current_user.active_org_id = org.id
            await db.flush()

    if org is None:
        # 兜底: 没有任何团队, 自动创建 personal org
        from app.services.organization_service import create_personal_org
        org = await create_personal_org(db, current_user)
        await db.flush()

    return org


async def verify_org_role(
    org_id: UUID,
    allowed_roles: list[str],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Membership:
    """校验当前用户在指定团队的角色是否在 allowed_roles 中.

    超级管理员（platform admin）直接放行，视为 owner 角色。
    """
    # 超级管理员放行
    if current_user.role == "admin":
        # 构造一个虚拟 membership 返回
        m = Membership()
        m.org_id = org_id
        m.user_id = current_user.id
        m.role = "owner"
        m.is_active = True
        return m
    result = await db.execute(
        select(Membership).where(
            Membership.org_id == org_id,
            Membership.user_id == current_user.id,
        )
    )
    membership = result.scalar_one_or_none()
    if membership is None:
        raise NotFoundException("Organization not found", resource="Organization")
    if not membership.is_active:
        raise ForbiddenException("Membership is disabled")
    if membership.role not in allowed_roles:
        raise ForbiddenException(f"Required role: {allowed_roles}")
    return membership


async def verify_org_membership(
    org_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Membership:
    """校验当前用户是某团队成员(任意角色).

    超级管理员直接放行。
    如果不是直接团队成员，检查是否是该 org 下任意项目的成员（兜底）。
    """
    # 超级管理员放行
    if current_user.role == "admin":
        m = Membership()
        m.org_id = org_id
        m.user_id = current_user.id
        m.role = "owner"
        m.is_active = True
        return m
    # 先查直接团队成员
    result = await db.execute(
        select(Membership).where(
            Membership.org_id == org_id,
            Membership.user_id == current_user.id,
        )
    )
    membership = result.scalar_one_or_none()
    if membership and membership.is_active:
        return membership
    # 兜底：检查是否是该 org 下任意项目的成员
    from app.models import Project, ProjectMember
    pm_result = await db.execute(
        select(ProjectMember.id)
        .join(Project, ProjectMember.project_id == Project.id)
        .where(Project.org_id == org_id, ProjectMember.user_id == current_user.id)
        .limit(1)
    )
    if pm_result.scalar_one_or_none():
        # 是项目成员但不是直接团队成员，构造一个 member 级别 membership
        m = Membership()
        m.org_id = org_id
        m.user_id = current_user.id
        m.role = "member"
        m.is_active = True
        return m
    raise NotFoundException("Organization not found", resource="Organization")


async def verify_org_or_project_member(
    org_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> bool:
    """宽松校验：org 成员 或 该 org 下任意项目的成员 都可访问（用于企业素材库读取）。

    平台 admin 直接放行。
    """
    if current_user.role == "admin":
        return True
    # 1. 检查是否是 org 成员
    result = await db.execute(
        select(Membership).where(
            Membership.org_id == org_id,
            Membership.user_id == current_user.id,
        )
    )
    if result.scalar_one_or_none():
        return True
    # 2. 检查是否是该 org 下任意项目的成员
    from app.models import Project, ProjectMember
    result = await db.execute(
        select(ProjectMember.id)
        .join(Project, ProjectMember.project_id == Project.id)
        .where(Project.org_id == org_id, ProjectMember.user_id == current_user.id)
        .limit(1)
    )
    if result.scalar_one_or_none():
        return True
    raise ForbiddenException("You don't have access to this organization's materials")

