"""
Redis Async Client - 惰性初始化的异步 Redis 连接池

用途: 短信验证码存取等轻量缓存场景。Celery 有自己独立的连接配置，互不影响。
"""
import logging
from typing import Optional

import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

_pool: Optional[aioredis.Redis] = None


def get_redis() -> aioredis.Redis:
    """获取全局异步 Redis 客户端（连接池，decode_responses=True 直接返回 str）"""
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(
            settings.REDIS_URL,
            max_connections=settings.REDIS_MAX_CONNECTIONS,
            decode_responses=True,
        )
    return _pool


async def close_redis() -> None:
    """应用关闭时释放连接池"""
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None
        logger.info("Redis 连接池已关闭")
