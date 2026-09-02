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
    RegisterRequest,
    SendSmsCodeRequest,
    SmsResetPasswordRequest,
)

router = APIRouter()


@router.get("/site-config")
async def get_site_config(
    db: AsyncSession = Depends(get_db),
):
    """获取站点公开配置（无需登录，前端用于显示站点名/描述/是否允许注册）"""
    from app.services.settings_service import get_all_settings, DEFAULT_TASK_POLL_TIMEOUT
    all_settings = await get_all_settings(db)
    # 任务轮询超时：前端各页面据此动态计算 maxAttempts，避免比后端先超时
    try:
        poll_timeout = max(60, int(all_settings.get("task_poll_timeout_seconds", DEFAULT_TASK_POLL_TIMEOUT)))
    except (TypeError, ValueError):
        poll_timeout = DEFAULT_TASK_POLL_TIMEOUT
    return {
        "site_name": all_settings.get("site_name", "SceneGen"),
        "site_description": all_settings.get("site_description", "AI短剧生成平台"),
        "allow_register": all_settings.get("allow_register", True),
        "task_poll_timeout_seconds": poll_timeout,
        # 联系方式（协议/隐私页「联系我们」动态展示，后台系统设置可配）
        "contact_email": all_settings.get("contact_email", ""),
        "contact_qq": all_settings.get("contact_qq", ""),
        "contact_phone": all_settings.get("contact_phone", ""),
    }


@router.post("/sms/send-code")
async def send_sms_code(
    body: SendSmsCodeRequest,
    db: AsyncSession = Depends(get_db),
):
    """发送短信验证码(公开接口)。purpose: register=注册绑定, reset_password=忘记密码"""
    from app.models import User
    from app.services.sms_service import (
        send_sms_code as _send,
        PURPOSE_REGISTER,
        PURPOSE_RESET_PASSWORD,
    )

    if body.purpose == PURPOSE_REGISTER:
        # 注册: 手机号不能已被绑定
        result = await db.execute(select(User).where(User.phone == body.phone))
        if result.scalar_one_or_none():
            raise ConflictException("该手机号已注册，请直接登录或更换手机号")
    elif body.purpose == PURPOSE_RESET_PASSWORD:
        # 忘记密码: 手机号必须已绑定账号
        result = await db.execute(select(User).where(User.phone == body.phone))
        if not result.scalar_one_or_none():
            raise BadRequestException("该手机号未绑定任何账号")
    else:
        raise BadRequestException("不支持的验证码用途")

    return await _send(body.phone, body.purpose)


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    db: AsyncSession = Depends(get_db),
):
    """用户注册(需手机短信验证码)"""
    from app.models import User
    from app.services.settings_service import get_setting
    from app.services.sms_service import verify_sms_code, PURPOSE_REGISTER

    # 检查是否允许注册（后台「系统设置」控制）
    allow_register = await get_setting(db, "allow_register", True)
    if not allow_register:
        raise ForbiddenException("管理员已关闭注册，请联系管理员创建账号")

    # 先查重(避免误消耗验证码), 再校验短信验证码(一次性)
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none():
        raise ConflictException("Email already registered")

    # 检查手机号是否已被绑定
    result = await db.execute(select(User).where(User.phone == body.phone))
    if result.scalar_one_or_none():
        raise ConflictException("该手机号已注册，请直接登录或更换手机号")

    # 校验短信验证码(一次性)
    await verify_sms_code(body.phone, PURPOSE_REGISTER, body.sms_code)

    # 创建用户
    user = User(
        email=body.email,
        hashed_password=get_password_hash(body.password),
        nickname=body.nickname,
        phone=body.phone,
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


@router.post("/forgot-password/reset")
async def forgot_password_reset(
    body: SmsResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    """忘记密码-手机验证码重置密码(公开接口)"""
    from app.models import User
    from app.services.sms_service import verify_sms_code, PURPOSE_RESET_PASSWORD

    # 校验短信验证码(一次性)
    await verify_sms_code(body.phone, PURPOSE_RESET_PASSWORD, body.code)

    # 按手机号找用户
    result = await db.execute(select(User).where(User.phone == body.phone))
    user = result.scalar_one_or_none()
    if not user:
        raise BadRequestException("该手机号未绑定任何账号")
    if not user.is_active:
        raise ForbiddenException("Account is disabled")

    user.hashed_password = get_password_hash(body.new_password)
    await db.commit()

    return {"message": "密码重置成功，请使用新密码登录"}


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


@router.put("/profile")
async def update_own_profile(
    body: dict,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """修改自己的资料：昵称 / 头像 URL。邮箱与手机号不在此修改。"""
    nickname = body.get("nickname")
    avatar_url = body.get("avatar_url")
    if nickname is not None:
        nickname = str(nickname).strip()
        if not nickname or len(nickname) > 100:
            raise BadRequestException("昵称不能为空且不超过 100 字符")
        current_user.nickname = nickname
    if avatar_url is not None:
        avatar_url = str(avatar_url).strip()
        if len(avatar_url) > 2048:
            raise BadRequestException("头像 URL 过长")
        current_user.avatar_url = avatar_url or None
    await db.commit()
    return {
        "id": str(current_user.id),
        "email": current_user.email,
        "phone": current_user.phone,
        "nickname": current_user.nickname,
        "avatar_url": current_user.avatar_url,
        "role": current_user.role,
    }


@router.put("/change-password")
async def change_own_password(
    body: dict,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """修改自己的登录密码：校验原密码后设置新密码"""
    old_password = str(body.get("old_password") or "")
    new_password = str(body.get("new_password") or "")
    if len(new_password) < 8 or len(new_password) > 128:
        raise BadRequestException("新密码长度需为 8-128 个字符")
    if not verify_password(old_password, current_user.hashed_password):
        raise BadRequestException("原密码错误")
    if old_password == new_password:
        raise BadRequestException("新密码不能与原密码相同")
    current_user.hashed_password = get_password_hash(new_password)
    await db.commit()
    return {"message": "密码修改成功，下次登录请使用新密码"}


# 导入依赖和配置
from app.core.config import settings
from app.core.exceptions import ForbiddenException
