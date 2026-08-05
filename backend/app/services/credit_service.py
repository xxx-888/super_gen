"""
Credit Service - 积分系统核心业务逻辑

职责:
- 创建组织时初始化积分账户
- 充值 / 分配 / 消耗 / 退还 (均写流水)
- 提供带行级锁的扣减原语, 防止并发超扣

并发安全说明:
- 扣减/退还必须在事务中, 使用 SELECT ... FOR UPDATE 锁定 CreditAccount 行.
- get_db 依赖会在请求结束时 commit, 这里所有写操作 flush 后由依赖统一提交.
"""
from uuid import UUID
from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.exceptions import (
    NotFoundException,
    BadRequestException,
    QuotaExceededException,
)
from app.models import (
    Organization,
    Membership,
    CreditAccount,
    CreditTransaction,
    CreditAllocation,
)


# ==================== 账户初始化 ====================

async def init_credit_account(
    db: AsyncSession,
    org_id: UUID,
    initial_balance: Optional[int] = None,
) -> CreditAccount:
    """为新组织初始化积分账户.

    personal org 默认赠送 CREDITS_INITIAL_BALANCE; 真实团队默认 0(待充值).
    """
    balance = (
        initial_balance
        if initial_balance is not None
        else settings.CREDITS_INITIAL_BALANCE
    )
    account = CreditAccount(
        org_id=org_id,
        balance=balance,
        allocated=0,
        total_recharged=balance,  # 初始赠送视为已充值
        total_consumed=0,
    )
    db.add(account)
    await db.flush()

    # 写入初始流水(便于审计)
    if balance != 0:
        tx = CreditTransaction(
            org_id=org_id,
            type="recharge",
            amount=balance,
            balance_after=balance,
            remark="初始化赠送" if balance > 0 else None,
        )
        db.add(tx)
    await db.flush()
    return account


# ==================== 充值 ====================

async def recharge(
    db: AsyncSession,
    org_id: UUID,
    amount: int,
    operator_id: Optional[UUID] = None,
    remark: Optional[str] = None,
) -> CreditAccount:
    """充值(后台手动/支付回调). amount 必须为正."""
    if amount <= 0:
        raise BadRequestException("Recharge amount must be positive")

    account = await _lock_account(db, org_id)
    account.balance += amount
    account.total_recharged += amount
    await db.flush()

    db.add(CreditTransaction(
        org_id=org_id,
        user_id=operator_id,
        type="recharge",
        amount=amount,
        balance_after=account.balance,
        remark=remark or "手动充值",
    ))
    await db.flush()
    return account


# ==================== 分配给成员 ====================

async def allocate_to_member(
    db: AsyncSession,
    org_id: UUID,
    user_id: UUID,
    delta: int,
    operator_id: Optional[UUID] = None,
    remark: Optional[str] = None,
) -> CreditAllocation:
    """给成员分配积分配额.

    delta > 0: 增加配额; delta < 0: 回收配额.
    分配不改变账户 balance, 只改变 allocated (预占额度).
    回收时不能超过已分配净额.
    """
    account = await _lock_account(db, org_id)
    if delta == 0:
        raise BadRequestException("Allocate delta must be non-zero")

    # 查/建成员配额记录
    result = await db.execute(
        select(CreditAllocation).where(
            CreditAllocation.org_id == org_id,
            CreditAllocation.user_id == user_id,
        )
    )
    alloc = result.scalar_one_or_none()
    if alloc is None:
        if delta < 0:
            raise BadRequestException("No allocation to reclaim")
        alloc = CreditAllocation(org_id=org_id, user_id=user_id, quota=0, used=0)
        db.add(alloc)
        await db.flush()

    new_quota = alloc.quota + delta
    if new_quota < alloc.used:
        raise BadRequestException("Cannot reclaim below already-used amount")
    if delta > 0 and account.balance - account.allocated < delta:
        raise QuotaExceededException(
            "Insufficient unallocated balance in account", quota_type="credits"
        )

    alloc.quota = new_quota
    account.allocated += delta
    await db.flush()

    db.add(CreditTransaction(
        org_id=org_id,
        user_id=operator_id,
        type="allocate",
        amount=delta,
        balance_after=account.balance,
        remark=remark or "成员配额调整",
        meta={"target_user": str(user_id)},
    ))
    await db.flush()
    return alloc


# ==================== 消耗 / 退还 (任务扣费) ====================

async def consume(
    db: AsyncSession,
    org_id: UUID,
    amount: int,
    user_id: Optional[UUID] = None,
    project_id: Optional[UUID] = None,
    task_id: Optional[UUID] = None,
    model: Optional[str] = None,
    remark: Optional[str] = None,
) -> CreditTransaction:
    """消耗积分 (生成任务扣费).

    若 settings.CREDITS_ENABLED 为 False, 跳过扣费并返回占位流水(便于开发联调).
    """
    if not settings.CREDITS_ENABLED:
        return CreditTransaction(
            org_id=org_id, user_id=user_id, project_id=project_id, task_id=task_id,
            type="consume", amount=0, balance_after=0, model=model,
            remark="credits disabled", meta={"skipped": True},
        )
    if amount <= 0:
        raise BadRequestException("Consume amount must be positive")

    account = await _lock_account(db, org_id)
    if account.balance < amount:
        raise QuotaExceededException(
            f"Insufficient credits: need {amount}, have {account.balance}",
            quota_type="credits",
        )

    account.balance -= amount
    account.total_consumed += amount
    await db.flush()

    tx = CreditTransaction(
        org_id=org_id,
        user_id=user_id,
        project_id=project_id,
        task_id=task_id,
        type="consume",
        amount=-amount,
        balance_after=account.balance,
        model=model,
        remark=remark,
    )
    db.add(tx)
    await db.flush()
    return tx


async def refund(
    db: AsyncSession,
    org_id: UUID,
    amount: int,
    user_id: Optional[UUID] = None,
    task_id: Optional[UUID] = None,
    model: Optional[str] = None,
    remark: Optional[str] = None,
) -> CreditTransaction:
    """退还积分 (任务失败退回)."""
    if amount <= 0:
        raise BadRequestException("Refund amount must be positive")

    account = await _lock_account(db, org_id)
    account.balance += amount
    account.total_consumed = max(0, account.total_consumed - amount)
    await db.flush()

    tx = CreditTransaction(
        org_id=org_id,
        user_id=user_id,
        task_id=task_id,
        type="refund",
        amount=amount,
        balance_after=account.balance,
        model=model,
        remark=remark or "任务失败退还",
    )
    db.add(tx)
    await db.flush()
    return tx


# ==================== 内部工具 ====================

async def _lock_account(db: AsyncSession, org_id: UUID) -> CreditAccount:
    """以行级锁查询账户, 防止并发超扣."""
    result = await db.execute(
        select(CreditAccount)
        .where(CreditAccount.org_id == org_id)
        .with_for_update()
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise NotFoundException("Credit account not found for org", resource="CreditAccount")
    return account


async def get_account(db: AsyncSession, org_id: UUID) -> CreditAccount:
    """只读获取账户(不加锁)."""
    result = await db.execute(
        select(CreditAccount).where(CreditAccount.org_id == org_id)
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise NotFoundException("Credit account not found for org", resource="CreditAccount")
    return account
