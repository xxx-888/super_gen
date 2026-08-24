"""
Users API - 用户管理接口 (Admin)

与 /admin/users 功能等价的独立入口（保持 API 语义完整）：
分页/搜索列表、详情、编辑（昵称/头像/角色）、删除。
此前为留桩实现（返回空/None），现补齐真实现。
"""
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from app.core.database import get_db
from app.core.security import get_current_admin_user, get_password_hash
from app.core.exceptions import NotFoundException, ConflictException
from app.models import User
from app.schemas import UserResponse, UserAdminResponse, UpdateUserRequest
from app.api.deps import CommonQueryParams

router = APIRouter()


class UserUpdateBody(UpdateUserRequest):
    """管理员更新用户：昵称/头像 + 角色（admin/user）"""
    role: Optional[str] = None


def _user_dict(u: User) -> dict:
    """统一的用户响应结构（排除敏感字段，与 /admin/users 保持一致）"""
    return {
        "id": str(u.id),
        "email": u.email,
        "nickname": u.nickname,
        "avatar_url": u.avatar_url,
        "role": u.role,
        "is_active": u.is_active,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


async def _get_user_or_404(db: AsyncSession, user_id: str) -> User:
    try:
        uid = UUID(user_id)
    except ValueError:
        raise NotFoundException("User not found")
    result = await db.execute(select(User).where(User.id == uid))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException("User not found")
    return user


@router.get("", response_model=List[UserAdminResponse])
async def get_users(
    page: int = 1,
    page_size: int = 20,
    search: str = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取用户列表(管理员)：分页 + 邮箱/昵称搜索，按注册时间倒序。"""
    stmt = select(User)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(or_(User.email.ilike(pattern), User.nickname.ilike(pattern)))
    stmt = stmt.order_by(User.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(stmt)
    return [_user_dict(u) for u in result.scalars().all()]


@router.get("/{user_id}", response_model=UserAdminResponse)
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取用户详情(管理员)"""
    user = await _get_user_or_404(db, user_id)
    d = _user_dict(user)
    # 附带使用统计（详情场景展示）
    from app.models import Project, GenerationTask
    d["project_count"] = (await db.execute(
        select(func.count(Project.id)).where(Project.user_id == user.id)
    )).scalar() or 0
    d["task_count"] = (await db.execute(
        select(func.count(GenerationTask.id)).where(GenerationTask.user_id == user.id)
    )).scalar() or 0
    return d


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    body: UserUpdateBody,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新用户信息(管理员)：昵称/头像/角色。邮箱注册后不可修改（忽略）。"""
    user = await _get_user_or_404(db, user_id)
    data = body.model_dump(exclude_unset=True)
    if "nickname" in data:
        user.nickname = data["nickname"]
    if "avatar_url" in data:
        user.avatar_url = data["avatar_url"]
    if data.get("role") in ("admin", "user"):
        user.role = data["role"]
    await db.commit()
    return _user_dict(user)


@router.delete("/{user_id}")
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """删除用户(管理员)。不允许删除当前登录的管理员自己。"""
    if str(admin.id) == user_id:
        raise ConflictException("不能删除当前登录的管理员账户")
    user = await _get_user_or_404(db, user_id)
    await db.delete(user)
    await db.commit()
    return {"message": "User deleted", "user_id": user_id}
