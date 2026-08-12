"""
Canvas API - 画布面板接口

节点画布编辑器：用户在一个画布上拖入节点、连线建立数据流，
纯手搓出完整视频。对标 liblib.tv 的画布创作流程。

路由前缀: /projects/{project_id}/canvas
端点:
- GET    /              画布列表
- POST   /              新建画布
- GET    /{canvas_id}   画布详情(含 graph_data)
- PUT    /{canvas_id}   保存画布(乐观锁)
- DELETE /{canvas_id}   删除画布
- POST   /{canvas_id}/duplicate  复制画布
"""
from uuid import UUID
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import NotFoundException
from app.api.deps import verify_project_ownership, require_project_role
from app.models import User, Project, Canvas
from app.schemas import CanvasCreate, CanvasUpdate

router = APIRouter()


def _to_dict(c: Canvas, with_graph: bool = True) -> Dict[str, Any]:
    """序列化画布。with_graph=False 时省略 graph_data(列表用)。"""
    d = {
        "id": str(c.id),
        "project_id": str(c.project_id),
        "org_id": str(c.org_id) if c.org_id else None,
        "user_id": str(c.user_id),
        "name": c.name,
        "thumbnail_url": c.thumbnail_url,
        "version": c.version,
        "meta": c.meta or {},
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }
    if with_graph:
        d["graph_data"] = c.graph_data or {"nodes": [], "edges": []}
    return d


@router.get("")
async def list_canvases(
    project_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """画布列表(按更新时间倒序，不含 graph_data 以减小体积)"""
    result = await db.execute(
        select(Canvas)
        .where(Canvas.project_id == project_id)
        .order_by(desc(Canvas.updated_at))
    )
    canvases = result.scalars().all()
    return [_to_dict(c, with_graph=False) for c in canvases]


@router.post("", status_code=201)
async def create_canvas(
    project_id: UUID,
    body: CanvasCreate,
    project: Project = Depends(verify_project_ownership),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """新建画布"""
    # 写权限校验
    await require_project_role(["owner", "manager", "editor"])(project_id, db, current_user)

    canvas = Canvas(
        project_id=project_id,
        org_id=project.org_id,
        user_id=current_user.id,
        name=body.name or "未命名画布",
        graph_data=body.graph_data or {"nodes": [], "edges": []},
        version=1,
        meta={},
    )
    db.add(canvas)
    await db.commit()
    await db.refresh(canvas)
    return _to_dict(canvas)


@router.get("/{canvas_id}")
async def get_canvas(
    project_id: UUID,
    canvas_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """画布详情(含 graph_data)"""
    result = await db.execute(
        select(Canvas).where(Canvas.id == canvas_id, Canvas.project_id == project_id)
    )
    canvas = result.scalar_one_or_none()
    if canvas is None:
        raise NotFoundException("Canvas not found", resource="Canvas")
    return _to_dict(canvas)


@router.put("/{canvas_id}")
async def update_canvas(
    project_id: UUID,
    canvas_id: UUID,
    body: CanvasUpdate,
    project: Project = Depends(verify_project_ownership),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """保存画布(带乐观锁校验)"""
    await require_project_role(["owner", "manager", "editor"])(project_id, db, current_user)

    result = await db.execute(
        select(Canvas).where(Canvas.id == canvas_id, Canvas.project_id == project_id)
    )
    canvas = result.scalar_one_or_none()
    if canvas is None:
        raise NotFoundException("Canvas not found", resource="Canvas")

    # 乐观锁：若客户端传了 version 且与当前不一致则拒绝(并发编辑冲突)
    if body.version is not None and body.version != canvas.version:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "画布已被他人修改，请刷新后重试",
                "current_version": canvas.version,
                "client_version": body.version,
            },
        )

    if body.name is not None:
        canvas.name = body.name
    if body.graph_data is not None:
        canvas.graph_data = body.graph_data
    if body.thumbnail_url is not None:
        canvas.thumbnail_url = body.thumbnail_url
    canvas.version = (canvas.version or 1) + 1
    # 更新 meta 中的节点/连线计数(便于列表展示)
    if body.graph_data is not None:
        meta = dict(canvas.meta or {})
        meta["node_count"] = len(body.graph_data.get("nodes", []))
        meta["edge_count"] = len(body.graph_data.get("edges", []))
        meta["last_saved_by"] = str(current_user.id)
        meta["last_saved_at"] = datetime.now(timezone.utc).isoformat()
        canvas.meta = meta

    await db.commit()
    await db.refresh(canvas)
    return _to_dict(canvas)


@router.delete("/{canvas_id}")
async def delete_canvas(
    project_id: UUID,
    canvas_id: UUID,
    project: Project = Depends(verify_project_ownership),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除画布"""
    await require_project_role(["owner", "manager", "editor"])(project_id, db, current_user)

    result = await db.execute(
        select(Canvas).where(Canvas.id == canvas_id, Canvas.project_id == project_id)
    )
    canvas = result.scalar_one_or_none()
    if canvas is None:
        raise NotFoundException("Canvas not found", resource="Canvas")
    await db.delete(canvas)
    await db.commit()
    return {"message": "Deleted"}


@router.post("/{canvas_id}/duplicate", status_code=201)
async def duplicate_canvas(
    project_id: UUID,
    canvas_id: UUID,
    project: Project = Depends(verify_project_ownership),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """复制画布(含 graph_data)"""
    await require_project_role(["owner", "manager", "editor"])(project_id, db, current_user)

    result = await db.execute(
        select(Canvas).where(Canvas.id == canvas_id, Canvas.project_id == project_id)
    )
    src = result.scalar_one_or_none()
    if src is None:
        raise NotFoundException("Canvas not found", resource="Canvas")

    new_canvas = Canvas(
        project_id=project_id,
        org_id=project.org_id,
        user_id=current_user.id,
        name=f"{src.name} (副本)",
        graph_data=src.graph_data or {"nodes": [], "edges": []},
        version=1,
        meta={},
    )
    db.add(new_canvas)
    await db.commit()
    await db.refresh(new_canvas)
    return _to_dict(new_canvas)
