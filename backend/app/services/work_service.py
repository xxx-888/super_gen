"""
Work & Workbench Service - 作品展示与工作台业务逻辑 (M6)

工作台(对标 ai_tools):
- 解说剧一键成片: 输入剧本 -> 解析分镜 -> 生成 -> 合成 (编排流水线骨架)
- 一键转绘: 上传视频 -> AI 提取画面 -> 转风格化图像
- 我的作品

作品展示(对标 work_showcase):
- 发布作品(项目/集 -> 作品)
- 公开画廊(瀑布流)
- 点赞/浏览
"""
from uuid import UUID, uuid4
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import NotFoundException, BadRequestException
from app.models import Work, Project, Episode
from app.services.creation_service import submit_creation


# ==================== 作品 CRUD ====================

async def list_public_works(
    db: AsyncSession, page: int = 1, page_size: int = 24, tag: Optional[str] = None
) -> Dict[str, Any]:
    """公开画廊(瀑布流)."""
    stmt = select(Work).where(Work.is_public == True)
    if tag:
        stmt = stmt.where(Work.tags.contains([tag]))
    # 总数
    count_stmt = select(func.count()).select_from(
        select(Work).where(Work.is_public == True).subquery()
    )
    total_result = await db.execute(count_stmt)
    total = total_result.scalar() or 0

    stmt = stmt.order_by(Work.published_at.desc().nullslast(), Work.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(stmt)
    works = result.scalars().all()
    return {"items": [_to_dict(w) for w in works], "total": total, "page": page, "page_size": page_size}


async def list_my_works(db: AsyncSession, user_id: UUID) -> List[Dict[str, Any]]:
    """我的作品."""
    result = await db.execute(
        select(Work).where(Work.user_id == user_id).order_by(Work.created_at.desc())
    )
    return [_to_dict(w) for w in result.scalars().all()]


async def get_work(db: AsyncSession, work_id: UUID) -> Work:
    r = await db.execute(select(Work).where(Work.id == work_id))
    w = r.scalar_one_or_none()
    if w is None:
        raise NotFoundException("Work not found", resource="Work")
    # 浏览+1
    w.view_count = (w.view_count or 0) + 1
    await db.flush()
    return w


async def publish_work(
    db: AsyncSession, user_id: UUID,
    project_id: Optional[UUID] = None, episode_id: Optional[UUID] = None,
    title: Optional[str] = None, description: Optional[str] = None,
    video_url: Optional[str] = None, cover_url: Optional[str] = None,
    tags: Optional[List[str]] = None, org_id: Optional[UUID] = None,
) -> Work:
    """发布作品(从项目/集或直接上传)."""
    # 自动取标题
    if title is None:
        if project_id:
            pr = await db.execute(select(Project).where(Project.id == project_id))
            p = pr.scalar_one_or_none()
            title = p.name if p else "未命名作品"
        else:
            title = "未命名作品"

    work = Work(
        org_id=org_id, user_id=user_id, project_id=project_id, episode_id=episode_id,
        title=title, description=description, video_url=video_url, cover_url=cover_url,
        source_type="project" if project_id else "upload",
        is_public=True, published_at=datetime.now(timezone.utc),
        tags=tags or [],
    )
    db.add(work)
    await db.flush()
    await db.refresh(work)
    return work


async def update_work(
    db: AsyncSession, work_id: UUID, user_id: UUID,
    title: Optional[str] = None, description: Optional[str] = None,
    cover_url: Optional[str] = None, video_url: Optional[str] = None,
    tags: Optional[List[str]] = None, is_public: Optional[bool] = None,
) -> Work:
    w = await get_work(db, work_id)
    if w.user_id != user_id:
        raise BadRequestException("You can only edit your own works")
    if title is not None: w.title = title
    if description is not None: w.description = description
    if cover_url is not None: w.cover_url = cover_url
    if video_url is not None: w.video_url = video_url
    if tags is not None: w.tags = tags
    if is_public is not None:
        w.is_public = is_public
        if is_public and w.published_at is None:
            w.published_at = datetime.now(timezone.utc)
    await db.flush()
    await db.refresh(w)
    return w


async def delete_work(db: AsyncSession, work_id: UUID, user_id: UUID) -> None:
    w = await get_work(db, work_id)
    if w.user_id != user_id:
        raise BadRequestException("You can only delete your own works")
    await db.delete(w)
    await db.flush()


async def like_work(db: AsyncSession, work_id: UUID) -> Work:
    w = await get_work(db, work_id)
    w.like_count = (w.like_count or 0) + 1
    await db.flush()
    return w


# ==================== 工作台: 解说剧一键成片 ====================

async def narration_one_click(
    db: AsyncSession, org_id: UUID, user_id: UUID,
    script_content: str, title: Optional[str] = None,
    voice_id: Optional[str] = None,
) -> Dict[str, Any]:
    """解说剧一键成片(骨架).

    流程:
    1. 剧本分段(简化: 按句号/换行切分)
    2. 每段 TTS 配音 + 融合生图
    3. (M6 骨架: 返回分段结果, 后续接真实合成)

    返回分段创作结果摘要.
    """
    if not script_content.strip():
        raise BadRequestException("剧本内容不能为空")

    # 简单分段: 按换行/句号
    import re
    segments = [s.strip() for s in re.split(r'[\n。！？]', script_content) if len(s.strip()) > 5]
    if not segments:
        segments = [script_content[:50]]

    # 限制段数(避免大量扣分), M6 骨架取前3段演示
    segments = segments[:3]

    results = []
    total_cost = 0
    for idx, seg in enumerate(segments):
        # TTS 配音
        tts_res = await submit_creation(
            db, org_id, user_id, "tts",
            {"text": seg, "voice_id": voice_id or "narrator"},
            model="tts",
        )
        # 融合生图(用文本描述生成配图)
        img_res = await submit_creation(
            db, org_id, user_id, "fusion",
            {"prompt": seg[:80], "size": "16:9", "count": 1},
            model="fusion",
        )
        total_cost += tts_res["credits_consumed"] + img_res["credits_consumed"]
        results.append({
            "segment": idx + 1,
            "text": seg,
            "audio_url": tts_res["urls"][0] if tts_res["urls"] else None,
            "image_url": img_res["urls"][0] if img_res["urls"] else None,
        })

    # 生成占位合成视频(后续接真实视频合成)
    uid = uuid4().hex[:12]
    video_url = f"https://placeholder.scenegen.com/narration/{uid}.mp4"

    return {
        "title": title or "解说剧作品",
        "segments": results,
        "video_url": video_url,
        "total_credits": total_cost,
        "segment_count": len(results),
        "message": f"解说剧一键成片完成, 共{len(results)}段(骨架, 视频合成为占位)",
    }


# ==================== 工作台: 一键转绘 ====================

async def video_to_style_transfer(
    db: AsyncSession, org_id: UUID, user_id: UUID,
    video_url: str, style: str = "anime", frame_count: int = 4,
) -> Dict[str, Any]:
    """一键转绘(骨架): 视频 -> 风格化图像.

    M6 骨架: 用 image_edit 适配器生成多张风格化图(占位).
    """
    if not video_url:
        raise BadRequestException("视频地址不能为空")

    style_prompts = {
        "anime": "动漫风格, 赛璐璐上色",
        "comic": "美漫风格, 强烈阴影",
        "realistic": "写实风格, 电影质感",
        "oil": "油画风格",
    }
    prompt_base = style_prompts.get(style, style_prompts["anime"])

    results = []
    total_cost = 0
    for i in range(min(frame_count, 6)):
        res = await submit_creation(
            db, org_id, user_id, "image_edit",
            {"prompt": f"{prompt_base} 第{i+1}帧", "count": 1, "image_url": video_url},
            model="image_edit",
        )
        total_cost += res["credits_consumed"]
        results.append({"frame": i + 1, "image_url": res["urls"][0] if res["urls"] else None})

    return {
        "style": style,
        "frames": results,
        "total_credits": total_cost,
        "message": f"一键转绘完成({style}), 共{len(results)}帧(骨架)",
    }


# ==================== 内部工具 ====================

def _to_dict(w: Work) -> Dict[str, Any]:
    return {
        "id": str(w.id),
        "title": w.title,
        "description": w.description,
        "cover_url": w.cover_url,
        "video_url": w.video_url,
        "duration": w.duration,
        "source_type": w.source_type,
        "is_public": w.is_public,
        "view_count": w.view_count or 0,
        "like_count": w.like_count or 0,
        "tags": w.tags or [],
        "user_id": str(w.user_id),
        "published_at": w.published_at.isoformat() if w.published_at else None,
        "created_at": w.created_at.isoformat() if w.created_at else None,
    }
