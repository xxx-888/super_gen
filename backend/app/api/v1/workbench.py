"""
Workbench & Showcase API - 工作台与作品展示接口 (M6)

路由:
- /workbench/narration        解说剧一键成片
- /workbench/video-transfer   一键转绘
- /workbench/my-works         我的作品
- /showcase/public            公开画廊
- /showcase/{work_id}         作品详情
- /showcase/publish           发布作品
- /showcase/{work_id}         更新/删除作品
- /showcase/{work_id}/like    点赞
"""
from uuid import UUID
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user, get_optional_user
from app.api.deps import get_current_org
from app.models import User, Organization
from app.schemas import (
    NarrationOneClickRequest, VideoTransferRequest,
    PublishWorkRequest, UpdateWorkRequest,
)
from app.services import work_service

workbench_router = APIRouter()
showcase_router = APIRouter()


# ==================== 工作台 ====================

@workbench_router.post("/narration")
async def narration_one_click(
    body: NarrationOneClickRequest,
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    db: AsyncSession = Depends(get_db),
):
    """解说剧一键成片(剧本->配音+配图->合成)"""
    return await work_service.narration_one_click(
        db, org.id, current_user.id, body.script_content, body.title, body.voice_id
    )


@workbench_router.post("/video-transfer")
async def video_transfer(
    body: VideoTransferRequest,
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    db: AsyncSession = Depends(get_db),
):
    """一键转绘(视频->风格化图像)"""
    return await work_service.video_to_style_transfer(
        db, org.id, current_user.id, body.video_url, body.style, body.frame_count
    )


@workbench_router.get("/my-works")
async def my_works(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """我的作品"""
    return await work_service.list_my_works(db, current_user.id)


# ==================== 作品展示 ====================

@showcase_router.get("/public")
async def public_showcase(
    page: int = Query(1, ge=1),
    page_size: int = Query(24, ge=1, le=100),
    tag: Optional[str] = Query(None),
    search: Optional[str] = Query(None, description="标题/描述搜索"),
    sort: str = Query("latest", description="latest 最新 / likes 最多点赞 / views 最多浏览"),
    db: AsyncSession = Depends(get_db),
    viewer: Optional[User] = Depends(get_optional_user),
):
    """公开画廊(瀑布流). 登录时附带 liked_by_me"""
    return await work_service.list_public_works(
        db, page, page_size, tag, viewer_id=viewer.id if viewer else None,
        search=search, sort=sort,
    )


@showcase_router.get("/{work_id}")
async def get_work(
    work_id: UUID,
    db: AsyncSession = Depends(get_db),
    viewer: Optional[User] = Depends(get_optional_user),
):
    """作品详情(浏览+1). 登录时附带 liked_by_me"""
    w = await work_service.get_work(db, work_id)
    liked = False
    if viewer:
        liked_ids = await work_service.get_liked_work_ids(db, viewer.id, [w.id])
        liked = w.id in liked_ids
    return work_service._to_dict(w, liked=liked)


@showcase_router.post("/publish", status_code=201)
async def publish_work(
    body: PublishWorkRequest,
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    db: AsyncSession = Depends(get_db),
):
    """发布作品"""
    w = await work_service.publish_work(
        db, current_user.id, body.project_id, body.episode_id,
        body.title, body.description, body.video_url, body.cover_url,
        body.tags, org.id,
    )
    return work_service._to_dict(w)


@showcase_router.put("/{work_id}")
async def update_work(
    work_id: UUID,
    body: UpdateWorkRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """更新作品"""
    w = await work_service.update_work(
        db, work_id, current_user.id, body.title, body.description,
        body.cover_url, body.video_url, body.tags, body.is_public,
    )
    return work_service._to_dict(w)


@showcase_router.delete("/{work_id}")
async def delete_work(
    work_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除作品"""
    await work_service.delete_work(db, work_id, current_user.id)
    return {"message": "Deleted"}


@showcase_router.post("/{work_id}/like")
async def like_work(
    work_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """点赞/取消点赞(需登录, 同一用户对同一作品切换)"""
    w, liked = await work_service.toggle_like(db, work_id, current_user.id)
    return {"like_count": w.like_count, "liked": liked}
