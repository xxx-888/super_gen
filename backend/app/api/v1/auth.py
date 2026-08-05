"""
Authentication API - 认证接口
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID

from app.core.database import get_db
from app.core.security import (
    verify_password,
    get_password_hash,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
)
from app.core.exceptions import (
    BadRequestException,
    ConflictException,
    UnauthorizedException,
)
from app.schemas import (
    UserCreate,
    LoginRequest,
    TokenResponse,
    RefreshTokenRequest,
    UserResponse,
)

router = APIRouter()


@router.get("/site-config")
async def get_site_config(
    db: AsyncSession = Depends(get_db),
):
    """获取站点公开配置（无需登录，前端用于显示站点名/描述/是否允许注册）"""
    from app.services.settings_service import get_all_settings
    all_settings = await get_all_settings(db)
    return {
        "site_name": all_settings.get("site_name", "SceneGen"),
        "site_description": all_settings.get("site_description", "AI短剧生成平台"),
        "allow_register": all_settings.get("allow_register", True),
    }


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
):
    """用户注册"""
    from app.models import User
    from app.services.settings_service import get_setting

    # 检查是否允许注册（后台「系统设置」控制）
    allow_register = await get_setting(db, "allow_register", True)
    if not allow_register:
        raise ForbiddenException("管理员已关闭注册，请联系管理员创建账号")

    # 检查邮箱是否已存在
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none():
        raise ConflictException("Email already registered")

    # 创建用户
    user = User(
        email=body.email,
        hashed_password=get_password_hash(body.password),
        nickname=body.nickname,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)

    # 创建个人团队(personal org) + 积分账户(赠送初始积分)
    from app.services.organization_service import create_personal_org
    await create_personal_org(db, user)

    # 生成令牌
    access_token = create_access_token(user.id)
    refresh_token = create_refresh_token(user.id)

    await db.commit()

    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        token_type="bearer",
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    """用户登录"""
    from app.models import User

    # 查找用户
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.hashed_password):
        raise UnauthorizedException("Invalid email or password")

    if not user.is_active:
        raise ForbiddenException("Account is disabled")

    # 生成令牌
    access_token = create_access_token(user.id)
    refresh_token = create_refresh_token(user.id)

    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        token_type="bearer",
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    body: RefreshTokenRequest,
    db: AsyncSession = Depends(get_db),
):
    """刷新访问令牌"""
    from app.models import User

    try:
        payload = decode_token(body.refresh_token)
    except Exception:
        raise UnauthorizedException("Invalid refresh token")

    if payload.get("type") != "refresh":
        raise BadRequestException("Invalid token type")

    user_id = payload.get("sub")
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        raise UnauthorizedException("User not found or inactive")

    # 生成新令牌对
    new_access_token = create_access_token(user.id)
    new_refresh_token = create_refresh_token(user.id)

    return TokenResponse(
        access_token=new_access_token,
        refresh_token=new_refresh_token,
        token_type="bearer",
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/logout")
async def logout():
    """用户登出(客户端清除token即可)"""
    return {"message": "Successfully logged out"}


@router.get("/me", response_model=UserResponse)
async def get_me(current_user=Depends(get_current_user)):
    """获取当前用户信息"""
    return current_user


# 导入依赖和配置
from app.core.config import settings
from app.core.exceptions import ForbiddenException
