"""
通知服务 —— 站内消息中心统一通道 + 邮件联动

所有业务事件(生成完成/失败、充值入账、发票审核结果、系统公告)统一从这里发出:
1. 站内: 写 notifications 表, 立即 commit(通知不依赖调用方事务, 半路失败不影响主流程)
2. 邮件: 若用户有邮箱且对应事件开启了邮件推送, 异步发送(asyncio.create_task +
   独立 session), 发送失败只记日志与回写 email_sent 标记

调用方式:
- await push(db, ...)          —— 在调用方 session 内(推荐, 同事务一致性)
- fire_and_forget(user_id=..)  —— 从已 commit 的流程中发, 自建 session
"""
import asyncio
import logging
from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal
from app.models import Notification, User, Membership

logger = logging.getLogger(__name__)

TYPE_GENERATION = "generation"
TYPE_RECHARGE = "recharge"
TYPE_INVOICE = "invoice"
TYPE_SYSTEM = "system"

# system_settings 中的邮件推送开关(默认开; SMTP 未配置时静默跳过)
KEY_EMAIL_PUSH = "notify_email_enabled"


async def push(
    db: AsyncSession,
    user_id: UUID,
    type: str,
    title: str,
    content: str = "",
    link: Optional[str] = None,
    ref_id: Optional[str] = None,
    email_html: Optional[str] = None,
) -> Notification:
    """创建一条站内通知并立即提交; 若给了 email_html 则联动发邮件。

    本函数自身吞掉异常(记日志), 保证不干扰主业务流程。
    """
    try:
        n = Notification(
            user_id=user_id, type=type, title=title, content=content,
            link=link, ref_id=ref_id, is_read=False,
        )
        db.add(n)
        await db.commit()
        await db.refresh(n)

        if email_html:
            asyncio.create_task(_send_email_for(n.id, user_id, title, email_html))
        return n
    except Exception as e:
        logger.error(f"[Notify] 站内通知写入失败 user={user_id} title={title}: {e}")
        try:
            await db.rollback()
        except Exception:
            pass
        # 降级: 返回未落库的哑对象, 调用方无需感知
        logger.warning(f"[Notify] 通知降级(未落库): user={user_id} {type} {title}")
        return Notification(user_id=user_id, type=type, title=title)


async def notify_org_admins(
    db: AsyncSession,
    org_id: UUID,
    type: str,
    title: str,
    content: str = "",
    link: Optional[str] = None,
    ref_id: Optional[str] = None,
    email_tpl=None,
) -> int:
    """给团队 owner/admin 成员逐个发通知(充值入账等团队级事件)。返回人数。"""
    rows = (await db.execute(
        select(Membership.user_id, User.email, User.nickname)
        .join(User, User.id == Membership.user_id)
        .where(
            Membership.org_id == org_id,
            Membership.role.in_(("owner", "admin")),
            Membership.is_active.is_(True),
        )
    )).all()
    count = 0
    for user_id, email, nickname in rows:
        await push(
            db, user_id=user_id, type=type, title=title, content=content,
            link=link, ref_id=ref_id,
            email_html=email_tpl(nickname or email, email) if email_tpl else None,
        )
        count += 1
    return count


async def _send_email_for(notification_id, user_id, subject: str, html: str):
    """独立 session 里查用户邮箱并发送(不干扰调用方连接池); 回写 email_sent。"""
    from app.services import email_service

    try:
        async with AsyncSessionLocal() as db:
            u = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
            if not u or not u.email:
                return
            enabled = await _email_push_enabled(db)
            if not enabled:
                return
            ok = await email_service.send_email(db, u.email, subject, html)
            n = (await db.execute(
                select(Notification).where(Notification.id == notification_id)
            )).scalar_one_or_none()
            if n:
                n.email_sent = ok
                await db.commit()
    except Exception as e:
        logger.error(f"[Notify] 邮件联动失败 notif={notification_id}: {e}")


async def _email_push_enabled(db: AsyncSession) -> bool:
    from app.services.settings_service import get_setting
    return await get_setting(db, KEY_EMAIL_PUSH, True) is not False
