"""
支付服务 —— 套餐 / 订单 / 回调入账 / 资质开关联动

渠道策略:
- manual: 人工确认通道(默认)。IAP 类目/微信商户号/支付宝资质未到位时,
  用户下单后由运营在后台对账确认, 确认即入账——支付链路先跑通, 渠道即插即用。
- wechat_native / alipay_qr / iap: 预留。资质到位后在 _channel_adapter
  增加预下单与验签实现, 回调统一走 POST /payments/notify/{channel}。

入账幂等: 订单状态机 pending→paid 由行级锁(SELECT..FOR UPDATE)保护,
重复确认/重复回调只会生效一次。
入账动作: credit_service.recharge() + 充值通知(站内+邮件)。
"""
import logging
import random
import string
from datetime import datetime, timezone
from typing import Optional, Tuple
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.models import (
    PricingPlan, PaymentOrder, Notification,
    User, Membership,
)
from app.services import credit_service, notification_service, email_service
from app.services.settings_service import get_setting

logger = logging.getLogger(__name__)

# system_settings 键
KEY_PAYMENT_ENABLED = "payment_enabled"          # 总开关(与 IAP 类目/商户号资质/备案进度联动)
KEY_PAYMENT_NOTICE = "payment_notice"            # 关闭时的展示文案(资质筹备说明)
KEY_AUTO_CONFIRM_MANUAL = "payment_auto_confirm"  # manual 渠道下单是否自动确认(联调用, 默认关)

ORDER_PREFIX = "SO"


# ==================== 开关与文案 ====================

async def get_payment_status(db: AsyncSession) -> dict:
    """前端套餐页依赖的总开关状态与文案。"""
    return {
        "enabled": await get_setting(db, KEY_PAYMENT_ENABLED, False) is True,
        "notice": await get_setting(db, KEY_PAYMENT_NOTICE) or
        "在线支付即将开放：IAP 类目与商户号资质办理中，与 ICP 备案进度联动。"
        "期间可联系客服人工充值。",
    }


# ==================== 套餐 ====================

async def list_plans(db: AsyncSession, only_enabled: bool = True) -> list:
    stmt = select(PricingPlan).order_by(PricingPlan.sort_order.asc(), PricingPlan.price_cents.asc())
    if only_enabled:
        stmt = stmt.where(PricingPlan.is_enabled.is_(True))
    return list((await db.execute(stmt)).scalars().all())


async def get_plan(db: AsyncSession, plan_id: UUID) -> PricingPlan:
    p = (await db.execute(select(PricingPlan).where(PricingPlan.id == plan_id))).scalar_one_or_none()
    if not p:
        raise NotFoundException("套餐不存在或已下架")
    return p


# ==================== 订单 ====================

def gen_order_no() -> str:
    """SO + yyyyMMddHHMMSS + 6位随机, 兼顾可读性与唯一性。"""
    now = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    rand = "".join(random.choices(string.digits, k=6))
    return f"{ORDER_PREFIX}{now}{rand}"


async def create_order(
    db: AsyncSession,
    org_id: UUID,
    user_id: UUID,
    plan_id: UUID,
    channel: str = "manual",
) -> PaymentOrder:
    """用户下单。payment_enabled 关闭时拒绝(资质/备案未就绪)。"""
    status = await get_payment_status(db)
    if not status["enabled"]:
        raise BadRequestException(status["notice"])

    plan = await get_plan(db, plan_id)
    if not plan.is_enabled:
        raise BadRequestException("该套餐已下架")
    if channel not in ("manual", "wechat_native", "alipay_qr", "iap"):
        raise BadRequestException("不支持的支付渠道")

    order = PaymentOrder(
        order_no=gen_order_no(),
        org_id=org_id,
        user_id=user_id,
        plan_id=plan.id,
        plan_snapshot={
            "code": plan.code, "name": plan.name,
            "price_cents": plan.price_cents, "original_price_cents": plan.original_price_cents,
            "credits": plan.credits, "bonus_credits": plan.bonus_credits or 0,
        },
        amount_cents=plan.price_cents,
        credits=plan.credits + (plan.bonus_credits or 0),
        status="pending",
        channel=channel,
    )
    db.add(order)
    await db.flush()

    # 联调开关: manual 渠道下单即自动确认(仅测试环境用, 生产保持关闭)
    if channel == "manual" and await get_setting(db, KEY_AUTO_CONFIRM_MANUAL, False) is True:
        await confirm_order(db, order.order_no, operator_id=user_id, system=True)
        await db.refresh(order)
    return order


async def get_order(db: AsyncSession, order_no: str) -> PaymentOrder:
    o = (await db.execute(select(PaymentOrder).where(PaymentOrder.order_no == order_no))).scalar_one_or_none()
    if not o:
        raise NotFoundException("订单不存在")
    return o


async def _lock_order(db: AsyncSession, order_no: str) -> PaymentOrder:
    o = (await db.execute(
        select(PaymentOrder).where(PaymentOrder.order_no == order_no).with_for_update()
    )).scalar_one_or_none()
    if not o:
        raise NotFoundException("订单不存在")
    return o


async def confirm_order(
    db: AsyncSession,
    order_no: str,
    operator_id: Optional[UUID] = None,
    channel_order_no: Optional[str] = None,
    amount_paid_cents: Optional[int] = None,
    system: bool = False,
) -> Tuple[PaymentOrder, bool]:
    """订单入账(人工确认 / 回调共用)。幂等: 已 paid 直接返回 (order, True=早已入账)。

    动作: 行锁 → 状态机校验 → credit_service.recharge() → 通知(站内+邮件)。
    """
    order = await _lock_order(db, order_no)
    if order.status == "paid":
        return order, True
    if order.status != "pending":
        raise ConflictException(f"订单状态为 {order.status}, 不能确认入账")

    now = datetime.now(timezone.utc)
    order.status = "paid"
    order.paid_at = now
    order.channel_order_no = channel_order_no or order.channel_order_no
    order.amount_paid_cents = amount_paid_cents if amount_paid_cents is not None else order.amount_cents
    if not system:
        order.confirmed_by = operator_id

    # 入账(积分流水 remark 带订单号, 便于对账)
    await credit_service.recharge(
        db, org_id=order.org_id, amount=order.credits,
        operator_id=operator_id,
        remark=f"充值入账 {order.order_no}",
    )

    # 下单人通知(站内 + 邮件)
    user = (await db.execute(select(User).where(User.id == order.user_id))).scalar_one_or_none()
    credits_total = order.credits
    yuan = f"{order.amount_paid_cents / 100:.2f}"
    await notification_service.push(
        db,
        user_id=order.user_id,
        type=notification_service.TYPE_RECHARGE,
        title=f"充值成功：{credits_total} 积分已到账",
        content=f"订单 {order.order_no} 已完成入账，充值 ¥{yuan}，到账 {credits_total} 积分。",
        link="/credits/recharge",
        ref_id=order.order_no,
        email_html=email_service.tpl_recharge_success(
            (user.nickname if user else None) or "用户", order.order_no, credits_total, yuan),
    )
    await db.commit()
    await db.refresh(order)
    logger.info(f"[Payment] 订单入账 {order.order_no} credits={credits_total} by={operator_id} system={system}")
    return order, False


async def cancel_order(db: AsyncSession, order_no: str, user_id: UUID) -> PaymentOrder:
    """用户取消自己的待支付订单。"""
    order = await _lock_order(db, order_no)
    if order.user_id != user_id:
        raise NotFoundException("订单不存在")
    if order.status != "pending":
        raise ConflictException("仅待支付订单可取消")
    order.status = "cancelled"
    order.remark = "用户取消"
    await db.commit()
    await db.refresh(order)
    return order


async def reject_order(db: AsyncSession, order_no: str, admin_id: UUID, note: str) -> PaymentOrder:
    """管理端驳回(对账不通过)。仅 pending 可驳回。"""
    order = await _lock_order(db, order_no)
    if order.status != "pending":
        raise ConflictException("仅待支付订单可驳回")
    order.status = "failed"
    order.remark = (note or "对账未通过")[:255]
    order.confirmed_by = admin_id
    await db.commit()
    await db.refresh(order)
    return order
