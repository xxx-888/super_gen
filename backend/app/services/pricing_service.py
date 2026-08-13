"""积分计价服务：按 credit_pricing 规则表算价。

设计：
- 每条规则 = (模型? + 任务类型 + 分辨率? + 尺寸?) → 计价方式/单价
- 命中：task_type 精确，其余维度为空即通配、否则精确匹配
- 取「非空维度数(特异性) 最多、其次 priority 最大」的规则
- billing_mode=per_second → credits × max(1, 时长)；fixed → credits
- 无命中返回 None，调用方走 _get_cost 兜底（零回归）
"""
from typing import Any, Dict, Optional
from uuid import UUID
import math

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CreditPricing


async def get_project_org_id(db: AsyncSession, project_id: Optional[UUID]) -> Optional[UUID]:
    """取项目所属团队（扣积分需要 org_id）；项目不存在/无团队返回 None。"""
    if project_id is None:
        return None
    from app.models import Project
    p = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    return p.org_id if p is not None else None


async def charge_for_task(
    db: AsyncSession,
    task_type: str,
    model_id: Optional[UUID],
    params: Optional[Dict[str, Any]],
    *,
    org_id: Optional[UUID],
    user_id: Optional[UUID],
    project_id: Optional[UUID],
    task,                      # GenerationTask 实例（写 credits_consumed / meta.org_tx_id）
    model: Optional[str],
    remark: str,
) -> Optional[Dict[str, Any]]:
    """按计价规则扣费并把流水挂到任务。

    - 规则未命中/积分为 0/无 org → 不扣费，返回 None（任务照常执行，credits_consumed=0）
    - 扣费成功 → task.credits_consumed = cost、meta.org_tx_id、流水.task_id，返回
      charge_info = {org_id, cost, model}（失败时传给 refund_charge 退款）
    - 余额不足等异常原样抛出（调用方应让任务失败、不调模型）
    """
    cost = await resolve_cost(db, task_type, model_id=model_id, params=params)
    if not cost or cost <= 0 or org_id is None:
        return None
    from app.services.credit_service import consume as consume_credits
    tx = await consume_credits(
        db, org_id, cost, user_id=user_id, project_id=project_id,
        model=model or "auto", remark=remark,
    )
    task.credits_consumed = cost
    task.meta = {**(task.meta or {}), "org_tx_id": str(getattr(tx, "id", "") or "")}
    await db.flush()
    if tx is not None and getattr(tx, "id", None) is not None and tx.task_id is None:
        tx.task_id = task.id
        await db.flush()
    return {"org_id": org_id, "cost": cost, "model": model or "auto"}


async def refund_charge(
    db: AsyncSession,
    charge_info: Optional[Dict[str, Any]],
    *,
    user_id: Optional[UUID] = None,
    task_id: Optional[UUID] = None,
    remark: str = "任务失败退还",
) -> None:
    """退还 charge_for_task 扣的积分（未扣费则什么都不做）。"""
    if not charge_info:
        return
    from app.services.credit_service import refund as refund_credits
    await refund_credits(
        db, charge_info["org_id"], charge_info["cost"],
        user_id=user_id, task_id=task_id,
        model=charge_info["model"], remark=remark,
    )


def normalize_resolution(raw: Optional[str]) -> Optional[str]:
    """归一化分辨率：2K/1080p/1440p→'2k'；768P/720p→'768p'；480p→'480p'；其余小写。"""
    if not raw:
        return None
    r = str(raw).strip().lower()
    if r in ("2k", "1080p", "1440p", "1440"):
        return "2k"
    if r in ("768p", "720p", "720", "768"):
        return "768p"
    if r in ("480p", "480"):
        return "480p"
    return r


async def resolve_cost(
    db: AsyncSession,
    task_type: str,
    model_id: Optional[UUID] = None,
    params: Optional[Dict[str, Any]] = None,
) -> Optional[int]:
    """按规则算积分；无命中返回 None（调用方走 _get_cost 兜底）。"""
    params = params or {}
    want_res = normalize_resolution(params.get("resolution"))
    want_size = params.get("size")
    duration = int(params.get("duration", 5) or 5)

    result = await db.execute(
        select(CreditPricing).where(
            CreditPricing.task_type == task_type,
            CreditPricing.is_enabled == True,  # noqa: E712
        )
    )
    best = None  # (specificity, priority, rule)
    for rule in result.scalars().all():
        # 模型维度：规则绑定了具体模型时，必须与请求模型一致
        if rule.ai_model_id is not None:
            if model_id is None or str(rule.ai_model_id) != str(model_id):
                continue
        # 分辨率维度
        if rule.resolution:
            if normalize_resolution(rule.resolution) != want_res:
                continue
        # 尺寸维度
        if rule.size:
            if not want_size or rule.size != want_size:
                continue
        specificity = (
            (1 if rule.ai_model_id is not None else 0)
            + (1 if rule.resolution else 0)
            + (1 if rule.size else 0)
        )
        key = (specificity, rule.priority or 0)
        if best is None or key > (best[0], best[1]):
            best = (specificity, rule.priority or 0, rule)

    if best is None:
        return None
    rule = best[2]
    # credits 允许小数单价；扣费按整数余额，统一向上取整
    if (rule.billing_mode or "fixed") == "per_second":
        return math.ceil((rule.credits or 0) * max(1, duration))
    return math.ceil(rule.credits or 0)
