"""
Celery App Configuration - Celery 应用实例

当 Redis 不可用时，任务会自动降级为同步执行，确保开发环境可用。
"""
import logging

logger = logging.getLogger(__name__)

try:
    from celery import Celery

    from app.core.config import settings

    celery_app = Celery(
        "scenegen",
        broker=settings.CELERY_BROKER_URL,
        backend=settings.CELERY_RESULT_BACKEND,
    )

    celery_app.conf.update(
        task_serializer=settings.CELERY_TASK_SERIALIZER,
        result_serializer=settings.CELERY_RESULT_SERIALIZER,
        accept_content=settings.CELERY_ACCEPT_CONTENT,
        timezone=settings.CELERY_TIMEZONE,
        enable_utc=settings.CELERY_ENABLE_UTC,
        task_track_started=True,
        task_acks_late=True,
        worker_prefetch_multiplier=1,
    )

    CELERY_AVAILABLE = True
    logger.info("Celery configured successfully")
except Exception as e:
    logger.warning(f"Celery not available (tasks will run synchronously): {e}")
    CELERY_AVAILABLE = False
    celery_app = None
