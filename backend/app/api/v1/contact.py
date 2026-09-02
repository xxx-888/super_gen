"""
Contact API - 联系我们公开留言（/contact 页面，无需登录）

提交限流（Redis，同 SMS 思路）：同 IP 60s 冷却 + 每日 30 条上限。
后台在 /admin/contact-messages 查看与处理。
"""
import logging
from datetime import date

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import BadRequestException, RateLimitException
from app.core.config import settings
from app.core.redis import get_redis
from app.models import ContactMessage

logger = logging.getLogger(__name__)

router = APIRouter()

VALID_TYPES = ("suggestion", "bug", "cooperation", "other")


class ContactSubmitRequest(BaseModel):
    """公开留言提交"""
    name: str = Field("", max_length=100, description="称呼（可选）")
    contact: str = Field("", max_length=255, description="联系方式：邮箱/手机/QQ（可选）")
    msg_type: str = Field("suggestion", description="类型：suggestion/bug/cooperation/other")
    content: str = Field(..., min_length=5, max_length=2000, description="留言内容")


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return request.client.host if request.client else "unknown"


@router.post("", status_code=201)
async def submit_contact_message(
    body: ContactSubmitRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """提交留言（公开）。同 IP 60s 冷却、每日 30 条上限。"""
    if body.msg_type not in VALID_TYPES:
        raise BadRequestException("不支持的留言类型")

    ip = _client_ip(request)
    try:
        redis = get_redis()
        cooldown_key = f"contact:cooldown:{ip}"
        daily_key = f"contact:daily:{ip}:{date.today().isoformat()}"
        if await redis.exists(cooldown_key):
            raise RateLimitException("提交太频繁，请稍后再试")
        cnt = await redis.incr(daily_key)
        if cnt == 1:
            await redis.expire(daily_key, 86400)
        if cnt > 30:
            raise RateLimitException("今日提交次数已达上限，请明天再试")
    except (BadRequestException, RateLimitException):
        raise
    except Exception as e:  # Redis 不可用时放行（只丢限流，不丢留言）
        logger.warning(f"联系留言限流检查失败(忽略): {e}")

    msg = ContactMessage(
        name=(body.name or "").strip() or None,
        contact=(body.contact or "").strip() or None,
        msg_type=body.msg_type,
        content=body.content.strip(),
        ip=ip,
    )
    db.add(msg)
    await db.commit()

    try:  # 落库成功才写冷却
        redis = get_redis()
        await redis.set(f"contact:cooldown:{ip}", "1", ex=60)
    except Exception:
        pass

    logger.info(f"新留言: type={body.msg_type}, ip={ip}")
    return {"message": "提交成功，感谢你的反馈！我们会尽快处理"}
