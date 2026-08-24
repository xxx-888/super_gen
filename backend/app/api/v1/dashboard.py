"""
Dashboard API - 用户工作台聚合

GET /dashboard/summary?org_id=：一次返回工作台概览所需的全部数据，
前端无需拼装多个接口（此前工作台从 /projects 前端分页里数项目数、
进行中任务从未加载）。数据均按当前用户维度统计（项目为其名下），
积分部分按团队（org_id 或用户的 active_org）。
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import CreditAccount, CreditTransaction, GenerationTask, Project, Scene, Script, User

router = APIRouter()


@router.get("/summary")
async def dashboard_summary(
    org_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """用户工作台聚合：项目/分镜/任务统计、近7日趋势、进行中任务、积分与流水。"""
    uid = current_user.id

    tz8 = timezone(timedelta(hours=8))
    week_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6)

    # ---- 项目：总数 + 最近 5 个 ----
    total_projects = (await db.execute(
        select(func.count(Project.id)).where(Project.user_id == uid)
    )).scalar() or 0
    recent_projects = (await db.execute(
        select(Project).where(Project.user_id == uid)
        .order_by(Project.updated_at.desc()).limit(5)
    )).scalars().all()

    # ---- 分镜：用户名下项目的分镜总数（Scene 挂在 Script 下，Script 挂在 Project 下） ----
    total_scenes = (await db.execute(
        select(func.count(Scene.id))
        .join(Script, Scene.script_id == Script.id)
        .join(Project, Script.project_id == Project.id)
        .where(Project.user_id == uid)
    )).scalar() or 0

    # ---- 任务：总量 / 状态分布 / 已生成视频数 / 趋势 / 进行中 ----
    tasks_by_status = dict((await db.execute(
        select(GenerationTask.status, func.count(GenerationTask.id)).where(
            GenerationTask.user_id == uid,
            GenerationTask.deleted_at.is_(None),
        ).group_by(GenerationTask.status)
    )).all())
    total_tasks = sum(tasks_by_status.values())
    videos_generated = (await db.execute(
        select(func.count(GenerationTask.id)).where(
            GenerationTask.user_id == uid,
            GenerationTask.deleted_at.is_(None),
            GenerationTask.type == "video",
            GenerationTask.status == "completed",
        )
    )).scalar() or 0

    daily_rows = (await db.execute(
        select(
            func.to_char(func.timezone("Asia/Shanghai", GenerationTask.created_at), "MM-DD").label("d"),
            func.count(GenerationTask.id),
            func.count(case((GenerationTask.status == "failed", 1))),
        ).where(
            GenerationTask.user_id == uid,
            GenerationTask.deleted_at.is_(None),
            GenerationTask.created_at >= week_start,
        ).group_by("d")
    )).all()
    daily_map = {d: (c, f) for d, c, f in daily_rows}
    now_bj = datetime.now(tz8)
    tasks_daily: List[Dict[str, Any]] = []
    for i in range(7):
        day = (now_bj - timedelta(days=6 - i)).strftime("%m-%d")
        c, f = daily_map.get(day, (0, 0))
        tasks_daily.append({"date": day, "count": c, "failed": f})

    running_tasks = (await db.execute(
        select(GenerationTask).where(
            GenerationTask.user_id == uid,
            GenerationTask.deleted_at.is_(None),
            GenerationTask.status.in_(["pending", "processing"]),
        ).order_by(GenerationTask.created_at.desc()).limit(5)
    )).scalars().all()

    # ---- 积分：团队账户余额 + 最近 5 笔流水 ----
    target_org = org_id or current_user.active_org_id
    credits: Dict[str, Any] = {"balance": None, "recent_transactions": []}
    if target_org is not None:
        account = (await db.execute(
            select(CreditAccount).where(CreditAccount.org_id == target_org)
        )).scalar_one_or_none()
        if account:
            credits["balance"] = account.balance
        tx_rows = (await db.execute(
            select(CreditTransaction).where(CreditTransaction.org_id == target_org)
            .order_by(CreditTransaction.created_at.desc()).limit(5)
        )).scalars().all()
        tx_type_label = {"recharge": "充值", "allocate": "分配", "consume": "消耗",
                         "refund": "退还", "adjust": "调整"}
        credits["recent_transactions"] = [
            {
                "type": t.type,
                "type_label": tx_type_label.get(t.type, t.type),
                "amount": t.amount,
                "remark": (t.remark or "")[:60],
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in tx_rows
        ]

    # ---- 任务成功率（有样本才算） ----
    completed = tasks_by_status.get("completed", 0)
    failed = tasks_by_status.get("failed", 0)
    finished = completed + failed
    success_rate = round(completed / finished * 100, 1) if finished else None

    return {
        "total_projects": total_projects,
        "total_scenes": total_scenes,
        "total_tasks": total_tasks,
        "videos_generated": videos_generated,
        "tasks_by_status": tasks_by_status,
        "task_success_rate": success_rate,
        "tasks_daily": tasks_daily,
        "recent_projects": [
            {
                "id": str(p.id), "name": p.name, "status": p.status,
                "scene_count": None, "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            }
            for p in recent_projects
        ],
        "running_tasks": [
            {
                "id": str(t.id), "type": t.type, "status": t.status,
                "progress": t.progress or 0, "model": t.model,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in running_tasks
        ],
        "credits": credits,
    }
