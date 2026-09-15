"""
ORM Models - 通知中心 / 在线支付(套餐化) / 发票

设计要点:
- Notification: 站内消息中心统一通道。所有业务事件(生成完成/失败、充值成功、
  发票审核结果、系统公告)都落这里; 邮件推送由 notification_service 异步联动,
  不依赖调用方事务。
- PricingPlan: 积分充值套餐(体验版/创作者/工作室...), 后台可维护。
  金额一律用「分」(int) 存储, 展示层换算为元, 避免浮点精度问题。
- PaymentOrder: 充值订单。渠道 manual(人工确认, 资质未到位时的兜底通道) /
  wechat_native / alipay_qr / iap(预留)。状态机:
      pending → paid    (回调入账/人工确认, 幂等)
      pending → cancelled (用户取消/超时关闭)
      paid    → refunded  (异常退款)
  入账动作: credit_service.recharge() + 流水 meta 记订单号。
- InvoiceRequest: 发票申请(一单一票), 管理端审核开票, 结果走通知通道。
"""
from datetime import datetime
from uuid import uuid4
from sqlalchemy import (
    Column, String, Text, Boolean, Integer, Float, DateTime,
    ForeignKey, JSON, UniqueConstraint, Index
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.models import Base, TimestampMixin


# ==================== 通知中心 ====================

class Notification(Base, TimestampMixin):
    """站内通知 (统一消息通道)

    type:
        generation - 生成任务结果(完成/失败)
        recharge   - 充值入账
        invoice    - 发票审核结果
        system     - 系统公告/其他
    link: 前端跳转路由(如 /projects/{pid}/videos), 可空
    """
    __tablename__ = "notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    type = Column(String(20), nullable=False, default="system", index=True)
    title = Column(String(255), nullable=False)
    content = Column(Text)
    link = Column(String(512))
    ref_id = Column(String(64))            # 业务关联 ID(订单号/任务ID等, 便于跳转与去重)
    is_read = Column(Boolean, default=False, nullable=False, index=True)
    read_at = Column(DateTime(timezone=True))
    email_sent = Column(Boolean, default=False, nullable=False)  # 邮件联动结果(诊断用)

    user = relationship("User")

    __table_args__ = (
        Index("ix_notification_user_read", "user_id", "is_read", "created_at"),
    )

    def __repr__(self):
        return f"<Notification {self.type} to={self.user_id} read={self.is_read}>"


# ==================== 在线支付 ====================

class PricingPlan(Base, TimestampMixin):
    """积分充值套餐 (体验版/创作者/工作室...)

    price_cents: 售价(分)。credits: 到账积分。bonus_credits: 加赠积分(展示用)。
    features: 权益点列表(JSON 数组, 套餐卡片展示)。
    is_enabled=False 或全局 payment_enabled=False 时不可购买。
    """
    __tablename__ = "pricing_plans"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    code = Column(String(30), unique=True, nullable=False)  # trial/creator/studio
    name = Column(String(100), nullable=False)
    tagline = Column(String(255))                 # 一句话卖点
    price_cents = Column(Integer, nullable=False) # 售价(分)
    original_price_cents = Column(Integer)        # 划线原价(分, 可空)
    credits = Column(Integer, nullable=False)     # 到账积分
    bonus_credits = Column(Integer, default=0)    # 加赠积分
    valid_days = Column(Integer, default=0)       # 有效期天数, 0=永久
    features = Column(JSONB, default=list)        # 权益点列表
    badge = Column(String(30))                    # 角标文案(如「最受欢迎」)
    sort_order = Column(Integer, default=0)
    is_enabled = Column(Boolean, default=True, nullable=False)

    def __repr__(self):
        return f"<PricingPlan {self.code} {self.price_cents}分/{self.credits}积分>"


class PaymentOrder(Base, TimestampMixin):
    """充值订单

    status: pending(待支付) / paid(已支付已入账) / cancelled(已取消) /
            failed(支付失败) / refunded(已退款)
    channel: manual(人工确认)/ wechat_native / alipay_qr / iap —— 预留渠道名,
             资质到位后在 payment_service 的渠道适配层接入, 回调统一走
             POST /payments/notify/{channel}。
    plan_snapshot: 下单时套餐快照(价格/积分), 防止后台改套餐影响已下单据。
    amount_paid_cents: 实付金额(回调覆盖, 人工确认等于应付金额)。
    """
    __tablename__ = "payment_orders"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    order_no = Column(String(32), unique=True, nullable=False, index=True)  # SOyyyyMMdd + 随机
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)  # 下单人
    plan_id = Column(UUID(as_uuid=True), ForeignKey("pricing_plans.id", ondelete="SET NULL"))
    plan_snapshot = Column(JSONB, nullable=False)  # {code,name,price_cents,credits,bonus_credits}
    amount_cents = Column(Integer, nullable=False)  # 应付金额(分)
    amount_paid_cents = Column(Integer)             # 实付金额(分)
    credits = Column(Integer, nullable=False)       # 应入账积分(不含加赠展示口径: credits+bonus_credits)
    status = Column(String(20), default="pending", nullable=False, index=True)
    channel = Column(String(20), default="manual", nullable=False)  # manual/wechat_native/alipay_qr/iap
    channel_order_no = Column(String(128))          # 渠道流水号(微信/支付宝/IAP 回单)
    paid_at = Column(DateTime(timezone=True))
    confirmed_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))  # 人工确认人(manual 渠道)
    remark = Column(String(255))
    meta = Column(JSONB, default=dict)              # 回调原文/扩展

    plan = relationship("PricingPlan")
    user = relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        Index("ix_payment_order_org_status", "org_id", "status"),
        Index("ix_payment_order_channel_no", "channel", "channel_order_no"),
    )

    def __repr__(self):
        return f"<PaymentOrder {self.order_no} {self.status} {self.amount_cents}分>"


# ==================== 发票申请 ====================

class InvoiceRequest(Base, TimestampMixin):
    """发票申请 (一单一票)

    status: pending(待处理) / issued(已开票) / rejected(已驳回)
    title_type: personal(个人) / company(企业)
    """
    __tablename__ = "invoice_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    order_id = Column(UUID(as_uuid=True), ForeignKey("payment_orders.id", ondelete="CASCADE"),
                      nullable=False)
    order_no = Column(String(32), nullable=False, index=True)  # 冗余, 免联表展示
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)  # 申请人
    amount_cents = Column(Integer, nullable=False)  # 开票金额(分)
    title_type = Column(String(10), default="company", nullable=False)  # personal/company
    title = Column(String(255), nullable=False)     # 抬头
    tax_no = Column(String(50))                     # 税号(企业必填)
    email = Column(String(255), nullable=False)     # 接收邮箱
    status = Column(String(20), default="pending", nullable=False, index=True)
    admin_note = Column(String(500))                # 驳回原因/备注
    issued_at = Column(DateTime(timezone=True))

    order = relationship("PaymentOrder", foreign_keys=[order_id])
    user = relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        UniqueConstraint("order_id", name="uq_invoice_one_per_order"),
    )

    def __repr__(self):
        return f"<InvoiceRequest {self.order_no} {self.status}>"
