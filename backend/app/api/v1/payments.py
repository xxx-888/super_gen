"""
Payments API - 在线充值(套餐化) / 订单 / 发票申请 / 支付回调

当前渠道策略: 资质(IAP 类目/商户号)未到位时, 走 manual 人工确认通道——
用户下单 → 运营后台对账确认 → 自动入账积分并通知。渠道适配层已预留,
微信/支付宝/IAP 资质到位后在 payment_service 接入, 回调统一打
POST /payments/notify/{channel}。
"""
from uuid import UUID
from typing import Optional
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.api.deps import get_current_org, CommonQueryParams
from app.models import (
    User, Organization, PaymentOrder, PricingPlan,
    InvoiceRequest, Membership,
)
from app.schemas import (
    PaymentStatusResponse, PlanResponse, OrderCreate, OrderResponse,
    InvoiceCreate, InvoiceResponse,
)
from app.services import payment_service, notification_service, email_service
from app.services.payment_service import get_payment_status

router = APIRouter()


def _order_to_resp(db_order: PaymentOrder, invoice_status: Optional[str] = None,
                   user: Optional[User] = None) -> dict:
    """ORM → OrderResponse 兼容字典(带展示辅助字段)。"""
    d = {
        "id": db_order.id, "order_no": db_order.order_no, "org_id": db_order.org_id,
        "user_id": db_order.user_id, "plan_id": db_order.plan_id,
        "plan_snapshot": db_order.plan_snapshot, "amount_cents": db_order.amount_cents,
        "amount_paid_cents": db_order.amount_paid_cents, "credits": db_order.credits,
        "status": db_order.status, "channel": db_order.channel,
        "channel_order_no": db_order.channel_order_no, "paid_at": db_order.paid_at,
        "remark": db_order.remark, "created_at": db_order.created_at,
        "user_email": user.email if user else None,
        "user_nickname": user.nickname if user else None,
        "invoice_status": invoice_status,
    }
    return d


# ==================== 支付状态 & 套餐 ====================

@router.get("/status", response_model=PaymentStatusResponse)
async def payment_status(
    db: AsyncSession = Depends(get_db),
):
    """支付通道开关(资质/备案联动)。前端据此展示可购或筹备中。"""
    return await get_payment_status(db)


@router.get("/plans", response_model=list[PlanResponse])
async def list_plans(
    db: AsyncSession = Depends(get_db),
):
    """上架中的套餐列表(体验版/创作者/工作室...)。"""
    return await payment_service.list_plans(db, only_enabled=True)


# ==================== 订单 ====================

@router.post("/orders", response_model=OrderResponse)
async def create_order(
    body: OrderCreate,
    org: Organization = Depends(get_current_org),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """创建充值订单(payment_enabled 关闭时拒绝)。仅 owner/admin 可下单。"""
    await _ensure_org_admin(db, org.id, current_user)
    order = await payment_service.create_order(db, org.id, current_user.id, body.plan_id, body.channel)
    return _order_to_resp(order)


@router.get("/orders", response_model=list[OrderResponse])
async def list_my_orders(
    status: Optional[str] = Query(None),
    commons: CommonQueryParams = Depends(),
    org: Organization = Depends(get_current_org),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """当前团队的订单列表(分页, 新→旧)。附发票状态。"""
    stmt = select(PaymentOrder).where(PaymentOrder.org_id == org.id)
    if status:
        stmt = stmt.where(PaymentOrder.status == status)
    total_stmt = select(func.count(PaymentOrder.id)).where(PaymentOrder.org_id == org.id)
    if status:
        total_stmt = total_stmt.where(PaymentOrder.status == status)
    total = (await db.execute(total_stmt)).scalar() or 0
    stmt = (stmt.order_by(PaymentOrder.created_at.desc())
            .offset(commons.offset).limit(commons.page_size))
    orders = list((await db.execute(stmt)).scalars().all())

    inv_map = await _invoice_status_map(db, [o.id for o in orders])
    users = await _users_map(db, [o.user_id for o in orders])
    return [
        _order_to_resp(o, inv_map.get(o.id), users.get(o.user_id)) for o in orders
    ]


@router.post("/orders/{order_no}/cancel", response_model=OrderResponse)
async def cancel_order(
    order_no: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """取消自己的待支付订单。"""
    order = await payment_service.cancel_order(db, order_no, current_user.id)
    return _order_to_resp(order)


# ==================== 支付回调 (渠道预留) ====================

@router.post("/notify/{channel}")
async def payment_notify(channel: str, request: Request, db: AsyncSession = Depends(get_db)):
    """渠道支付回调统一入口(无鉴权, 靠验签)。

    wechat/alipay/iap 资质到位后:
      1. 在 payment_service._channel_adapter 中实现 verify + parse
      2. 校验通过后调用 payment_service.confirm_order()(幂等)
    未配置的渠道返回 400, 防止伪造回调。
    """
    cfg = await payment_service.get_payment_status(db)
    if not cfg["enabled"]:
        raise BadRequestException("支付通道未开启")
    if channel == "manual":
        raise BadRequestException("manual 渠道走管理端确认, 无回调")
    # 渠道未接入: 明确拒绝(资质到位后替换为验签+confirm_order)
    raise BadRequestException(f"支付渠道 {channel} 未接入")


# ==================== 发票 ====================

@router.post("/invoices", response_model=InvoiceResponse)
async def create_invoice(
    body: InvoiceCreate,
    org: Organization = Depends(get_current_org),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """对已支付订单申请开票(一单一票)。仅 owner/admin。"""
    await _ensure_org_admin(db, org.id, current_user)
    order = await payment_service.get_order(db, body.order_no)
    if order.org_id != org.id:
        raise NotFoundException("订单不存在")
    if order.status != "paid":
        raise BadRequestException("仅已支付订单可申请开票")
    dup = (await db.execute(
        select(InvoiceRequest).where(InvoiceRequest.order_id == order.id)
    )).scalar_one_or_none()
    if dup:
        raise ConflictException("该订单已申请过发票, 请勿重复提交")

    inv = InvoiceRequest(
        order_id=order.id, order_no=order.order_no, org_id=org.id,
        user_id=current_user.id, amount_cents=order.amount_paid_cents or order.amount_cents,
        title_type=body.title_type, title=body.title.strip(), tax_no=body.tax_no,
        email=body.email, status="pending",
    )
    db.add(inv)
    await db.commit()
    await db.refresh(inv)
    return _invoice_to_resp(inv, current_user)


@router.get("/invoices", response_model=list[InvoiceResponse])
async def list_my_invoices(
    commons: CommonQueryParams = Depends(),
    org: Organization = Depends(get_current_org),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """当前团队发票申请记录。"""
    stmt = (select(InvoiceRequest).where(InvoiceRequest.org_id == org.id)
            .order_by(InvoiceRequest.created_at.desc())
            .offset(commons.offset).limit(commons.page_size))
    invs = list((await db.execute(stmt)).scalars().all())
    users = await _users_map(db, [i.user_id for i in invs])
    return [_invoice_to_resp(i, users.get(i.user_id)) for i in invs]


# ==================== 内部工具 ====================

async def _ensure_org_admin(db: AsyncSession, org_id: UUID, user: User):
    """充值/开票是团队级操作, 仅 owner/admin 可发起。"""
    m = (await db.execute(
        select(Membership).where(
            Membership.org_id == org_id, Membership.user_id == user.id,
            Membership.is_active.is_(True),
        )
    )).scalar_one_or_none()
    if not m or m.role not in ("owner", "admin"):
        raise BadRequestException("仅团队管理员可进行充值与开票操作")


async def _invoice_status_map(db: AsyncSession, order_ids) -> dict:
    if not order_ids:
        return {}
    rows = (await db.execute(
        select(InvoiceRequest.order_id, InvoiceRequest.status)
        .where(InvoiceRequest.order_id.in_(order_ids))
    )).all()
    return {oid: st for oid, st in rows}


async def _users_map(db: AsyncSession, user_ids) -> dict:
    user_ids = [u for u in set(user_ids) if u]
    if not user_ids:
        return {}
    rows = (await db.execute(
        select(User.id, User.email, User.nickname).where(User.id.in_(user_ids))
    )).all()
    return {uid: User(id=uid, email=em, nickname=nick) for uid, em, nick in rows}


def _invoice_to_resp(inv: InvoiceRequest, user: Optional[User] = None) -> dict:
    return {
        "id": inv.id, "order_id": inv.order_id, "order_no": inv.order_no,
        "amount_cents": inv.amount_cents, "title_type": inv.title_type,
        "title": inv.title, "tax_no": inv.tax_no, "email": inv.email,
        "status": inv.status, "admin_note": inv.admin_note,
        "issued_at": inv.issued_at, "created_at": inv.created_at,
        "user_email": user.email if user else None,
    }
