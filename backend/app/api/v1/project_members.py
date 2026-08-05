"""
Project Members API - 项目成员管理接口

路由前缀: /projects/{project_id}/members
端点:
- GET    /              成员列表
- POST   /              添加成员(邮箱+角色)
- PUT    /{user_id}     修改成员角色
- DELETE /{user_id}     移除成员
"""
from uuid import UUID
from typing import List, Dict, Any
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import ForbiddenException
from app.api.deps import verify_project_ownership, require_project_role
from app.models import User, Project
from app.services import project_member_service as pms

router = APIRouter()


class AddMemberRequest(BaseModel):
    email: str = Field(..., description="成员邮箱(须已是平台用户)")
    role: str = Field("editor", description="owner/manager/editor/viewer")


class UpdateRoleRequest(BaseModel):
    role: str


async def _check_manage_permission(db, project_id, user, project):
    """校验管理权限: 项目创建者 或 平台admin 可管理(简化: 复用 verify_project_ownership 已确保创建者/admin)"""
    pass  # verify_project_ownership 已校验: admin 或项目 user_id


@router.get("", response_model=List[Dict[str, Any]])
async def list_project_members(
    project_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """项目成员列表"""
    return await pms.list_members(db, project_id)


@router.post("", status_code=201)
async def add_project_member(
    project_id: UUID,
    body: AddMemberRequest,
    current_user: User = Depends(get_current_user),
    project: Project = Depends(verify_project_ownership),
    _role_ok = Depends(require_project_role(["owner", "manager"])),
    db: AsyncSession = Depends(get_db),
):
    """添加项目成员(按邮箱, 用户须已存在)。仅 owner/manager 可操作。"""
    pm = await pms.add_member(db, project_id, body.email, body.role, current_user.id)
    return {"id": str(pm.id), "user_id": str(pm.user_id), "role": pm.role}


@router.put("/{user_id}")
async def update_member_role(
    project_id: UUID,
    user_id: UUID,
    body: UpdateRoleRequest,
    project: Project = Depends(verify_project_ownership),
    _role_ok = Depends(require_project_role(["owner", "manager"])),
    db: AsyncSession = Depends(get_db),
):
    """修改成员角色。仅 owner/manager 可操作。"""
    pm = await pms.update_member_role(db, project_id, user_id, body.role)
    return {"id": str(pm.id), "role": pm.role}


@router.delete("/{user_id}")
async def remove_project_member(
    project_id: UUID,
    user_id: UUID,
    project: Project = Depends(verify_project_ownership),
    _role_ok = Depends(require_project_role(["owner", "manager"])),
    db: AsyncSession = Depends(get_db),
):
    """移除项目成员。仅 owner/manager 可操作。"""
    await pms.remove_member(db, project_id, user_id)
    return {"message": "Member removed"}
