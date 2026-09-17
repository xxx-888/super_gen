"""邮箱验证码服务 - SMTP 发送 + Redis 验证码存取

与 sms_service 同一套防滥用机制：
- 60s 发送冷却 + 每日发送上限(按邮箱)
- Redis 存储 TTL 过期自动清理, 验证通过即删除(一次性)
- 防爆破: 同邮箱同用途连续错 5 次作废当前验证码
- 发送失败向前端报真实错误(不伪装成功)

用途(PURPOSE_*):
- bind_email          绑定/验证当前账号邮箱
- email_reset_password 邮箱找回密码(需邮箱已验证)
- rebind_authorize    已验证邮箱授权换绑/解绑手机(死号复活通道)
"""
import asyncio
import logging
import re
import secrets

from app.core.config import settings
from app.core.exceptions import BadRequestException, RateLimitException
from app.core.redis import get_redis

logger = logging.getLogger(__name__)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

PURPOSE_BIND_EMAIL = "bind_email"
PURPOSE_EMAIL_RESET = "email_reset_password"
PURPOSE_REBIND_AUTHORIZE = "rebind_authorize"
VALID_PURPOSES = (PURPOSE_BIND_EMAIL, PURPOSE_EMAIL_RESET, PURPOSE_REBIND_AUTHORIZE)

PURPOSE_DESC = {
    PURPOSE_BIND_EMAIL: "邮箱验证",
    PURPOSE_EMAIL_RESET: "找回密码",
    PURPOSE_REBIND_AUTHORIZE: "更换手机号授权",
}


def validate_email(email: str) -> str:
    if not email or not EMAIL_RE.match(email or ""):
        raise BadRequestException("邮箱格式不正确")
    return email.strip().lower()


def generate_code() -> str:
    return f"{secrets.randbelow(1000000):06d}"


def _code_key(purpose: str, email: str) -> str:
    return f"vcode:email:{purpose}:{email}"


def _cooldown_key(purpose: str, email: str) -> str:
    return f"vcode:ecooldown:{purpose}:{email}"


def _daily_key(email: str) -> str:
    from datetime import date
    return f"vcode:edaily:{email}:{date.today().isoformat()}"


EXPIRE_SECONDS = getattr(settings, "VCODE_EMAIL_EXPIRE_SECONDS", 600)
COOLDOWN_SECONDS = getattr(settings, "VCODE_EMAIL_COOLDOWN_SECONDS", 60)
DAILY_LIMIT = getattr(settings, "VCODE_EMAIL_DAILY_LIMIT", 10)


async def send_email_code(email: str, purpose: str, db=None) -> dict:
    """生成并发送邮箱验证码(校验格式/用途/冷却/每日上限; 成功才落 Redis)。"""
    email = validate_email(email)
    if purpose not in VALID_PURPOSES:
        raise BadRequestException("不支持的验证码用途")

    from app.services.email_service import get_smtp_config, send_email
    # SMTP 未配置时直接报错(不伪装成功)
    if db is None:
        from app.core.database import AsyncSessionLocal
        async with AsyncSessionLocal() as _db:
            smtp = await get_smtp_config(_db)
    else:
        smtp = await get_smtp_config(db)
    if not smtp:
        raise BadRequestException("邮件服务未配置，请联系管理员在后台配置 SMTP")

    redis = get_redis()
    try:
        if await redis.exists(_cooldown_key(purpose, email)):
            raise RateLimitException(f"发送太频繁，请 {COOLDOWN_SECONDS} 秒后再试")
        daily_cnt = await redis.incr(_daily_key(email))
        if daily_cnt == 1:
            await redis.expire(_daily_key(email), 86400)
        if daily_cnt > DAILY_LIMIT:
            raise RateLimitException("今日发送次数已达上限，请明天再试")
    except (RateLimitException, BadRequestException):
        raise
    except Exception as e:
        logger.warning(f"[VCode] Redis 限流检查失败(忽略): {e}")

    code = generate_code()
    desc = PURPOSE_DESC.get(purpose, "验证")
    await send_email(
        to=email,
        subject=f"【SceneGen】{desc}验证码：{code}",
        html=(
            f'<div style="max-width:480px;margin:0 auto;font-family:-apple-system,\'Segoe UI\',\'PingFang SC\',sans-serif;">'
            f'<div style="background:#1d1d2b;color:#fff;border-radius:12px 12px 0 0;padding:24px 32px;">'
            f'<h2 style="margin:0;font-size:18px;">SceneGen {desc}</h2></div>'
            f'<div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:32px;">'
            f'<p style="margin:0 0 16px;color:#666;">你的{desc}验证码为（{EXPIRE_SECONDS // 60} 分钟内有效，请勿泄露给他人）：</p>'
            f'<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1d1d2b;'
            f'background:#f5f6fa;border-radius:8px;padding:16px;text-align:center;">{code}</div>'
            f'<p style="margin:24px 0 0;color:#999;font-size:12px;">如果这不是你的操作，请忽略本邮件。</p>'
            f'</div></div>'
        ),
    )

    try:
        pipe = redis.pipeline()
        pipe.set(_code_key(purpose, email), code, ex=EXPIRE_SECONDS)
        pipe.set(_cooldown_key(purpose, email), "1", ex=COOLDOWN_SECONDS)
        await pipe.execute()
    except Exception as e:
        logger.error(f"[VCode] 验证码写入 Redis 失败: {e}")
        raise BadRequestException("验证码发送异常，请稍后重试")

    logger.info(f"[VCode] 邮箱验证码已发送: email={email}, purpose={purpose}")
    return {"message": f"验证码已发送至邮箱，{EXPIRE_SECONDS // 60} 分钟内有效"}


async def verify_email_code(email: str, purpose: str, code: str, consume: bool = True) -> bool:
    """校验邮箱验证码(consume=True 一次性)。连续错 5 次作废。"""
    email = validate_email(email)
    if purpose not in VALID_PURPOSES:
        raise BadRequestException("不支持的验证码用途")
    redis = get_redis()
    key = _code_key(purpose, email)
    fail_key = f"vcode:efails:{purpose}:{email}"
    try:
        stored = await redis.get(key)
        if not stored:
            raise BadRequestException("验证码错误或已过期")
        fails = int(await redis.get(fail_key) or 0)
        if fails >= 5:
            await redis.delete(key)
            await redis.delete(fail_key)
            raise BadRequestException("验证码错误次数过多，请重新获取")
        if stored != str(code).strip():
            cnt = await redis.incr(fail_key)
            if cnt == 1:
                await redis.expire(fail_key, EXPIRE_SECONDS)
            raise BadRequestException("验证码错误或已过期")
        if consume:
            await redis.delete(key)
            await redis.delete(fail_key)
        return True
    except BadRequestException:
        raise
    except Exception as e:
        logger.error(f"[VCode] 验证码校验异常(Redis?): {e}")
        raise BadRequestException("验证码校验失败，请稍后重试")
