"""
Placeholder Adapter - 占位适配器

M5 默认适配器: 不调用真实模型, 返回占位资源.
作用: 让整套生成流程(提交->扣积分->任务队列->返回结果)可联调.
后续接入真实 API 时, 只需在 factory 里切换到具体适配器.

占位资源用 placehold.co（真实可访问的占位图服务）+ 示例视频，
确保前端能正常渲染预览，不会因 URL 不存在而报错。
"""
import asyncio
from typing import Optional, Dict, Any
from uuid import uuid4
import urllib.parse

from app.adapters.base import BaseAdapter, GenInput, GenResult

# 公共占位图服务（真实可访问）
_PLACEHOLDER_IMG = "https://placehold.co/640x480/1D2129/86909C/png?text={text}"
# 公共示例视频（可播放的样本视频）
_PLACEHOLDER_VIDEO = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"


class PlaceholderAdapter(BaseAdapter):
    """占位适配器(支持全部能力, 返回可渲染的占位资源)."""

    SUPPORTS = {k: True for k in BaseAdapter.SUPPORTS}

    async def test_connection(self) -> bool:
        await asyncio.sleep(0.05)
        return True

    async def _gen(self, inp: GenInput, kind: str) -> GenResult:
        """通用占位生成: sleep 模拟耗时, 返回占位资源 URL."""
        await asyncio.sleep(0.3)
        uid = uuid4().hex[:8]
        prompt_short = (inp.prompt or "placeholder")[:20].replace("\n", " ")
        text_encoded = urllib.parse.quote(f"{kind} #{uid}\n{prompt_short}")

        if kind in ("image", "fusion", "edit"):
            urls = [
                f"https://placehold.co/640x480/2A2A2A/FFFFFF/png?text={text_encoded}%0A%28{i+1}%29"
                for i in range(inp.count)
            ]
            thumbs = urls
        else:
            # 视频类（video/lipsync）用可播放的示例视频
            urls = [_PLACEHOLDER_VIDEO for _ in range(inp.count)]
            thumbs = [_PLACEHOLDER_IMG.format(text=text_encoded)]

        return GenResult(
            urls=urls,
            thumbnail_urls=thumbs,
            meta={
                "adapter": "placeholder",
                "prompt_preview": (inp.prompt or "")[:80],
                "size": inp.size,
                "count": inp.count,
                "elements": [e.name for e in inp.elements],
                "kind": kind,
            },
            success=True,
        )

    async def text_to_image(self, inp: GenInput) -> GenResult:
        return await self._gen(inp, "image")

    async def fusion_generate(self, inp: GenInput) -> GenResult:
        return await self._gen(inp, "fusion")

    async def image_to_video(self, inp: GenInput) -> GenResult:
        r = await self._gen(inp, "video")
        r.duration = inp.duration or 5.0
        return r

    async def first_last_frame_video(self, inp: GenInput) -> GenResult:
        r = await self._gen(inp, "video")
        r.duration = inp.duration or 5.0
        return r

    async def lip_sync(self, inp: GenInput) -> GenResult:
        r = await self._gen(inp, "lipsync")
        r.duration = inp.duration or 5.0
        return r

    async def tts(self, inp: GenInput) -> GenResult:
        await asyncio.sleep(0.2)
        uid = uuid4().hex[:8]
        return GenResult(
            urls=[f"https://placehold.co/300x50/2A2A2A/FFFFFF/png?text=audio+{uid}"],
            duration=len((inp.text or "")) * 0.08,
            meta={"adapter": "placeholder", "voice_id": inp.voice_id},
        )

    async def image_edit(self, inp: GenInput) -> GenResult:
        return await self._gen(inp, "edit")
