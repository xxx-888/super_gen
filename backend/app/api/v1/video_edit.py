"""Video Edit API - 视频在线剪辑（M7）

每集一条剪辑配置（JSON 草稿），进项目自动加载；导出为后台 ffmpeg 合成任务
（GenerationTask type=video_edit，前端轮询 GET /tasks/{id} 看进度）。
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import verify_project_ownership
from app.core.background import spawn_background
from app.core.database import get_db, AsyncSessionLocal
from app.core.exceptions import NotFoundException, BadRequestException
from app.core.security import get_current_user
from app.models import (
    AudioAsset, Episode, GenerationTask, Project, Scene, User, VideoEditConfig,
)

logger = logging.getLogger(__name__)
router = APIRouter()


async def _allowed_media_hosts(db: AsyncSession, request: Request) -> set:
    """媒体 URL 主机白名单：本站 Host + 文件服务器 Host（env + 后台系统设置）"""
    from urllib.parse import urlparse
    from app.core.config import settings as _settings
    from app.services.settings_service import get_setting

    hosts = set()
    try:
        h = (request.headers.get("host") or "").split(":")[0]
        if h:
            hosts.add(h.lower())
    except Exception:
        pass
    try:
        h = urlparse(_settings.FILE_SERVER_URL or "").hostname
        if h:
            hosts.add(h.lower())
    except Exception:
        pass
    try:
        fs_url = await get_setting(db, "file_server_url", "")
        h = urlparse(fs_url or "").hostname
        if h:
            hosts.add(h.lower())
    except Exception:
        pass
    return hosts


def _media_url_allowed(url: str, allowed_hosts: set) -> bool:
    """/uploads 本地路径放行；http(s) 仅允许白名单主机（防 SSRF 探测内网）"""
    from urllib.parse import urlparse
    u = (url or "").strip()
    if u.startswith(("/uploads/", "uploads/")):
        return True
    if u.startswith(("http://", "https://")):
        host = (urlparse(u).hostname or "").lower()
        return host in allowed_hosts
    return False


class SaveEditRequest(BaseModel):
    config: Dict[str, Any]


class RenderEditRequest(BaseModel):
    config: Dict[str, Any]


async def _get_or_create_edit_row(db: AsyncSession, episode_id: UUID, project_id: UUID) -> VideoEditConfig:
    row = (await db.execute(
        select(VideoEditConfig).where(VideoEditConfig.episode_id == episode_id)
    )).scalar_one_or_none()
    if row is None:
        row = VideoEditConfig(episode_id=episode_id, project_id=project_id, config={})
        db.add(row)
        await db.flush()
    return row


def _default_config_from_episode(episode: Episode, scenes: list) -> Dict[str, Any]:
    """首次进入：用集内已生成分镜视频 + 分镜台词预填一份初始配置。"""
    clips, subtitles = [], []
    cursor = 0.0
    for s in scenes:
        if not s.generated_video_url:
            continue
        dur = float(s.duration or 5.0)
        clips.append({
            "id": f"scene-{s.id}",
            "url": s.generated_video_url,
            "name": f"分镜#{s.sequence}",
            "in": 0.0, "out": None, "volume": 1.0,
        })
        text = (s.prompt or "").strip()
        if text:
            subtitles.append({
                "id": f"sub-{s.id}",
                "start": round(cursor, 2),
                "end": round(cursor + min(dur, 4.0), 2),
                "text": text[:40],
            })
        cursor += dur
    return {
        "version": 1,
        "resolution": "720p",
        "clips": clips,
        "audio": {"volume": 1.0, "bgm": None},
        "subtitles": subtitles,
        "subtitle_style": {"font_size": 28, "color": "#FFFFFF", "position": "bottom"},
    }


@router.get("")
async def get_edit_config(
    episode_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """加载剪辑配置（无草稿时按分镜自动生成初始配置）。附可用素材清单。"""
    episode = (await db.execute(
        select(Episode).where(Episode.id == episode_id, Episode.project_id == project.id)
    )).scalar_one_or_none()
    if not episode:
        raise NotFoundException("集不存在")

    scenes = (await db.execute(
        select(Scene).where(Scene.episode_id == episode_id)
        .order_by(Scene.sequence.asc())
    )).scalars().all()

    row = (await db.execute(
        select(VideoEditConfig).where(VideoEditConfig.episode_id == episode_id)
    )).scalar_one_or_none()

    if row and (row.config or {}).get("clips"):
        config = row.config
    else:
        # 首次进入：预填（不落库，用户首次保存时才建记录）
        config = _default_config_from_episode(episode, scenes)

    # BGM 候选：项目音频资产
    audio_assets = (await db.execute(
        select(AudioAsset).where(AudioAsset.project_id == project.id)
        .order_by(AudioAsset.created_at.desc()).limit(50)
    )).scalars().all()

    return {
        "episode": {"id": str(episode.id), "title": episode.title, "number": episode.number},
        "config": config,
        "saved": bool(row),
        "last_output_url": row.last_output_url if row else None,
        "rendering": bool(row.rendering) if row else False,
        "scene_videos": [
            {"id": str(s.id), "sequence": s.sequence, "url": s.generated_video_url,
             "name": f"分镜#{s.sequence}", "duration": s.duration}
            for s in scenes if s.generated_video_url
        ],
        "audio_assets": [
            {"id": str(a.id), "url": a.url, "name": a.name}
            for a in audio_assets
        ],
    }


@router.put("")
async def save_edit_config(
    episode_id: UUID,
    body: SaveEditRequest,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """保存剪辑配置草稿（进项目自动加载的就是这份）。"""
    from app.services.video_editor import normalize_config
    try:
        cfg = normalize_config(body.config)
    except ValueError as e:
        raise BadRequestException(str(e))

    row = await _get_or_create_edit_row(db, episode_id, project.id)
    row.config = cfg
    await db.commit()
    # commit 后属性过期，异步下直接访问会触发懒加载异常 → 显式 refresh
    await db.refresh(row)
    return {"saved": True, "config": cfg, "updated_at": row.updated_at.isoformat() if row.updated_at else None}


@router.get("/probe")
async def probe_media_duration(
    episode_id: UUID,
    url: str,
    request: Request,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """探测素材时长（秒）。仅允许本站素材与文件服务器直链（防 SSRF 探测内网）。"""
    import asyncio as _asyncio
    from app.services.video_editor import _probe_duration, _resolve_local_path

    if not url or not url.startswith(("/uploads/", "uploads/", "http://", "https://")):
        raise BadRequestException("仅支持本站素材或 http(s) 地址")
    allowed_hosts = await _allowed_media_hosts(db, request)
    if not _media_url_allowed(url, allowed_hosts):
        raise BadRequestException("仅支持本站素材或平台文件服务器的地址")
    src = _resolve_local_path(url) or url
    dur = await _asyncio.to_thread(_probe_duration, src)
    # 解析失败优雅返回 null（前端用占位时长），不再 400 弹错——
    # 图片/损坏素材/不可达 URL 都会走到这里，属可容忍场景
    return {"duration": round(dur, 2) if dur is not None else None}


@router.post("/render")
async def render_edit_video(
    episode_id: UUID,
    body: RenderEditRequest,
    request: Request,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """导出成片：保存配置 + 提交后台 ffmpeg 合成任务（返回 task_id 供轮询）。"""
    from app.services.video_editor import normalize_config
    try:
        cfg = normalize_config(body.config)
    except ValueError as e:
        raise BadRequestException(str(e))

    # SSRF 防护：所有片段/音频 URL 仅允许本站与文件服务器
    allowed_hosts = await _allowed_media_hosts(db, request)
    for c in (cfg.get("clips") or []):
        if not _media_url_allowed(c.get("url", ""), allowed_hosts):
            raise BadRequestException(f"片段地址不被允许：{c.get('name', '')}")
    for a in (cfg.get("audio_clips") or []):
        if not _media_url_allowed(a.get("url", ""), allowed_hosts):
            raise BadRequestException("音频地址不被允许")

    # 同集防并发渲染
    row = await _get_or_create_edit_row(db, episode_id, project.id)
    if row.rendering:
        raise BadRequestException("该集正在导出中，请稍候")
    row.config = cfg
    row.rendering = True

    task = GenerationTask(
        project_id=project.id,
        user_id=current_user.id,
        type="video_edit",
        model="ffmpeg-editor",
        input_data={"episode_id": str(episode_id), "clip_count": len(cfg["clips"]),
                    "subtitle_count": len(cfg["subtitles"]),
                    "resolution": cfg["resolution"], "content_preview": f"{len(cfg['clips'])} 个片段剪辑导出"},
        status="processing", progress=5,
        credits_consumed=0,
        started_at=datetime.now(timezone.utc),
        meta={},
    )
    db.add(task)
    await db.flush()
    row.last_render_task_id = task.id

    # 计价规则（credit_pricing 配了 video_edit 规则才扣费，无规则=免费）
    from app.services import pricing_service
    charge_info = None
    try:
        charge_info = await pricing_service.charge_for_task(
            db, "video_edit", None, None,
            org_id=project.org_id,
            user_id=current_user.id, project_id=project.id, task=task,
            model="ffmpeg-editor", remark="视频剪辑导出",
        )
    except Exception as ce:
        task.status = "failed"
        task.error_message = f"积分扣费失败: {str(ce)[:200]}"
        task.completed_at = datetime.now(timezone.utc)
        row.rendering = False
        await db.commit()
        raise BadRequestException(f"积分不足或扣费失败: {str(ce)[:150]}")

    await db.commit()
    spawn_background(_render_task(str(task.id), str(episode_id), cfg,
                                  charge_info, str(current_user.id)))
    return {"task_id": str(task.id), "status": "processing",
            "message": "导出任务已提交，可在任务列表查看进度"}


async def _render_task(task_id: str, episode_id: str, cfg: Dict[str, Any],
                       charge_info, user_id: str):
    """后台执行合成；成功更新配置/集，失败退款。"""
    from app.services.video_editor import render_edit
    from app.services import pricing_service
    try:
        async def _update(pct: int, msg: str):
            async with AsyncSessionLocal() as db:
                t = await db.get(GenerationTask, UUID(task_id))
                if t and t.status == "processing":
                    t.progress = max(t.progress or 0, pct)
                    t.meta = {**(t.meta or {}), "stage": msg}
                    await db.commit()

        # render_edit 的 progress_cb 是同步函数 → 桥接为后台协程写进度
        def cb(pct, msg):
            import asyncio as _a
            try:
                _a.get_running_loop().create_task(_update(pct, msg))
            except RuntimeError:
                pass

        url, dur = await render_edit(cfg, progress_cb=cb)

        async with AsyncSessionLocal() as db:
            t = await db.get(GenerationTask, UUID(task_id))
            if t:
                t.status = "completed"
                t.progress = 100
                t.output_urls = [url]
                t.completed_at = datetime.now(timezone.utc)
                t.meta = {**(t.meta or {}), "duration": dur, "stage": "完成"}
                await db.commit()
            row = (await db.execute(
                select(VideoEditConfig).where(VideoEditConfig.episode_id == UUID(episode_id))
            )).scalar_one_or_none()
            if row:
                row.last_output_url = url
                row.rendering = False
                await db.commit()
            ep = await db.get(Episode, UUID(episode_id))
            if ep:
                ep.meta = {**(ep.meta or {}), "edited_video_url": url}
                await db.commit()
        logger.info(f"[VideoEdit] render ok: {url} ({dur:.1f}s)")
    except Exception as e:
        logger.error(f"[VideoEdit] render failed: {e}", exc_info=True)
        async with AsyncSessionLocal() as db:
            t = await db.get(GenerationTask, UUID(task_id))
            if t:
                t.status = "failed"
                t.error_message = str(e)[:500]
                t.completed_at = datetime.now(timezone.utc)
                await db.commit()
            row = (await db.execute(
                select(VideoEditConfig).where(VideoEditConfig.episode_id == UUID(episode_id))
            )).scalar_one_or_none()
            if row:
                row.rendering = False
                await db.commit()
            # 失败退款
            if charge_info:
                try:
                    await pricing_service.refund_charge(
                        charge_info, user_id=UUID(user_id), task_id=UUID(task_id),
                        remark="剪辑导出失败退还",
                    )
                except Exception as re_err:
                    logger.warning(f"[VideoEdit] refund failed: {re_err}")
