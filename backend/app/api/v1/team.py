"""
Team Management API - 团队管理接口 (M2)

路由前缀: /organizations/{org_id}
子模块:
- /dashboard           数据看板
- /dashboard/credits   积分统计
- /members             成员管理
- /member-groups       成员组管理
- /permission-groups   权限组管理
- /material-permissions 企业素材库权限矩阵
"""
from uuid import UUID
from datetime import date
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import NotFoundException, BadRequestException
from app.api.deps import verify_org_membership, verify_org_role
from app.models import User, Membership, OperationLog, TeamMaterialPermission
from app.schemas import (
    MemberInviteRequest, MemberUpdateRequest, ResetPasswordRequest,
    BatchUpdateProjectsRequest,
    MemberGroupCreate, MemberGroupUpdate, MemberGroupResponse,
    PermissionGroupCreate, PermissionGroupUpdate, PermissionGroupResponse,
    MaterialPermissionRequest, BatchMaterialPermissionRequest, MaterialPermissionResponse,
)
from app.services import team_service

router = APIRouter()


def _require_admin(membership: Membership) -> None:
    """成员管理类操作要求 owner/admin"""
    if membership.role not in ("owner", "admin"):
        raise NotFoundException("Admin access required", resource="Organization")


# ==================== 数据看板 ====================

@router.get("/dashboard/data", response_model=Dict[str, Any])
async def get_dashboard_data(
    org_id: UUID,
    days: int = Query(14, ge=1, le=90),
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """数据看板: 概览 + 积分趋势 + 项目/人员积分排行"""
    overview = await team_service.get_dashboard_overview(db, org_id)
    trend = await team_service.get_credit_trend(db, org_id, days)
    project_rank = await team_service.get_project_credit_ranking(db, org_id)
    member_rank = await team_service.get_member_credit_ranking(db, org_id)
    return {
        "overview": overview,
        "credit_trend": trend,
        "project_ranking": project_rank,
        "member_ranking": member_rank,
    }


@router.get("/dashboard/credits", response_model=Dict[str, Any])
async def get_credits_stats(
    org_id: UUID,
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    dimension: str = Query("project", pattern="^(project|account)$"),
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """积分统计(按项目/账号维度)"""
    return await team_service.get_credit_stats(db, org_id, start_date, end_date, dimension)


# ==================== 成员管理 ====================

@router.get("/members", response_model=List[Dict[str, Any]])
async def list_members(
    org_id: UUID,
    search: Optional[str] = Query(None),
    project_id: Optional[UUID] = Query(None),
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """成员列表"""
    return await team_service.list_members(db, org_id, search, project_id)


@router.post("/members/invite", status_code=201)
async def invite_member(
    org_id: UUID,
    body: MemberInviteRequest,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """邀请/分配下级账户(owner/admin)"""
    _require_admin(membership)
    m = await team_service.invite_member(
        db, org_id, body.email, body.role, body.display_name, body.password
    )
    await team_service._log(db, org_id, current_user.id, m.user_id, "invite", f"邀请成员: {body.email}")
    return {"user_id": str(m.user_id), "role": m.role}


@router.put("/members/{user_id}")
async def update_member(
    org_id: UUID,
    user_id: UUID,
    body: MemberUpdateRequest,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """编辑成员(owner/admin)"""
    _require_admin(membership)
    m = await team_service.update_member(
        db, org_id, user_id, body.role, body.display_name, current_user.id
    )
    return {"user_id": str(m.user_id), "role": m.role, "display_name": m.display_name}


@router.post("/members/{user_id}/reset-password")
async def reset_member_password(
    org_id: UUID,
    user_id: UUID,
    body: ResetPasswordRequest,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """重置成员密码(owner/admin)"""
    _require_admin(membership)
    await team_service.reset_member_password(db, org_id, user_id, body.new_password, current_user.id)
    return {"message": "Password reset"}


@router.post("/members/{user_id}/toggle-status")
async def toggle_member_status(
    org_id: UUID,
    user_id: UUID,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """启用/禁用成员(owner/admin)"""
    _require_admin(membership)
    m = await team_service.toggle_member_status(db, org_id, user_id, current_user.id)
    return {"user_id": str(m.user_id), "is_active": m.is_active}


@router.get("/members/{user_id}/logs")
async def member_logs(
    org_id: UUID,
    user_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """成员操作日志"""
    logs = await team_service.list_member_logs(db, org_id, user_id, limit)
    return [{
        "id": str(l.id), "action": l.action, "detail": l.detail,
        "operator_id": str(l.operator_id) if l.operator_id else None,
        "created_at": l.created_at.isoformat() if l.created_at else None,
    } for l in logs]


@router.post("/members/batch-projects")
async def batch_update_projects(
    org_id: UUID,
    body: BatchUpdateProjectsRequest,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批量修改成员项目归属(owner/admin)"""
    _require_admin(membership)
    count = await team_service.batch_update_member_projects(
        db, org_id, body.user_ids, body.project_ids, current_user.id
    )
    return {"updated": count}


# ==================== 成员组 ====================

@router.get("/member-groups", response_model=List[MemberGroupResponse])
async def list_member_groups(
    org_id: UUID,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """成员组列表"""
    return await team_service.list_member_groups(db, org_id)


@router.post("/member-groups", response_model=MemberGroupResponse, status_code=201)
async def create_member_group(
    org_id: UUID,
    body: MemberGroupCreate,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """创建成员组(owner/admin)"""
    _require_admin(membership)
    g = await team_service.create_member_group(
        db, org_id, body.name, body.leader_id, body.description, body.member_ids
    )
    return MemberGroupResponse(
        id=str(g.id), name=g.name, leader_id=str(g.leader_id) if g.leader_id else None,
        description=g.description, member_ids=g.member_ids or [],
        member_count=len(g.member_ids or []),
        created_at=g.created_at.isoformat() if g.created_at else None,
    )


@router.put("/member-groups/{group_id}", response_model=MemberGroupResponse)
async def update_member_group(
    org_id: UUID,
    group_id: UUID,
    body: MemberGroupUpdate,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """编辑成员组(owner/admin)"""
    _require_admin(membership)
    g = await team_service.update_member_group(
        db, org_id, group_id, body.name, body.leader_id, body.description, body.member_ids
    )
    return MemberGroupResponse(
        id=str(g.id), name=g.name, leader_id=str(g.leader_id) if g.leader_id else None,
        description=g.description, member_ids=g.member_ids or [],
        member_count=len(g.member_ids or []),
        created_at=g.created_at.isoformat() if g.created_at else None,
    )


@router.delete("/member-groups/{group_id}")
async def delete_member_group(
    org_id: UUID,
    group_id: UUID,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """删除成员组(owner/admin)"""
    _require_admin(membership)
    await team_service.delete_member_group(db, org_id, group_id)
    return {"message": "Deleted"}


# ==================== 权限组 ====================

@router.get("/permission-groups", response_model=List[PermissionGroupResponse])
async def list_permission_groups(
    org_id: UUID,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """权限组列表"""
    return await team_service.list_permission_groups(db, org_id)


@router.post("/permission-groups", response_model=PermissionGroupResponse, status_code=201)
async def create_permission_group(
    org_id: UUID,
    body: PermissionGroupCreate,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """新建权限组(owner/admin)"""
    _require_admin(membership)
    return await team_service.create_permission_group(db, org_id, body.name, body.description, body.permissions)


@router.put("/permission-groups/{group_id}", response_model=PermissionGroupResponse)
async def update_permission_group(
    org_id: UUID,
    group_id: UUID,
    body: PermissionGroupUpdate,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """编辑权限组(owner/admin)"""
    _require_admin(membership)
    return await team_service.update_permission_group(
        db, org_id, group_id, body.name, body.description, body.permissions
    )


@router.delete("/permission-groups/{group_id}")
async def delete_permission_group(
    org_id: UUID,
    group_id: UUID,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """删除权限组(owner/admin)"""
    _require_admin(membership)
    await team_service.delete_permission_group(db, org_id, group_id)
    return {"message": "Deleted"}


# ==================== 企业素材库权限矩阵 ====================

@router.get("/material-permissions", response_model=List[MaterialPermissionResponse])
async def list_material_permissions(
    org_id: UUID,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """成员素材库权限矩阵"""
    return await team_service.list_material_permissions(db, org_id)


@router.put("/material-permissions/{user_id}", response_model=MaterialPermissionResponse)
async def set_material_permission(
    org_id: UUID,
    user_id: UUID,
    body: MaterialPermissionRequest,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """设置单成员素材库权限(owner/admin, 含级联)"""
    _require_admin(membership)
    perms = {k: v for k, v in body.model_dump().items() if v is not None}
    return await team_service.set_material_permission(db, org_id, user_id, perms)


@router.post("/material-permissions/batch")
async def batch_set_material_permissions(
    org_id: UUID,
    body: BatchMaterialPermissionRequest,
    membership: Membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """批量设置素材库权限(owner/admin)"""
    _require_admin(membership)
    count = await team_service.batch_set_material_permissions(db, org_id, body.user_ids, body.permissions)
    return {"updated": count}
