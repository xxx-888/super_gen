"""
Users API - 用户管理接口 (Admin)
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List

from app.core.database import get_db
from app.core.security import get_current_admin_user, get_current_user
from app.models import User
from app.schemas import UserResponse, UserAdminResponse, UpdateUserRequest
from app.api.deps import CommonQueryParams

router = APIRouter()


@router.get("", response_model=List[UserAdminResponse])
async def get_users(
    params: CommonQueryParams = Depends(),
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取用户列表(管理员)"""
    # TODO: 实现分页查询
    return []


@router.get("/{user_id}", response_model=UserAdminResponse)
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取用户详情(管理员)"""
    # TODO: 实现
    pass


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    body: UpdateUserRequest,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新用户信息(管理员)"""
    # TODO: 实现
    pass


@router.delete("/{user_id}")
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """删除用户(管理员)"""
    # TODO: 实现
    pass
