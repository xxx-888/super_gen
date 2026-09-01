"""
短信验证码服务 - 阿里云短信 (Tea SDK V3) + Redis 验证码存取

移植自 zckb-master 项目的 sms_service，并补强:
- secrets 生成验证码(替代 random)
- 60s 发送冷却 + 每日发送上限
- 手机号正则校验
- Redis 存储(TTL 过期自动清理, GETDEL 保证一次性使用)
- 发送失败向前端报真实错误(不伪装成功)

阿里云模板变量名固定为 ${code}
"""
import asyncio
import json
import logging
import re
import secrets

from alibabacloud_dysmsapi20170525.client import Client as DysmsapiClient
from alibabacloud_dysmsapi20170525 import models as dysms_models
from alibabacloud_tea_openapi import models as openapi_models

from app.core.config import settings
from app.core.exceptions import BadRequestException, RateLimitException
from app.core.redis import get_redis

logger = logging.getLogger(__name__)

# 中国大陆手机号
PHONE_RE = re.compile(r"^1[3-9]\d{9}$")

# 验证码用途 → 阿里云模板
PURPOSE_REGISTER = "register"
PURPOSE_RESET_PASSWORD = "reset_password"
VALID_PURPOSES = (PURPOSE_REGISTER, PURPOSE_RESET_PASSWORD)


def validate_phone(phone: str) -> str:
    """校验手机号格式, 不合法抛 BadRequest"""
    if not phone or not PHONE_RE.match(phone):
        raise BadRequestException("手机号格式不正确")
    return phone


def _create_client() -> DysmsapiClient:
    if not settings.ALIYUN_ACCESS_KEY_ID or not settings.ALIYUN_ACCESS_KEY_SECRET:
        raise BadRequestException("短信服务未配置：缺少 ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET")
    config = openapi_models.Config(
        access_key_id=settings.ALIYUN_ACCESS_KEY_ID,
        access_key_secret=settings.ALIYUN_ACCESS_KEY_SECRET,
        endpoint="dysmsapi.aliyuncs.com",
        protocol="https",  # V3 签名(SDK 默认)
    )
    return DysmsapiClient(config)


async def send_sms(phone: str, sign_name: str, template_code: str, template_param: dict) -> dict:
    """发送短信(同步 SDK 用 asyncio.to_thread 包装避免阻塞事件循环)"""
    if not sign_name:
        raise BadRequestException("短信服务未配置：缺少 ALIYUN_SMS_SIGN_NAME")
    if not template_code:
        raise BadRequestException("短信服务未配置：缺少短信模板 CODE")

    request = dysms_models.SendSmsRequest(
        phone_numbers=phone,
        sign_name=sign_name,
        template_code=template_code,
        template_param=json.dumps(template_param, ensure_ascii=False),  # 必须是 JSON 字符串
    )

    try:
        client = _create_client()
        response = await asyncio.to_thread(client.send_sms, request)
        body_dict = response.body.to_map() if hasattr(response.body, "to_map") else {}
        code = body_dict.get("Code") or body_dict.get("code", "")
        message = body_dict.get("Message") or body_dict.get("message", "")
        logger.info(f"阿里云短信响应: phone={phone}, Code={code}, Message={message}")

        if code != "OK":
            logger.error(f"短信发送失败: {message}, phone={phone}")
            raise BadRequestException(f"短信发送失败: {message}")
        return {"Code": code, "Message": message}
    except BadRequestException:
        raise
    except Exception as e:
        logger.error(f"短信发送异常: {e}")
        raise BadRequestException(f"短信发送异常: {e}")


def _template_for(purpose: str) -> str:
    if purpose == PURPOSE_REGISTER:
        return settings.ALIYUN_SMS_TEMPLATE_CODE_REGISTER or ""
    if purpose == PURPOSE_RESET_PASSWORD:
        return settings.ALIYUN_SMS_TEMPLATE_CODE_RESET or ""
    raise BadRequestException("不支持的验证码用途")


# ==================== 验证码存取 (Redis) ====================

def _code_key(purpose: str, phone: str) -> str:
    return f"sms:code:{purpose}:{phone}"


def _cooldown_key(purpose: str, phone: str) -> str:
    return f"sms:cooldown:{purpose}:{phone}"


def _daily_key(phone: str) -> str:
    from datetime import date
    return f"sms:daily:{phone}:{date.today().isoformat()}"


def generate_code() -> str:
    return f"{secrets.randbelow(1000000):06d}"


async def send_sms_code(phone: str, purpose: str) -> dict:
    """
    生成并发送验证码。
    校验: 手机号格式 / 用途合法 / 发送冷却 / 每日上限
    成功后验证码写入 Redis (TTL=SMS_CODE_EXPIRE_SECONDS)
    """
    validate_phone(phone)
    if purpose not in VALID_PURPOSES:
        raise BadRequestException("不支持的验证码用途")

    redis = get_redis()
    try:
        # 发送冷却
        if await redis.exists(_cooldown_key(purpose, phone)):
            raise RateLimitException(f"发送太频繁，请 {settings.SMS_SEND_COOLDOWN_SECONDS} 秒后再试")
        # 每日上限
        daily_cnt = await redis.incr(_daily_key(phone))
        if daily_cnt == 1:
            await redis.expire(_daily_key(phone), 86400)
        if daily_cnt > settings.SMS_DAILY_LIMIT:
            raise RateLimitException("今日发送次数已达上限，请明天再试")
    except RateLimitException:
        raise
    except BadRequestException:
        raise
    except Exception as e:
        # Redis 不可用时不做限流，直接放行发送(验证码校验依赖 Redis, 后续会报错)
        logger.warning(f"Redis 限流检查失败(忽略): {e}")

    code = generate_code()
    await send_sms(phone, settings.ALIYUN_SMS_SIGN_NAME or "", _template_for(purpose), {"code": code})

    # 发送成功才落库
    try:
        pipe = redis.pipeline()
        pipe.set(_code_key(purpose, phone), code, ex=settings.SMS_CODE_EXPIRE_SECONDS)
        pipe.set(_cooldown_key(purpose, phone), "1", ex=settings.SMS_SEND_COOLDOWN_SECONDS)
        await pipe.execute()
    except Exception as e:
        logger.error(f"验证码写入 Redis 失败: {e}")
        raise BadRequestException("验证码发送异常，请稍后重试")

    logger.info(f"验证码已发送: phone={phone}, purpose={purpose}")
    return {"message": "验证码已发送，5分钟内有效"}


async def verify_sms_code(phone: str, purpose: str, code: str, consume: bool = True) -> bool:
    """
    校验验证码。consume=True 时验证通过即删除(一次性)。
    """
    validate_phone(phone)
    redis = get_redis()
    key = _code_key(purpose, phone)
    try:
        stored = await redis.get(key)
        if not stored or stored != str(code).strip():
            raise BadRequestException("验证码错误或已过期")
        if consume:
            await redis.delete(key)
        return True
    except BadRequestException:
        raise
    except Exception as e:
        logger.error(f"验证码校验异常(Redis?): {e}")
        raise BadRequestException("验证码校验失败，请稍后重试")
