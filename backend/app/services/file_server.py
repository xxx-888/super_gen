"""File Server Client - 独立文件服务（fileserver/）转发客户端

配置来源（优先级从高到低）：
1. 后台「系统设置」的 file_server_url / file_server_api_key（DB，管理员可随时改）
2. backend .env 的 FILE_SERVER_URL / FILE_SERVER_API_KEY

配置后视频/音频上传自动转传到云服务器文件服务，拿公网直链 —— 供 MiniMax H3
等渠道的 reference_video / reference_audio 直接下载（渠道不接受 data URI，
本地 /uploads 也访问不到）。未配置或转传失败时返回 None，调用方降级为本地存储。
"""
import logging
from typing import Optional, Tuple

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


async def get_file_server_config() -> Tuple[Optional[str], Optional[str]]:
    """读取文件服务器配置：后台系统设置（DB，带 30s 缓存）优先，回退 .env。

    语义约定：
    - DB 从未设置过（None）→ 用 .env / 环境变量兜底
    - DB 显式保存过但地址为空（管理员在后台清空并保存）→ 停用云端，全部本地存储
    """
    url = key = None
    try:
        from app.core.database import AsyncSessionLocal
        from app.services.settings_service import get_setting
        async with AsyncSessionLocal() as db:
            url = await get_setting(db, "file_server_url", None)
            key = await get_setting(db, "file_server_api_key", None)
    except Exception as e:
        logger.debug(f"read file_server settings from DB failed: {e}")
    if url is None:
        # 从未在后台设置 → .env 兜底
        url = (getattr(settings, "FILE_SERVER_URL", None) or "").strip() or None
    else:
        # 后台显式设置过：空地址 = 停用云端
        url = (str(url)).strip() or None
    if key is None:
        key = (getattr(settings, "FILE_SERVER_API_KEY", None) or "").strip() or None
    else:
        key = (str(key)).strip() or None
    return url, key


async def get_dual_write() -> bool:
    """读取双写开关（后台设置 file_server_dual_write，默认开启）。

    开启时：上传文件本地 + 云端各存一份（云端为主、本地为备份/加速）。
    兼容历史/手工写入的字符串值（"false"/"0" 等）。
    """
    try:
        from app.core.database import AsyncSessionLocal
        from app.services.settings_service import get_setting
        async with AsyncSessionLocal() as db:
            v = await get_setting(db, "file_server_dual_write", True)
        if v is None:
            return True
        if isinstance(v, str):
            return v.strip().lower() not in ("false", "0", "off", "no", "")
        return bool(v)
    except Exception:
        return True


async def store_media(data: bytes, filename: str, mime_type: str, category: str,
                      normalize: bool = True) -> tuple:
    """媒体上传的统一存储入口（upload.py / materials.py 共用）。

    策略（配置了文件服务器时）：
    - 视频/音频：转传云端，最终 URL 用云端直链（生成渠道需要公网可下载）；
      双写开启时本地另存一份
    - 图片：双写开启时本地为主（最终 URL=本地路径，模型链路读本地更快）、
      云端留备份副本；双写关闭时只存云端，最终 URL=云端直链
    - 未配置文件服务器 / 转传失败：降级本地存储

    返回 (最终URL, 本地StoredFile或None)。
    """
    from app.services.storage import get_storage_singleton

    # 音视频上传自动规范化：超 15s 截取前 15s、格式不符转码为 MP3/MP4
    # （生成渠道参考素材的通用合规要求）。已合规/处理失败时原样保留，
    # 生成链路（minimax_adapter）仍有探测+截取兜底。
    # normalize=False 供剪辑器导入等场景旁路（要完整素材，不截短）
    if normalize and category in ("video", "audio"):
        try:
            from app.services.media_prep import normalize_reference_media
            data, filename, mime_type, prep_meta = await normalize_reference_media(
                data, filename, mime_type, category)
            if prep_meta.get("processed"):
                logger.info(f"reference media normalized: {filename} ({prep_meta.get('reason')})")
        except Exception as e:
            logger.warning(f"normalize reference media failed (use original): {e}")

    async def _save_local():
        return await get_storage_singleton().save(
            data=data, filename=filename, mime_type=mime_type, category=category)

    remote_url = None
    if category in ("image", "video", "audio"):
        remote_url = await upload_to_file_server(data, filename, mime_type)

    if remote_url is None:
        # 未配置/失败：只存本地
        local = await _save_local()
        return local.url, local

    dual_write = await get_dual_write()
    if category == "image":
        # 图片：双写时本地为主（URL=本地），云端备份；双关时只云端
        if dual_write:
            local = await _save_local()
            return local.url, local
        return remote_url, None
    # 视频/音频：URL=云端直链（渠道要拉取），双写时本地备份一份
    local = await _save_local() if dual_write else None
    return remote_url, local


async def upload_to_file_server(data: bytes, filename: str, mime_type: str) -> Optional[str]:
    """把文件转传到独立文件服务器，返回公网 URL；未配置/失败返回 None。"""
    base, api_key = await get_file_server_config()
    if not base:
        return None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=300.0)) as client:
            resp = await client.post(
                f"{base.rstrip('/')}/upload",
                files={"file": (filename, data, mime_type or "application/octet-stream")},
                headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            )
        if resp.status_code != 200:
            logger.warning(f"file server upload HTTP {resp.status_code}: {resp.text[:200]}")
            return None
        url = (resp.json() or {}).get("url")
        if not url:
            logger.warning(f"file server upload no url in response: {resp.text[:200]}")
            return None
        # 兼容：文件服务未配置 FILE_SERVER_PUBLIC_URL 时返回相对路径（/files/...），
        # 用 backend 侧配置的 FILE_SERVER_URL 拼成完整公网直链
        if not url.startswith(("http://", "https://")):
            url = base.rstrip("/") + "/" + url.lstrip("/")
        logger.info(f"file server upload ok: {filename} -> {url}")
        return url
    except Exception as e:
        logger.warning(f"file server upload failed (fallback to local): {e}")
        return None
