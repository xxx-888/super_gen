"""
Gen Task Tracker - 资源生图异步任务跟踪器

简单的内存任务跟踪（不持久化，重启丢失）。
用于资源管理的 AI 生图：提交后立即返回 task_id，
后台异步执行，前端轮询 GET /generate-status/{task_id} 查结果。
"""
import asyncio
from typing import Any, Dict, Optional
from uuid import uuid4

# task_id → {status, result, error, resource_type, resource_id}
_tasks: Dict[str, Dict[str, Any]] = {}


def create_task(resource_type: str, resource_id: str) -> str:
    """创建一个生图任务，返回 task_id。"""
    task_id = str(uuid4())
    _tasks[task_id] = {
        "status": "processing",
        "result": None,
        "error": None,
        "resource_type": resource_type,
        "resource_id": resource_id,
    }
    return task_id


def get_task(task_id: str) -> Optional[Dict[str, Any]]:
    """查询任务状态。"""
    return _tasks.get(task_id)


def complete_task(task_id: str, result: Any = None) -> None:
    """标记任务完成。"""
    if task_id in _tasks:
        _tasks[task_id]["status"] = "completed"
        _tasks[task_id]["result"] = result


def fail_task(task_id: str, error: str) -> None:
    """标记任务失败。"""
    if task_id in _tasks:
        _tasks[task_id]["status"] = "failed"
        _tasks[task_id]["error"] = error


def cleanup_old_tasks(max_keep: int = 200) -> None:
    """清理过多的已完成任务（防止内存泄漏）。"""
    if len(_tasks) <= max_keep:
        return
    # 按完成状态清理最早的
    done = [(tid, t) for tid, t in _tasks.items() if t["status"] in ("completed", "failed")]
    for tid, _ in done[:len(done) - max_keep // 2]:
        _tasks.pop(tid, None)
