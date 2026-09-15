"""
Notifications API - 站内消息中心 (铃铛/未读数/列表/已读)
"""
from uuid import UUID
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import User, Notification
from app.schemas import NotificationResponse, UnreadCountResponse

router = APIRouter()


@router.get("/unread-count", response_model=UnreadCountResponse)
async def unread_count(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """当前用户未读通知数(顶栏铃铛轮询)。"""
    n = (await db.execute(
        select(func.count(Notification.id)).where(
            Notification.user_id == current_user.id,
            Notification.is_read.is_(False),
        )
    )).scalar() or 0
    return {"unread": n}


@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    type: Optional[str] = Query(None, description="generation/recharge/invoice/system"),
    unread_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """当前用户通知列表(新→旧)。"""
    stmt = select(Notification).where(Notification.user_id == current_user.id)
    if type:
        stmt = stmt.where(Notification.type == type)
    if unread_only:
        stmt = stmt.where(Notification.is_read.is_(False))
    stmt = stmt.order_by(Notification.created_at.desc()).limit(limit).offset(offset)
    return list((await db.execute(stmt)).scalars().all())


@router.post("/read-all")
async def read_all(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """全部标记已读。"""
    await db.execute(
        update(Notification)
        .where(Notification.user_id == current_user.id, Notification.is_read.is_(False))
        .values(is_read=True, read_at=func.now())
    )
    await db.commit()
    return {"ok": True}


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """单条标记已读(IDOR 防护: 仅本人通知可改)。"""
    n = (await db.execute(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not n:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("通知不存在")
    if not n.is_read:
        n.is_read = True
        from sqlalchemy.sql import func as sa_func
        n.read_at = sa_func.now()
        await db.commit()
    return {"ok": True}
