"""后台任务工具：fire-and-forget 协程必须保存强引用。

Python 事件循环对 task 只持弱引用——不保存 create_task 的返回值时，
长任务（如数分钟的 LLM 解析）可能被垃圾回收中途取消；取消抛的是
CancelledError（BaseException），协程里的 `except Exception` 接不住，
导致任务永远停在 processing、前端轮询永不结束、GenerationTask 不落终态。

用法：把 `asyncio.create_task(coro)` 换成 `spawn_background(coro)`。
"""
import asyncio
import logging

logger = logging.getLogger(__name__)

# 运行中后台任务的强引用集合（阻止被 GC），完成后自动移除
_running: set = set()


def spawn_background(coro, name: str = "") -> "asyncio.Task":
    """创建后台任务并持有强引用；异常/取消在 done 回调里记日志，不再静默死亡。"""
    task = asyncio.create_task(coro, name=name) if name else asyncio.create_task(coro)
    _running.add(task)

    def _on_done(t: "asyncio.Task") -> None:
        _running.discard(t)
        label = name or getattr(t, "get_name", lambda: "")() or ""
        if t.cancelled():
            logger.warning(f"[Background] 后台任务被取消: {label}")
            return
        exc = t.exception()
        if exc is not None:
            logger.error(f"[Background] 后台任务异常退出: {label}: {exc}", exc_info=exc)

    task.add_done_callback(_on_done)
    return task
