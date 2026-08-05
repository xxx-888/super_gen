"""
Video Generation Tasks - 视频生成任务存根

模拟图生视频/文生视频流程，直接标记任务为 completed。
"""
import logging
from datetime import datetime, timezone
from uuid import UUID

from app.tasks.celery_app import CELERY_AVAILABLE, celery_app

logger = logging.getLogger(__name__)


async def _execute_video_gen(task_id: str, params: dict):
    """同步执行的视频生成逻辑（存根）"""
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

            task.status = "processing"
            task.started_at = datetime.now(timezone.utc)
            await db.commit()

            logger.info(f"[Stub] Generating video for task {task_id} with params: {params.get('model', 'unknown')}")

            import time
            time.sleep(0.5)

            task.status = "completed"
            task.progress = 100
            task.completed_at = datetime.now(timezone.utc)
            task.output_urls = [
                f"https://placeholder.scenegen.com/generated/{task_id}.mp4"
            ]
            task.meta = {
                **(task.meta or {}),
                "logs": [
                    {"time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": "Video generation started (stub)"},
                    {"time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": f"Model: {params.get('model', 'stub')}"},
                    {"time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": "Video generation completed (stub)"},
                ],
            }
            await db.commit()
            logger.info(f"[Stub] Video generation completed for task {task_id}")

        except Exception as e:
            logger.error(f"Video generation failed for task {task_id}: {e}")
            try:
                result = await db.execute(
                    select(GenerationTask).where(GenerationTask.id == UUID(task_id))
                )
                task = result.scalar_one_or_none()
                if task:
                    task.status = "failed"
                    task.error_message = str(e)
                    task.meta = {
                        **(task.meta or {}),
                        "logs": [{"time": datetime.now(timezone.utc).isoformat(), "level": "error", "message": str(e)}],
                    }
                    await db.commit()
            except Exception:
                pass


async def _execute_batch_video_gen(task_ids: list, params: dict):
    """批量视频生成（存根）"""
    for tid in task_ids:
        await _execute_video_gen(tid, params)


if CELERY_AVAILABLE and celery_app is not None:
    @celery_app.task(name="tasks.generate_video")
    def generate_video_task(task_id: str, params: dict):
        """单个视频生成任务"""
        import asyncio
        asyncio.run(_execute_video_gen(task_id, params))
        return {"task_id": task_id, "status": "completed"}

    @celery_app.task(name="tasks.batch_generate_videos")
    def batch_generate_videos_task(task_ids: list, params: dict):
        """批量视频生成任务"""
        import asyncio
        asyncio.run(_execute_batch_video_gen(task_ids, params))
        return {"task_ids": task_ids, "status": "completed"}
else:
    class _StubTask:
        def delay(self, *args, **kwargs):
            import asyncio
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(self._run(*args, **kwargs))
            else:
                loop.run_until_complete(self._run(*args, **kwargs))
            return self

        def _run(self, *args, **kwargs):
            pass

        @property
        def id(self):
            return "stub-no-celery"

    generate_video_task = _StubTask()
    batch_generate_videos_task = _StubTask()
