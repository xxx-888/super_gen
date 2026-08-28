"""
Credits API - 积分接口 (面向当前团队)
"""
from uuid import UUID
from typing import Optional, List
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import NotFoundException
from app.api.deps import get_current_org, CommonQueryParams
from app.models import User, Organization, CreditTransaction, CreditAllocation
from app.schemas import (
    CreditAccountResponse,
    CreditTransactionResponse,
    CreditAllocateRequest,
    CreditAllocationResponse,
)
from app.services.credit_service import get_account, allocate_to_member

router = APIRouter()


@router.get("/account", response_model=CreditAccountResponse)
async def get_my_account(
    org: Organization = Depends(get_current_org),
    db: AsyncSession = Depends(get_db),
):
    """当前团队积分账户"""
    return await get_account(db, org.id)


@router.get("/transactions")
async def list_my_transactions(
    type: Optional[str] = Query(None, description="流水类型: recharge/allocate/consume/refund/adjust"),
    project_id: Optional[UUID] = Query(None),
    search: Optional[str] = Query(None, description="备注/模型模糊搜索"),
    commons: CommonQueryParams = Depends(),
    org: Organization = Depends(get_current_org),
    db: AsyncSession = Depends(get_db),
):
    """当前团队积分流水(筛选/搜索/分页)。

    返回 {items, total, page, page_size, summary}；summary 含近 7 日按日消耗
    趋势（图表用，不受筛选影响）。
    """
    from sqlalchemy import or_, func as sa_func
    from datetime import datetime, timezone, timedelta

    stmt = select(CreditTransaction).where(CreditTransaction.org_id == org.id)
    if type:
        stmt = stmt.where(CreditTransaction.type == type)
    if project_id:
        stmt = stmt.where(CreditTransaction.project_id == project_id)
    if search:
        pat = f"%{search}%"
        stmt = stmt.where(or_(
            CreditTransaction.remark.ilike(pat),
            CreditTransaction.model.ilike(pat),
        ))

    # total（分页器真总数）
    total = (await db.execute(
        select(sa_func.count()).select_from(stmt.subquery())
    )).scalar() or 0

    sort_field, sort_desc = commons.get_sort_params("created_at")
    col = getattr(CreditTransaction, sort_field, CreditTransaction.created_at)
    stmt = stmt.order_by(col.desc() if sort_desc else col.asc())
    stmt = stmt.offset(commons.offset).limit(commons.page_size)

    result = await db.execute(stmt)
    items = [
        {
            "id": str(t.id), "type": t.type, "amount": t.amount,
            "balance_after": t.balance_after, "model": t.model, "remark": t.remark,
            "project_id": str(t.project_id) if t.project_id else None,
            "user_id": str(t.user_id) if t.user_id else None,
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in result.scalars().all()
    ]

    # 近 7 日按日消耗趋势（北京时间；consume/refund 计入，正负抵后为当日净消耗）
    tz8 = timezone(timedelta(hours=8))
    week_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6)
    trend_rows = (await db.execute(
        select(
            sa_func.to_char(sa_func.timezone("Asia/Shanghai", CreditTransaction.created_at), "YYYY-MM-DD"),
            sa_func.coalesce(sa_func.sum(CreditTransaction.amount), 0),
        ).where(
            CreditTransaction.org_id == org.id,
            CreditTransaction.type.in_(("consume", "refund", "recharge")),
            CreditTransaction.created_at >= week_start,
        ).group_by(1)
    )).all()
    by_day = {d: amt for d, amt in trend_rows}
    trend = []
    for i in range(7):
        day = (week_start + timedelta(days=i)).strftime("%Y-%m-%d")
        trend.append({"date": day, "amount": by_day.get(day, 0)})

    return {
        "items": items, "total": total,
        "page": commons.page, "page_size": commons.page_size,
        "summary": {"trend_7d": trend},
    }


@router.get("/allocations", response_model=List[CreditAllocationResponse])
async def list_my_allocations(
    org: Organization = Depends(get_current_org),
    db: AsyncSession = Depends(get_db),
):
    """当前团队成员积分配额列表"""
    result = await db.execute(
        select(CreditAllocation).where(CreditAllocation.org_id == org.id)
    )
    return list(result.scalars().all())


@router.post("/allocate", response_model=CreditAllocationResponse)
async def allocate_credits(
    body: CreditAllocateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
):
    """给成员分配积分配额(owner/admin).

    amount 正数=增加配额, 负数=回收.
    """
    await _ensure_admin(db, org.id, current_user.id)
    return await allocate_to_member(
        db, org.id, body.user_id, body.amount,
        operator_id=current_user.id, remark=body.remark,
    )


# ==================== 内部工具 ====================

async def _ensure_admin(db: AsyncSession, org_id: UUID, user_id: UUID):
    """校验当前用户是团队 owner/admin"""
    from app.services.organization_service import get_user_role_in_org
    role = await get_user_role_in_org(db, user_id, org_id)
    if role not in ("owner", "admin"):
        raise NotFoundException("Admin access required for this organization", resource="Organization")
