"""
Asset Downloader - 远端图片/视频下载到本地存储

AI 生成的图片/视频 URL 是智谱的远端 URL (如 maas-watermark-prod-new.ufileos.com),
这些 URL 会过期 (通常 24 小时). 本模块把生成的产物下载到本地 /uploads 持久保存,
并用本地 URL 替换远端 URL, 保证前端长期可访问.

设计要点:
- download_to_local: 用 httpx 流式下载, 通过 LocalStorage.save 落盘, 返回本地 URL.
  失败时降级返回原始 URL, 不阻断生成流程 (生成本身已成功, 不应因下载失败而丢弃).
- get_local_storage_stats: 用 os.scandir 遍历 uploads 顶层 category 目录 (image/video/audio),
  对每个 category 下的子树累加文件数与大小. 只扫描已知 category 目录, 避免递归过深.
- category 由远端响应的 content-type 推断 (image/* / video/* / audio/*).
"""
import logging
import os
from typing import Dict
from urllib.parse import urlparse

import httpx

from app.core.config import settings
from app.services.storage import get_storage_singleton

logger = logging.getLogger(__name__)

# 远端下载超时: 连接 10s, 读取 120s (视频可能较大)
_DOWNLOAD_TIMEOUT = httpx.Timeout(10.0, read=120.0, write=10.0, pool=10.0)
# 单文件下载上限: 200MB (与 MAX_UPLOAD_SIZE 同量级, 防止异常大文件打爆内存)
_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

# 已知存储类别 (与 LocalStorage 的 category 目录一一对应)
_CATEGORIES = ("image", "video", "audio")


def _infer_category(content_type: str, fallback: str = "image") -> str:
    """根据 content-type 推断存储类别 (image/video/audio)."""
    ct = (content_type or "").lower().split(";")[0].strip()
    if ct.startswith("image/"):
        return "image"
    if ct.startswith("video/"):
        return "video"
    if ct.startswith("audio/"):
        return "audio"
    return fallback


def _ext_from_content_type(content_type: str, url: str) -> str:
    """从 content-type 推断扩展名, 回退到 URL 路径后缀."""
    ct = (content_type or "").lower().split(";")[0].strip()
    mapping = {
        "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
        "image/webp": ".webp", "image/gif": ".gif",
        "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
        "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg",
    }
    if ct in mapping:
        return mapping[ct]
    # 回退: 从 URL 路径取后缀
    path = urlparse(url).path
    _, ext = os.path.splitext(path)
    return ext if ext else ""


async def download_to_local(url: str, category: str = "image") -> str:
    """下载远端资源到本地存储, 返回本地 URL.

    Args:
        url: 远端资源 URL
        category: 期望的存储类别 (image/video/audio). 若远端 content-type
                  能明确推断出类别, 则以 content-type 为准.

    Returns:
        本地 URL (如 /uploads/image/2026/08/xxx.png); 下载失败时降级返回原始 url.
    """
    if not url or not isinstance(url, str):
        return url
    # 只下载 http/https 远端 URL; 本地 /uploads 路径直接返回
    if url.startswith("/uploads/") or not url.startswith(("http://", "https://")):
        return url

    try:
        storage = get_storage_singleton()
        # 先 HEAD 不一定被远端支持, 直接 GET 流式读取, 边读边判断大小
        async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                content_type = resp.headers.get("content-type", "")
                cat = _infer_category(content_type, fallback=category)
                # 收集 bytes, 限制最大体积
                chunks = []
                total = 0
                async for chunk in resp.aiter_bytes():
                    total += len(chunk)
                    if total > _MAX_DOWNLOAD_BYTES:
                        raise ValueError(
                            f"download too large (> {_MAX_DOWNLOAD_BYTES // (1024*1024)}MB): {url}"
                        )
                    chunks.append(chunk)
                data = b"".join(chunks)

        ext = _ext_from_content_type(content_type, url)
        # save 内部会按 category/年/月 分目录并生成 uuid 文件名
        filename = f"downloaded{ext}"
        stored = await storage.save(
            data=data, filename=filename, mime_type=content_type or cat, category=cat
        )
        logger.info(f"downloaded asset to local: {url} -> {stored.url} ({total} bytes)")
        return stored.url
    except Exception as e:
        # 降级: 不阻断生成流程, 返回原始远端 URL (虽然会过期, 但比丢弃结果好)
        logger.warning(f"download_to_local failed, fallback to remote url: {url} ({e})")
        return url


def get_local_storage_stats() -> Dict:
    """统计本地 uploads 目录各类别 (image/video/audio) 的文件数与总大小.

    用 os.scandir 遍历, 只进入已知 category 目录, 对其子树累加. 返回:

        {
            "image": {"count": N, "size_mb": X},
            "video": {"count": N, "size_mb": X},
            "audio": {"count": N, "size_mb": X},
            "total_size_mb": X,
        }
    """
    base_path = settings.STORAGE_LOCAL_PATH
    stats: Dict[str, Dict[str, float]] = {
        cat: {"count": 0, "size_mb": 0.0} for cat in _CATEGORIES
    }
    total_bytes = 0

    if not os.path.isdir(base_path):
        return {**stats, "total_size_mb": 0.0}

    total_bytes = 0
    for cat in _CATEGORIES:
        cat_dir = os.path.join(base_path, cat)
        if not os.path.isdir(cat_dir):
            stats[cat]["size_mb"] = 0.0
            continue
        count = 0
        size_bytes = 0
        # 只进入已知 category 目录, 用栈做受控深度遍历 (category/年/月 = 3 层)
        stack = [(cat_dir, 0)]
        while stack:
            current, depth = stack.pop()
            if depth > 4:
                continue
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                stack.append((entry.path, depth + 1))
                            elif entry.is_file(follow_symlinks=False):
                                st = entry.stat(follow_symlinks=False)
                                count += 1
                                size_bytes += st.st_size
                        except OSError:
                            continue
            except OSError:
                continue
        stats[cat]["count"] = count
        # 字节 -> MB (保留 2 位)
        stats[cat]["size_mb"] = round(size_bytes / (1024 * 1024), 2)
        total_bytes += size_bytes

    total_mb = round(total_bytes / (1024 * 1024), 2)
    return {**stats, "total_size_mb": total_mb}
