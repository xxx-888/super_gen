"""MinimaxCompshareAdapter 端到端联调脚本（优云智算 CompShare 渠道）

用法:
    cd backend
    COMPSHARE_API_KEY=sk-ml-xxx ./venv/Scripts/python.exe scripts/test_minimax_compshare_adapter.py
    （或把 Key 作为第一个参数传入）

流程: test_connection（假 task_id 探测鉴权）→ 提交 → 轮询到完成 → 下载落本地存储。
可选:
    --ref <本地图片路径>  以该图作为参考图走 r2va 模式（验证参考图是否生效）
    --cancel              只验证提交+取消链路（不等待生成完成）
"""
import asyncio
import logging
import os
import sys
import time

sys.path.insert(0, ".")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cs_test")


async def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = [a for a in sys.argv[1:] if a.startswith("--")]
    cancel_only = "--cancel" in opts
    ref_path = None
    if "--ref" in opts:
        try:
            ref_path = sys.argv[sys.argv.index("--ref") + 1]
        except IndexError:
            log.error("--ref 需要跟一个本地图片路径")
            return
    positional = [a for a in args if a != ref_path]
    api_key = positional[0] if positional else os.environ.get("COMPSHARE_API_KEY", "")
    if not api_key:
        log.error("缺少 API Key: 设置 COMPSHARE_API_KEY 环境变量，或作为第一个参数传入")
        return

    from app.adapters.base import GenElement, GenInput
    from app.adapters.minimax_compshare_adapter import MinimaxCompshareAdapter

    ad = MinimaxCompshareAdapter({
        "provider": "minimax_compshare", "name": "MiniMax-H3-CompShare-联调",
        "endpoint": "https://cp.compshare.cn/minimax",
        "api_key": api_key,
        "config": {"poll_interval": 10, "max_poll_seconds": 900},
    })
    log.info("base_url=%s model=%s", ad.base_url, ad.model)
    log.info("test_connection=%s", await ad.test_connection())

    # CompShare 渠道仅 768P / 时长 4-15 秒 / 无水印，适配器内部会自动归一
    if ref_path:
        inp = GenInput(
            prompt="参考图1的人物站在海边礁石上看日落，电影感运镜",
            elements=[GenElement(type="character", name="ref", image_url=ref_path)],
            size="16:9", duration=5,
        )
    else:
        inp = GenInput(prompt="一只橘猫在海边驾驶跑车，电影感镜头，阳光海浪", size="16:9", duration=5)
    r = await ad.image_to_video(inp)
    log.info("submit success=%s error=%s", r.success, r.error)
    if not r.success:
        return
    tid = r.meta["remote_task_id"]
    log.info("remote_task_id=%s meta=%s", tid, {k: v for k, v in r.meta.items() if k != "logs"})

    if cancel_only:
        await asyncio.sleep(5)
        log.info("cancel_task=%s", await ad.cancel_task(tid))
        p = await ad.poll_result(tid)
        log.info("after cancel: success=%s error=%s pending=%s", p.success, p.error, p.meta.get("poll_pending"))
        return

    t0 = time.time()
    while True:
        await asyncio.sleep(10)
        p = await ad.poll_result(tid)
        if not p.success:
            log.error("FAILED: %s", p.error)
            return
        m = p.meta
        if m.get("poll_pending"):
            log.info("[%5.0fs] status=%s", time.time() - t0, m.get("status"))
            continue
        log.info("DONE in %.0fs urls=%s duration=%s", time.time() - t0, p.urls, p.duration)
        log.info("logs tail: %s", (m.get("logs") or [])[-2:])
        return


asyncio.run(main())
