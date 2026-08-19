"""CompShare 渠道 reference_video / reference_audio 支持检测（独立脚本）

背景: minimax_compshare_adapter.py:35 于 2026-08-18 实测该渠道对任意
reference_video 返回 RetCode 230 "Params [reference URL] not available"，
故置 SUPPORTS_REFERENCE_MEDIA=False 自动跳过视频/音频参考。
技术方反馈已支持后，用本脚本直接复测（不经过适配器的跳过逻辑）。

参数来源: 2026-08-19 13:24 任务 774daedf（项目猪猪侠吃猪食分镜 362aa889），
参考视频/音频用当时转传好的公网直链，参考图用当时的本地分镜图。

用法:
    venv/Scripts/python.exe scripts/test_compshare_reference.py            # 完整参数(图+视频+音频)
    venv/Scripts/python.exe scripts/test_compshare_reference.py --media-only  # 只测视频+音频参考
"""
import asyncio
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

# ==== 复刻任务 774daedf 的参数 ====
PROMPT = ("画面主体与场景必须严格参考图1：保持参考图中人物/场景的容貌、发型、服装与风格一致。"
          "画面内容与运镜节奏可参考视频1。声音氛围需贴合音频1。"
          "[视频:测试视频参考素材] [音频:测试音乐] [角色:管家]"
          "参考这个测试视频和测试音频，把里面的角色替换成管家背景音乐替换成参考的测试音乐 ")
REF_IMAGE_LOCAL = "uploads/image/2026/08/456e76d137674ea5847084a3d3e270f1.png"
REF_VIDEO_URL = "http://186.241.125.144:9000/files/2026/08/-2026-08-18_115454_876-114b1e643bda.mp4"
REF_AUDIO_URL = "http://186.241.125.144:9000/files/2026/08/--79b13105c1a8.mp3"
DURATION = 8
RESOLUTION = "768P"
RATIO = "16:9"
POLL_SECONDS = 150  # 最长观察 2.5 分钟：230 会即时返回；受理成功则看状态推进


async def load_model_config():
    """从 AIModel 表读 CompShare 渠道的 endpoint / api_key（与适配器同源）"""
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.models import AIModel

    async with AsyncSessionLocal() as db:
        m = (await db.execute(select(AIModel).where(
            AIModel.provider == "minimax_compshare", AIModel.type == "image_to_video"
        ))).scalar_one()
        endpoint = m.endpoint or "https://cp.compshare.cn/minimax"
        if "compshare.cn" in endpoint and not endpoint.rstrip("/").endswith("/minimax"):
            endpoint = endpoint.rstrip("/") + "/minimax"
        return endpoint, m.api_key


def image_to_data_uri(path: str) -> str:
    p = Path(__file__).resolve().parents[1] / path
    data = p.read_bytes()
    return f"data:image/png;base64,{base64.b64encode(data).decode()}"


async def main():
    media_only = "--media-only" in sys.argv
    endpoint, api_key = await load_model_config()
    print(f"渠道 endpoint: {endpoint}")

    content = [{"type": "text", "text": PROMPT[:5000]}]
    if not media_only:
        content.append({"type": "image_url", "image_url": {"url": image_to_data_uri(REF_IMAGE_LOCAL)},
                        "role": "reference_image"})
    content.append({"type": "video_url", "video_url": {"url": REF_VIDEO_URL}, "role": "reference_video"})
    content.append({"type": "audio_url", "audio_url": {"url": REF_AUDIO_URL}, "role": "reference_audio"})

    payload = {
        "model": "MiniMax-H3",
        "content": content,
        "resolution": RESOLUTION,
        "duration": DURATION,
        "ratio": RATIO,
        "aigc_watermark": False,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
                   "Accept": "application/json",
                   # 文档建议的幂等键：同 Key 返回先前任务，每次测试用新值
                   "Idempotency-Key": f"scenegen-ref-test-{int(__import__('time').time())}"}
        print(f"\n== 提交测试（{'仅视频+音频参考' if media_only else '参考图+视频+音频'}）==")
        resp = await client.post(f"{endpoint}/v2/video_generation", headers=headers,
                                 json=payload)
        print(f"HTTP {resp.status_code}")
        body = resp.json()
        print(json.dumps(body, ensure_ascii=False, indent=2)[:1200])

        # 渠道拒绝参考参数时: RetCode 230 / base_resp 非 0 / 无 task_id
        task_id = body.get("task_id")
        base_resp = body.get("base_resp") or {}
        if resp.status_code != 200 or base_resp.get("status_code") not in (None, 0) or not task_id:
            print("\n>>> 结论: ❌ 渠道仍未支持 reference_video/reference_audio（提交被拒）")
            return

        print(f"\n>>> 提交受理成功! task_id={task_id}，轮询观察 {POLL_SECONDS}s ...")
        import time
        deadline = time.time() + POLL_SECONDS
        last = None
        while time.time() < deadline:
            await asyncio.sleep(5)
            r = await client.get(f"{endpoint}/v2/query/video_generation/{task_id}", headers=headers)
            q = r.json()
            status = q.get("status") or q.get("task_status")
            base = q.get("base_resp") or {}
            info = {"status": status, "progress": q.get("progress"),
                    "base": base.get("status_code"), "msg": base.get("status_msg")}
            if info != last:
                print(f"  [{time.strftime('%H:%M:%S')}] {info}")
                last = info
            if status == "fail" or base.get("status_code") not in (None, 0):
                print(">>> 结论: ❌ 任务失败（可能受理后被参考参数拒绝）:", json.dumps(q, ensure_ascii=False)[:500])
                return
            if status == "succeed":
                print(">>> 结论: ✅ 参考视频/音频全程被接受并成功出片！")
                print("    视频地址:", (q.get("file") or {}).get("download_url", q.get("file")))
                return
        print(f"\n>>> 结论: ✅ 渐进 {POLL_SECONDS}s 内正常推进未被拒（参数已被渠道接受），可提前结束观察")


if __name__ == "__main__":
    asyncio.run(main())
