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
    RateLimitException,
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
    EmailSendCodeRequest,
    EmailVerifyCodeRequest,
    EmailResetPasswordRequest,
    PhoneSendCodeRequest,
    PhoneRebindRequest,
    PhoneRebindByEmailRequest,
    PhoneUnbindRequest,
    EmailForgotSendRequest,
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
    """发送短信验证码(公开接口)。purpose: register=注册绑定, reset_password=忘记密码。
    需先通过点选人机验证（/auth/captcha/challenge → verify 取得一次性 captcha_token）。"""
    from app.models import User
    from app.services.sms_service import (
        send_sms_code as _send,
        PURPOSE_REGISTER,
        PURPOSE_RESET_PASSWORD,
    )
    from app.api.v1.captcha import consume_captcha_token

    # 前置人机验证：一次性 token，用途必须匹配
    await consume_captcha_token(body.captcha_token, body.purpose)

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
    import logging as _logging
    from app.models import User
    from app.core.redis import get_redis

    _log = _logging.getLogger(__name__)
    email = (body.email or "").strip().lower()

    # ---- 登录爆破防护：同账号 15 分钟内失败 5 次锁定 ----
    _fail_key = f"login:fail:{email}"
    try:
        redis = get_redis()
        fails = int(await redis.get(_fail_key) or 0)
        if fails >= 5:
            raise RateLimitException("登录失败次数过多，请 15 分钟后再试")
    except RateLimitException:
        raise
    except Exception as e:
        _log.warning(f"登录限流检查失败(放行): {e}")

    # 查找用户
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.hashed_password):
        # 记一次失败
        try:
            redis = get_redis()
            cnt = await redis.incr(_fail_key)
            if cnt == 1:
                await redis.expire(_fail_key, 900)
        except Exception:
            pass
        raise UnauthorizedException("Invalid email or password")

    if not user.is_active:
        raise ForbiddenException("Account is disabled")

    # 登录成功：清失败计数
    try:
        await get_redis().delete(_fail_key)
    except Exception:
        pass

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


async def _revoke_refresh_token(refresh_token: str, reason: str = "logout") -> None:
    """把 refresh token 拉黑：Redis 存 token SHA256，TTL=剩余有效期。

    reason=logout：登出，立即失效；
    reason=rotate：续签轮换（旧 token 换发新对后作废），带 60s 宽限期——
    多标签页并发续签时，另一标签页可能在旧 token 被写入黑名单后才发出
    续签请求，宽限期内放行避免误杀。
    """
    import hashlib, time
    from app.core.redis import get_redis
    try:
        payload = decode_token(refresh_token)
        exp = int(payload.get("exp") or 0) or (int(time.time()) + 7 * 86400)
        ttl = max(70, exp - int(time.time()))  # 至少覆盖宽限窗口
        r = get_redis()
        if r is not None:
            val = "logout" if reason == "logout" else f"rotate:{int(time.time())}"
            await r.set(f"auth:revoked:{hashlib.sha256(refresh_token.encode()).hexdigest()}", val, ex=ttl)
    except Exception:
        pass  # 无效 token 本就无法续签，拉黑失败不影响流程


async def _is_token_revoked(refresh_token: str, grace_seconds: int = 60) -> bool:
    import hashlib, time
    from app.core.redis import get_redis
    try:
        r = get_redis()
        if r is None:
            return False
        val = await r.get(f"auth:revoked:{hashlib.sha256(refresh_token.encode()).hexdigest()}")
        if not val:
            return False
        val = val.decode() if isinstance(val, bytes) else str(val)
        if val == "logout":
            return True  # 登出撤销：立即失效
        if val.startswith("rotate:"):
            ts = int(val.split(":", 1)[1] or 0)
            # 轮换作废：宽限期外视为已撤销（防旧 token 长期重放）
            return (time.time() - ts) > grace_seconds
        return True
    except Exception:
        return False  # Redis 异常时放行（fail-open，与登录锁定策略一致）


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

    # 已撤销的 refresh token（登出时拉黑）拒绝续签
    if await _is_token_revoked(body.refresh_token):
        raise UnauthorizedException("Token has been revoked")

    user_id = payload.get("sub")
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        raise UnauthorizedException("User not found or inactive")

    # 生成新令牌对
    new_access_token = create_access_token(user.id)
    new_refresh_token = create_refresh_token(user.id)

    # 轮换：旧 refresh token 作废（单次使用语义；60s 宽限防多标签页竞态）
    await _revoke_refresh_token(body.refresh_token, reason="rotate")

    return TokenResponse(
        access_token=new_access_token,
        refresh_token=new_refresh_token,
        token_type="bearer",
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/logout")
async def logout(body: dict = None):
    """用户登出：可选携带 refresh_token 做服务端撤销（拉黑至自然过期）。

    access token 短时效 + refresh 撤销 = 登出后整个会话链路失效。
    """
    rt = (body or {}).get("refresh_token")
    if rt:
        await _revoke_refresh_token(str(rt))
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


# ==================== 邮箱验证 + 手机号更换/解绑 ====================

@router.post("/email/send-code")
async def send_email_code(
    body: EmailSendCodeRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """发送邮箱验证码至当前账号邮箱(需登录)。

    purpose: bind_email=验证邮箱 / rebind_authorize=授权换绑或解绑手机(需已验证邮箱)。
    """
    from app.services import verification_service as vc
    from app.services.sms_service import PURPOSE_REBIND_OLD as _  # noqa: F401

    if not current_user.email:
        raise BadRequestException("当前账号未设置邮箱")
    if body.purpose == vc.PURPOSE_REBIND_AUTHORIZE and not current_user.email_verified:
        raise BadRequestException("邮箱尚未验证，请先完成邮箱验证")
    return await vc.send_email_code(current_user.email, body.purpose, db)


@router.post("/email/verify", response_model=UserResponse)
async def verify_email(
    body: EmailVerifyCodeRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """校验邮箱验证码 → 标记当前账号邮箱已验证。"""
    from app.services import verification_service as vc
    await vc.verify_email_code(current_user.email, vc.PURPOSE_BIND_EMAIL, body.code)
    current_user.email_verified = True
    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.post("/phone/send-code")
async def send_phone_code(
    body: PhoneSendCodeRequest,
    current_user=Depends(get_current_user),
):
    """换绑手机发码。target=old→当前绑定手机号(验证本人持有); target=new→要绑定的新号。"""
    from app.services.sms_service import (
        send_sms_code as _send, PURPOSE_REBIND_OLD, PURPOSE_BIND_NEW,
    )
    if body.target == "old":
        if not current_user.phone:
            raise BadRequestException("当前账号未绑定手机号，请走「邮箱授权换绑」通道")
        return await _send(current_user.phone, PURPOSE_REBIND_OLD)
    # target == new
    if not body.new_phone:
        raise BadRequestException("请填写新手机号")
    from app.services.sms_service import validate_phone
    new_phone = validate_phone(body.new_phone)
    if new_phone == current_user.phone:
        raise BadRequestException("新手机号与当前绑定相同")
    return await _send(new_phone, PURPOSE_BIND_NEW)


async def _check_new_phone_free(db: AsyncSession, new_phone: str, current_user_id) -> None:
    from app.models import User
    from app.services.sms_service import validate_phone
    new_phone = validate_phone(new_phone)
    exist = (await db.execute(select(User).where(User.phone == new_phone))).scalar_one_or_none()
    if exist and exist.id != current_user_id:
        raise ConflictException("该手机号已绑定其他账号")
    return new_phone


@router.post("/phone/rebind")
async def rebind_phone(
    body: PhoneRebindRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """常规换绑手机号: 旧号验证码(验证本人) + 新号验证码(验证新号可用)。"""
    from app.services.sms_service import verify_sms_code, PURPOSE_REBIND_OLD, PURPOSE_BIND_NEW

    if not current_user.phone:
        raise BadRequestException("当前账号未绑定手机号，请走「邮箱授权换绑」通道")
    new_phone = await _check_new_phone_free(db, body.new_phone, current_user.id)
    await verify_sms_code(current_user.phone, PURPOSE_REBIND_OLD, body.old_code)
    await verify_sms_code(new_phone, PURPOSE_BIND_NEW, body.new_code)
    current_user.phone = new_phone
    await db.commit()
    return {"message": "手机号已更换", "phone": new_phone}


@router.post("/phone/rebind-by-email")
async def rebind_phone_by_email(
    body: PhoneRebindByEmailRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """死号复活通道: 旧手机号丢失/不可用时, 已验证邮箱授权 + 新号验证码完成换绑。"""
    from app.services import verification_service as vc
    from app.services.sms_service import verify_sms_code, PURPOSE_BIND_NEW

    if not current_user.email_verified:
        raise BadRequestException("邮箱尚未验证，无法走此通道。请先在个人设置完成邮箱验证")
    new_phone = await _check_new_phone_free(db, body.new_phone, current_user.id)
    await vc.verify_email_code(current_user.email, vc.PURPOSE_REBIND_AUTHORIZE, body.email_code)
    await verify_sms_code(new_phone, PURPOSE_BIND_NEW, body.new_code)
    current_user.phone = new_phone
    await db.commit()
    return {"message": "手机号已更换(邮箱授权通道)", "phone": new_phone}


@router.post("/phone/unbind")
async def unbind_phone(
    body: PhoneUnbindRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """解绑手机号(需已验证邮箱授权; 解绑后可用邮箱找回密码)。"""
    from app.services import verification_service as vc

    if not current_user.phone:
        raise BadRequestException("当前账号未绑定手机号")
    if not current_user.email_verified:
        raise BadRequestException("解绑手机号前需先完成邮箱验证（作为找回通道）")
    await vc.verify_email_code(current_user.email, vc.PURPOSE_REBIND_AUTHORIZE, body.email_code)
    current_user.phone = None
    await db.commit()
    return {"message": "手机号已解绑"}


@router.post("/forgot-password/email-reset")
async def email_reset_password(
    body: EmailResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    """邮箱找回密码(公开接口)。要求邮箱已验证(否则无法证明归属)。

    与短信找回平行: 历史邮箱用户手机号丢失时由此通道找回。
    """
    from app.models import User
    from app.services import verification_service as vc

    email = body.email.strip().lower()
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    # 邮箱不存在/未验证都返回同一提示, 防枚举
    if not user or not user.email_verified:
        raise BadRequestException("验证码错误，或该邮箱未完成验证，无法找回")
    await vc.verify_email_code(email, vc.PURPOSE_EMAIL_RESET, body.code)
    user.hashed_password = get_password_hash(body.new_password)
    await db.commit()
    return {"message": "密码已重置，请使用新密码登录"}


@router.post("/forgot-password/email-send-code")
async def email_forgot_send_code(
    body: EmailForgotSendRequest,
    db: AsyncSession = Depends(get_db),
):
    """邮箱找回密码·发送验证码(公开接口)。

    需该邮箱已注册且已通过邮箱验证(否则无法证明归属, 提示先登录补验证)。
    """
    from app.models import User
    from app.services import verification_service as vc

    email = body.email.strip().lower()
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if not user:
        raise BadRequestException("该邮箱未绑定任何账号")
    if not user.email_verified:
        raise BadRequestException("该邮箱未完成验证，无法用于找回。请先登录后在个人设置完成邮箱验证")
    return await vc.send_email_code(email, vc.PURPOSE_EMAIL_RESET, db)
