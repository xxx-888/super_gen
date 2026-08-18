"""恢复被误删的本地视频文件（一次性的数据修复脚本）

背景：2026-08-18 离线验证时误删了 uploads/video/2026/08 与 uploads/audio/2026/08
目录，导致已生成分镜视频 404。数据库里的任务记录保存了来源信息：
- adapter=minimax（CompShare 渠道）→ meta.result_meta.remote_url（公开下载链接）
- adapter=h3_ref2va（自部署）→ meta.logs 里 poll 阶段的 /v1/videos/xxx.mp4 相对
  路径，需带 AIModel 配置的 api_key 到自部署服务拉取

策略：重新下载并【写回原路径】，数据库引用（output_urls / generated_video_url）
无需改动。远端链接已过期/服务不可达的条目会列入失败清单。

用法: cd backend && ./venv/Scripts/python.exe scripts/recover_deleted_videos.py
"""
import asyncio
import logging
import os
import sys
from typing import Optional

sys.path.insert(0, ".")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recover")

import httpx
from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.models import GenerationTask, AIModel


def _local_abs(local_url: str) -> str:
    rel = local_url.replace("/uploads/", "", 1) if local_url.startswith("/uploads/") else local_url.lstrip("/")
    return os.path.join("uploads", rel)


async def _download_to(url: str, headers: dict, dest: str) -> tuple:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0), follow_redirects=True) as client:
            async with client.stream("GET", url, headers=headers) as resp:
                if resp.status_code != 200:
                    return False, f"HTTP {resp.status_code}"
                total = 0
                with open(dest, "wb") as f:
                    async for chunk in resp.aiter_bytes():
                        total += len(chunk)
                        f.write(chunk)
                if total < 1024:
                    os.remove(dest)
                    return False, f"too small ({total}B), likely error page"
        return True, f"{total // 1024}KB"
    except Exception as e:
        if os.path.exists(dest):
            os.remove(dest)
        return False, str(e)[:120]


async def main():
    # 自部署 Ref2VA 的 endpoint/api_key（视频还在服务器上，带鉴权拉取）
    ref2va: Optional[dict] = None
    async with AsyncSessionLocal() as db:
        r = await db.execute(select(AIModel).where(AIModel.provider == "h3_ref2va"))
        m = r.scalar_one_or_none()
        if m and m.endpoint and m.api_key:
            ref2va = {"endpoint": m.endpoint.rstrip("/"), "api_key": m.api_key}

    jobs = []  # (local_url, source_url, headers)
    async with AsyncSessionLocal() as db:
        r = await db.execute(select(GenerationTask).where(GenerationTask.type == "video"))
        for t in r.scalars():
            meta = t.meta or {}
            rm = meta.get("result_meta", {}) or {}
            adapter = rm.get("adapter") or meta.get("adapter")
            for u in (t.output_urls or []):
                if not (isinstance(u, str) and u.startswith("/uploads/video/")):
                    continue
                dest = _local_abs(u)
                if os.path.exists(dest):
                    continue
                if adapter == "minimax":
                    remote = rm.get("remote_url") or meta.get("remote_url")
                    if remote:
                        jobs.append((u, remote, {}))
                elif adapter == "h3_ref2va" and ref2va:
                    # 从 poll 日志提取 /v1/videos/xxx.mp4 相对路径
                    for lg in (meta.get("logs") or []):
                        ru = str((lg.get("data") or {}).get("remote_url") or "")
                        if "/v1/videos/" in ru:
                            jobs.append((u, f"{ref2va['endpoint']}{ru}",
                                         {"Authorization": f"Bearer {ref2va['api_key']}"}))
                            break

    log.info("待恢复: %d 个文件", len(jobs))
    ok, fail = [], []
    for local_url, src, headers in jobs:
        dest = _local_abs(local_url)
        if not src.startswith("http"):
            fail.append((local_url, f"bad src {src[:60]}"))
            continue
        success, info = await _download_to(src, headers, dest)
        (ok if success else fail).append((local_url, info))
        log.info("%s %s <- %s (%s)", "OK " if success else "FAIL", local_url.split("/")[-1], src[:70], info)

    log.info("=" * 60)
    log.info("恢复成功 %d / %d", len(ok), len(jobs))
    for u, i in ok:
        log.info("  OK   %s (%s)", u.split("/")[-1], i)
    for u, i in fail:
        log.info("  FAIL %s (%s)", u.split("/")[-1], i)


asyncio.run(main())
