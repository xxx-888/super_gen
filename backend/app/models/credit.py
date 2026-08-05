"""
ORM Models - 积分系统

设计要点 (对标目标网站):
- 每个团队(Organization)拥有一个 CreditAccount, 记录可用/已分配/累计充值/累计消耗.
- CreditTransaction 记录所有积分变动流水 (充值/分配/消耗/退还/调整), 便于审计与统计.
- CreditAllocation 记录成员的个人配额 (团队给成员分配的额度), 用于成员级积分管理.
- 扣减积分必须使用行级锁 (SELECT ... FOR UPDATE) 防止并发超扣, 由 verify_credits 依赖统一处理.
"""
from datetime import datetime
from uuid import uuid4
from sqlalchemy import (
    Column, String, Text, Boolean, Integer, DateTime,
    ForeignKey, JSON, UniqueConstraint, Index
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.models import Base, TimestampMixin


class CreditAccount(Base, TimestampMixin):
    """积分账户 (每个团队一个)

    balance:        团队当前可用总积分
    allocated:      已分配给成员的积分总和 (<= balance - 预留)
    total_recharged:累计充值
    total_consumed: 累计消耗
    """
    __tablename__ = "credit_accounts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False, unique=True)
    balance = Column(Integer, default=0, nullable=False)
    allocated = Column(Integer, default=0, nullable=False)
    total_recharged = Column(Integer, default=0, nullable=False)
    total_consumed = Column(Integer, default=0, nullable=False)

    # 关系
    org = relationship("Organization", back_populates="credit_account")

    def __repr__(self):
        return f"<CreditAccount {self.org_id} balance={self.balance}>"


class CreditTransaction(Base, TimestampMixin):
    """积分流水 (审计日志)

    type:
        recharge  - 充值 (后台/支付)
        allocate  - 分配给成员 (balance 不变, allocated 增加)
        consume   - 消耗 (生成任务扣费)
        refund    - 退还 (任务失败退回)
        adjust    - 手动调整
    amount: 正数=增加, 负数=扣减
    balance_after: 该笔交易后账户余额 (快照, 便于对账)
    """
    __tablename__ = "credit_transactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))  # 经手人(可空, 系统操作)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"))  # 关联项目(消耗时)
    task_id = Column(UUID(as_uuid=True), ForeignKey("generation_tasks.id"))  # 关联任务
    type = Column(String(20), nullable=False)  # recharge/allocate/consume/refund/adjust
    amount = Column(Integer, nullable=False)
    balance_after = Column(Integer, nullable=False)
    model = Column(String(50))  # 消耗时记录的模型标识
    remark = Column(String(255))  # 备注
    meta = Column(JSONB, default=dict)  # 扩展(订单号、分配目标用户等)

    # 关系
    org = relationship("Organization", back_populates="credit_transactions")

    __table_args__ = (
        Index("ix_credit_tx_org_created", "org_id", "created_at"),
        Index("ix_credit_tx_type", "type"),
        Index("ix_credit_tx_project", "project_id"),
    )

    def __repr__(self):
        return f"<CreditTx {self.type} {self.amount} @ {self.created_at}>"


class CreditAllocation(Base, TimestampMixin):
    """成员积分配额 (团队给成员分配的额度)

    quota: 团队分配给该成员的额度
    used:  该成员已消耗
    可用 = quota - used
    """
    __tablename__ = "credit_allocations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    quota = Column(Integer, default=0, nullable=False)
    used = Column(Integer, default=0, nullable=False)

    __table_args__ = (
        UniqueConstraint("org_id", "user_id", name="uq_credit_alloc_org_user"),
    )

    def __repr__(self):
        return f"<CreditAlloc {self.user_id} {self.used}/{self.quota}>"
