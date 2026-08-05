"""
Subtitle Task - 字幕生成/去除任务存根

模拟 Whisper ASR 字幕生成和去字幕流程。
"""
import logging
from datetime import datetime, timezone
from uuid import UUID

from app.tasks.celery_app import CELERY_AVAILABLE, celery_app

logger = logging.getLogger(__name__)


async def _execute_subtitle(task_id: str, params: dict):
    """同步执行的字幕任务逻辑（存根）"""
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.models import GenerationTask

    async with AsyncSessionLocal() as db:
        try:
            result = await db.execute(
                select(GenerationTask).where(GenerationTask.id == UUID(task_id))
            )
            task = result.scalar_one_or_none()
            if not task:
                logger.error(f"Task {task_id} not found")
                return

            action = params.get("action", "generate")
            task.status = "processing"
            task.started_at = datetime.now(timezone.utc)
            await db.commit()

            logger.info(f"[Stub] Subtitle task {task_id}: action={action}")

            import time
            time.sleep(0.3)

            task.status = "completed"
            task.progress = 100
            task.completed_at = datetime.now(timezone.utc)
            task.output_urls = [
                f"https://placeholder.scenegen.com/subtitle/{task_id}.{'srt' if action == 'generate' else 'mp4'}"
            ]
            task.meta = {
                **(task.meta or {}),
                "logs": [
                    {"time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": f"Subtitle {action} started (stub)"},
                    {"time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": f"Subtitle {action} completed (stub)"},
                ],
            }
            await db.commit()
            logger.info(f"[Stub] Subtitle task completed for {task_id}")

        except Exception as e:
            logger.error(f"Subtitle task failed for {task_id}: {e}")
            try:
                result = await db.execute(
                    select(GenerationTask).where(GenerationTask.id == UUID(task_id))
                )
                task = result.scalar_one_or_none()
                if task:
                    task.status = "failed"
                    task.error_message = str(e)
                    await db.commit()
            except Exception:
                pass


if CELERY_AVAILABLE and celery_app is not None:
    @celery_app.task(name="tasks.generate_subtitle")
    def generate_subtitle_task(task_id: str, params: dict):
        """字幕生成/去除任务"""
        import asyncio
        asyncio.run(_execute_subtitle(task_id, params))
        return {"task_id": task_id, "status": "completed"}
else:
    class _StubTask:
        def delay(self, task_id: str, params: dict):
            import asyncio
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(_execute_subtitle(task_id, params))
            else:
                loop.run_until_complete(_execute_subtitle(task_id, params))
            return self

        @property
        def id(self):
            return "stub-no-celery"

    generate_subtitle_task = _StubTask()
