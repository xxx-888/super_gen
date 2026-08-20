"""禁用媒体的静态访问拦截

后台「媒体资源」禁用某个文件后，其本地 /uploads/... 路径返回 403。
禁用状态存在 media_states 表（按 URL，覆盖生成任务输出/素材库/项目资产
所有来源），这里做 30s 缓存；后台每次禁用/启用/删除后调用
invalidate_disabled_cache() 立即生效。

云端（文件服务器）直链的禁用只记录状态、不拦截访问——文件服务器是独立
部署的哑存储，拦截需要在其侧实现；后台列表中依然会标注「已禁用」。
"""
import logging
import time
from typing import Optional, Set, Tuple

logger = logging.getLogger(__name__)

_cache: Tuple[Optional[Set[str]], float] = (None, 0.0)
_TTL_SECONDS = 30.0


async def get_disabled_upload_paths() -> Set[str]:
    """返回被禁用的本地 /uploads/... URL 集合（带 TTL 缓存）。"""
    global _cache
    paths, cached_at = _cache
    now = time.time()
    if paths is not None and now - cached_at < _TTL_SECONDS:
        return paths

    paths = set()
    try:
        from sqlalchemy import select
        from app.core.database import AsyncSessionLocal
        from app.models import MediaState
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(MediaState.url).where(MediaState.disabled == True)  # noqa: E712
            )
            for url in result.scalars():
                if isinstance(url, str) and url.startswith("/uploads/"):
                    paths.add(url)
    except Exception as e:
        logger.warning(f"load disabled media paths failed: {e}")
        # 失败时保留旧缓存内容（若有），避免误放行/误拦截扩大化
        if _cache[0] is not None:
            return _cache[0]

    _cache = (paths, now)
    return paths


def invalidate_disabled_cache() -> None:
    """后台禁用/启用/删除媒体后调用，让拦截立即生效。"""
    global _cache
    _cache = (None, 0.0)
