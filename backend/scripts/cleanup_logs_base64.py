"""一次性数据清理脚本：就地脱敏 generation_tasks.meta.logs 里的历史超长字符串。

背景：
    早期 minimax_adapter 把含 base64 data URI 的整个 payload 写进了日志 data.request，
    持久化到 generation_tasks.meta（JSONB）。这些巨型字符串导致 /admin/tasks 等接口
    响应高达数 MB、加载 10 秒以上。本次脚本扫描所有历史任务，把 logs 里超过阈值的
    字符串就地替换成截断占位，保留日志结构和其他字段。

用法：
    cd backend
    # 1) 先 dry-run（默认）：只扫描报告，不写库
    python -m scripts.cleanup_logs_base64
    # 2) 确认无误后真正执行
    python -m scripts.cleanup_logs_base64 --apply

注意：
    - 只改写「确实含超长字符串」的任务行，其他任务不动。
    - 用 SQLAlchemy flag_modified 确保 JSONB 变更被持久化（JSONB 字段值变更 ORM 默认不感知）。
    - 幂等：已脱敏的数据再跑一次也不会出错（脱敏后的占位串长度 < 阈值，不会被二次处理）。
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# 让脚本在 `python -m scripts.xxx` 或直接 `python scripts/xxx.py` 下都能找到 backend 包
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from app.adapters.base import redact_large_strings, _REDACT_THRESHOLD
from app.core.database import AsyncSessionLocal
from app.models import GenerationTask


async def _meta_size(meta) -> int:
    """粗略估算 meta 序列化后字节数，用于报告。"""
    if not meta:
        return 0
    import json
    try:
        return len(json.dumps(meta, ensure_ascii=False).encode("utf-8"))
    except Exception:
        return 0


def _needs_redact(meta) -> bool:
    """meta.logs 里是否存在超长字符串（需脱敏）。"""
    if not isinstance(meta, dict):
        return False
    logs = meta.get("logs")
    if not logs:
        return False
    # 对 logs 跑一次脱敏，对比是否变化来判断是否需要写库
    redacted = redact_large_strings(logs)
    return redacted != logs


async def run(apply: bool = False) -> None:
    print(f"模式: {'应用（写库）' if apply else 'DRY-RUN（只扫描，不写库）'}")
    print(f"脱敏阈值: 字符串长度 > {_REDACT_THRESHOLD} 字符")
    print("-" * 60)

    total_scanned = 0
    total_need_fix = 0
    total_fixed = 0
    total_size_before = 0
    total_size_after = 0

    async with AsyncSessionLocal() as db:
        # 只扫有 meta.logs 的任务，避免全表遍历无意义行
        # （JSONB 字段内容过滤用 Python 判断更稳，避免 PG 版本/操作符差异）
        result = await db.execute(
            select(GenerationTask).order_by(GenerationTask.created_at.desc())
        )
        tasks = result.scalars().all()
        total_scanned = len(tasks)

        for task in tasks:
            meta = task.meta
            if not _needs_redact(meta):
                continue
            total_need_fix += 1
            size_before = await _meta_size(meta)
            total_size_before += size_before

            # 就地脱敏：只改 logs，保留 meta 其他字段
            new_meta = dict(meta)
            new_meta["logs"] = redact_large_strings(meta["logs"])
            size_after = await _meta_size(new_meta)
            total_size_after += size_after

            print(
                f"  [{'写' if apply else '跳过'}] task {task.id} "
                f"type={task.type} status={task.status} "
                f"size: {size_before} -> {size_after} bytes"
            )

            if apply:
                task.meta = new_meta
                flag_modified(task, "meta")  # JSONB 变更必须显式标记
                total_fixed += 1

        if apply and total_need_fix > 0:
            await db.commit()

    print("-" * 60)
    print(f"扫描任务总数:     {total_scanned}")
    print(f"含超长日志任务:   {total_need_fix}")
    print(f"本次写库任务数:   {total_fixed if apply else 0}")
    if total_need_fix > 0:
        saved = total_size_before - total_size_after
        pct = (saved / total_size_before * 100) if total_size_before else 0
        print(
            f"日志体积变化:     {_fmt(total_size_before)} -> {_fmt(total_size_after)} "
            f"(节省 {_fmt(saved)}, -{pct:.1f}%)"
        )
    if not apply and total_need_fix > 0:
        print()
        print("以上为 DRY-RUN 预览。确认无误后执行：")
        print("  python -m scripts.cleanup_logs_base64 --apply")
    elif total_need_fix == 0:
        print("没有需要清理的历史日志，DB 已是干净状态。")


def _fmt(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.2f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="清理 generation_tasks.meta.logs 里的历史 base64")
    parser.add_argument("--apply", action="store_true", help="真正写库（默认只 dry-run 扫描）")
    args = parser.parse_args()
    asyncio.run(run(apply=args.apply))
