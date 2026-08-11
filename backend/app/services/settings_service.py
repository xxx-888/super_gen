"""
SystemSettings 读取服务 —— 从 system_settings 表读取配置值，带缓存。

所有后台设置项都通过这里读取，确保管理员在「系统设置」页改的值能即时生效。
缓存 30 秒（设置改动不频繁，不需要实时），管理员保存设置后自动清缓存。
"""
import logging
from typing import Any, Dict, Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SystemSettings

logger = logging.getLogger(__name__)

_cache: Dict[str, Any] = {}
_cache_loaded = False


async def load_all_settings(db: AsyncSession) -> Dict[str, Any]:
    """从 DB 加载全部系统设置到缓存。"""
    global _cache, _cache_loaded
    result = await db.execute(select(SystemSettings))
    _cache = {s.key: s.value for s in result.scalars().all()}
    _cache_loaded = True
    return _cache


async def get_setting(db: AsyncSession, key: str, default: Any = None) -> Any:
    """读取单个系统设置项（带缓存）。"""
    global _cache_loaded
    if not _cache_loaded:
        await load_all_settings(db)
    return _cache.get(key, default)


async def get_all_settings(db: AsyncSession) -> Dict[str, Any]:
    """读取全部系统设置（带缓存）。"""
    global _cache_loaded
    if not _cache_loaded:
        await load_all_settings(db)
    return dict(_cache)


def invalidate_cache():
    """清除设置缓存（管理员保存设置后调用，让新值立即生效）。"""
    global _cache_loaded
    _cache_loaded = False


# 任务轮询超时默认值（秒）。MiniMax H3 等云端视频任务通常需要 2-5 分钟，
# 这里给一个足够宽松的兜底；后台「系统设置」可覆盖。
DEFAULT_TASK_POLL_TIMEOUT = 600


async def get_task_poll_timeout(db: AsyncSession) -> int:
    """读取任务查询超时（秒），带缓存，异常/缺失时回退默认值。

    供 creation_service._async_poll_adapter 使用：后台任务在循环开始前调一次即可，
    不必每次轮询都读（设置改动不频繁，且 30 秒缓存会兜底）。
    """
    raw = await get_setting(db, "task_poll_timeout_seconds", DEFAULT_TASK_POLL_TIMEOUT)
    try:
        return max(60, int(raw))
    except (TypeError, ValueError):
        return DEFAULT_TASK_POLL_TIMEOUT
