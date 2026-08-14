"""H3Ref2VAAdapter 端到端联调脚本(本地跑,经 SSH 隧道访问线上服务)

用法(先起隧道: ssh -p 22036 -N -L 8300:localhost:8300 root@<服务器>):
    cd backend && ./venv/Scripts/python.exe scripts/test_h3_ref2va_adapter.py

流程: test_connection → 提交(2 张参考图模拟多图) → 轮询到完成 → 下载落本地存储。
"""
import asyncio
import logging
import sys
import time

sys.path.insert(0, ".")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("h3test")


async def main():
    from app.adapters.base import GenElement, GenInput
    from app.adapters.h3_ref2va_adapter import H3Ref2VAAdapter

    ad = H3Ref2VAAdapter({
        "provider": "h3_ref2va", "name": "H3-Ref2VA-联调",
        "endpoint": "http://localhost:8300",
        "api_key": "h3-sk-9f4c2a7e",
        "config": {"poll_interval": 20, "max_poll_seconds": 1800},
    })
    log.info("test_connection=%s", await ad.test_connection())

    inp = GenInput(
        prompt=("The person from <Picture 1>, an astronaut, standing on the lunar surface "
                "next to the lander from <Picture 2>, cinematic, highly detailed"),
        elements=[
            GenElement(type="character", name="astronaut", image_url="/uploads/h3test/ref.jpg"),
        ],
        image_url="/uploads/h3test/ref.jpg",  # 第二张引用(同一张,验证去重)
        size="16:9",
        duration=5,
        extra={"seed": 11},
    )
    r = await ad.image_to_video(inp)
    log.info("submit success=%s error=%s", r.success, r.error)
    if not r.success:
        return
    tid = r.meta["remote_task_id"]
    log.info("remote_task_id=%s meta=%s", tid, {k: v for k, v in r.meta.items() if k != "logs"})

    t0 = time.time()
    while True:
        await asyncio.sleep(20)
        p = await ad.poll_result(tid)
        if not p.success:
            log.error("FAILED: %s", p.error)
            return
        m = p.meta
        if m.get("poll_pending"):
            log.info("[%5.0fs] status=%s progress=%s eta=%s",
                     time.time() - t0, m.get("status"), m.get("progress"), m.get("eta_s"))
            continue
        log.info("DONE in %.0fs urls=%s duration=%s", time.time() - t0, p.urls, p.duration)
        log.info("logs tail: %s", (m.get("logs") or [])[-2:])
        return


asyncio.run(main())
