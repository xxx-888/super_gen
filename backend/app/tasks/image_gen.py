"""
Image Generation Task - 图片生成任务存根

模拟文生图/图生图流程，直接标记任务为 completed 并写入模拟输出。
"""
import logging
from datetime import datetime, timezone
from uuid import UUID

from app.tasks.celery_app import CELERY_AVAILABLE, celery_app

logger = logging.getLogger(__name__)


async def _execute_image_gen(task_id: str, params: dict):
    """同步执行的图片生成逻辑（存根）"""
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

            # 更新状态为处理中
            task.status = "processing"
            task.started_at = datetime.now(timezone.utc)
            await db.commit()

            # 模拟生成过程
            logger.info(f"[Stub] Generating image for task {task_id} with params: {params.get('model', 'unknown')}")

            # 模拟完成
            import time
            time.sleep(0.5)  # 模拟少量处理时间

            task.status = "completed"
            task.progress = 100
            task.completed_at = datetime.now(timezone.utc)
            task.output_urls = [
                f"https://placeholder.scenegen.com/generated/{task_id}.png"
            ]
            task.meta = {
                **(task.meta or {}),
                "logs": [
                    {"time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": "Image generation started (stub)"},
                    {"time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": "Model: stub-placeholder"},
                    {"time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": "Image generation completed (stub)"},
                ],
            }
            await db.commit()
            logger.info(f"[Stub] Image generation completed for task {task_id}")

        except Exception as e:
            logger.error(f"Image generation failed for task {task_id}: {e}")
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


# Celery 任务定义（当 Celery 可用时使用）
if CELERY_AVAILABLE and celery_app is not None:
    @celery_app.task(name="tasks.generate_image")
    def generate_image_task(task_id: str, params: dict):
        """Celery 图片生成任务"""
        import asyncio
        asyncio.run(_execute_image_gen(task_id, params))
        return {"task_id": task_id, "status": "completed"}
else:
    # 降级：直接执行
    class _StubTask:
        def delay(self, task_id: str, params: dict):
            import asyncio
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(_execute_image_gen(task_id, params))
            else:
                loop.run_until_complete(_execute_image_gen(task_id, params))
            return self

        @property
        def id(self):
            return "stub-no-celery"

    generate_image_task = _StubTask()
