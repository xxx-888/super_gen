"""
OpenAI Adapter - OpenAI 文生图适配器

支持 OpenAI 的 Images API（dall-e-3 / gpt-image-1 等）。
- POST {endpoint}/images/generations
- 返回图片 URL 或 b64_json

provider=openai 时由 factory 选用此适配器。
"""
import asyncio
import logging
from typing import Dict, Any, Optional

import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult, append_logs

logger = logging.getLogger(__name__)

# 比例 → OpenAI 像素尺寸映射
_RATIO_TO_SIZE = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "1792x1024": "1792x1024",
    "1024x1792": "1024x1792",
}


class OpenAIAdapter(BaseAdapter):
    """OpenAI 文生图适配器（dall-e-3 / gpt-image-1）。"""

    SUPPORTS = {
        "text_to_image": True,
        "fusion_generate": True,
        "image_to_image": False,
        "image_to_video": False,
        "first_last_frame": False,
        "lip_sync": False,
        "tts": False,
        "image_edit": False,
    }

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        super().__init__(model_config)
        cfg = self.config.get("config") or {}
        self.api_key = self.config.get("api_key") or ""
        self.base_url = (self.config.get("endpoint") or "https://api.openai.com/v1").rstrip("/")
        # 模型名：优先 config.model，其次 config.image_model，默认 gpt-image-1
        self.image_model = cfg.get("model") or cfg.get("image_model") or "gpt-image-1"
        self.image_quality = cfg.get("quality") or "auto"
        self.watermark_enabled = cfg.get("watermark_enabled", False)

    def _available(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _pick_size(self, ratio: str) -> str:
        """比例 → OpenAI 像素尺寸"""
        return _RATIO_TO_SIZE.get(ratio, "1024x1024")

    async def test_connection(self) -> bool:
        if not self._available():
            return False
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{self.base_url}/models",
                    headers=self._headers(),
                )
                return resp.status_code == 200
        except Exception:
            return False

    async def text_to_image(self, inp: GenInput) -> GenResult:
        """文生图（OpenAI Images API）"""
        if not self._available():
            return GenResult(success=False, error="OpenAI api_key not configured")

        size = self._pick_size(inp.size or "1:1")
        raw_quality = (inp.extra.get("quality") if inp.extra else None) or self.image_quality
        count = min(inp.count or 1, 1)

        payload: Dict[str, Any] = {
            "model": self.image_model,
            "prompt": (inp.prompt or "a photo")[:4000],
            "size": size,
            "n": count,
        }
        # dall-e-3 支持 quality: hd/standard
        if self.image_model.startswith("dall-e"):
            payload["quality"] = raw_quality if raw_quality in ("hd", "standard") else "standard"
            payload["response_format"] = "url"
        # gpt-image 系列（gpt-image-1/gpt-image-2）支持 quality: low/medium/high/auto
        elif self.image_model.startswith("gpt-image"):
            # 把平台的 hd/standard 映射到 OpenAI 的 high/medium
            quality_map = {"hd": "high", "standard": "medium"}
            mapped = quality_map.get(raw_quality, raw_quality)
            payload["quality"] = mapped if mapped in ("low", "medium", "high", "auto") else "high"

        logger.info(f"[OpenAIAdapter] model={self.image_model}, size={size}, quality={payload.get('quality')}, prompt={inp.prompt[:80]}...")

        logs_meta: Dict[str, Any] = {"logs": []}
        # 请求日志：真实接口参数（prompt 截断，与 LLM 侧口径一致）
        logs_meta = append_logs(logs_meta, "info", "request",
                                f"POST {self.base_url}/images/generations",
                                {"model": self.image_model, "prompt": (inp.prompt or "")[:300],
                                 "size": size, "n": count, "quality": payload.get("quality")})
        try:
            # timeout=None 表示不限时（因为此代码在后台 asyncio.create_task 里跑，不阻塞 HTTP 响应）
            # 前端通过 gen_task_tracker 轮询查结果，不会因为等待而超时
            async with httpx.AsyncClient(timeout=None) as client:
                resp = await client.post(
                    f"{self.base_url}/images/generations",
                    json=payload,
                    headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()

            urls = []
            b64_images = []
            for item in (data.get("data") or []):
                if item.get("url"):
                    urls.append(item["url"])
                elif item.get("b64_json"):
                    b64_images.append(item["b64_json"])

            # b64_json 需要保存为本地文件
            if b64_images:
                from app.services.asset_downloader import save_b64_to_local
                local_from_b64 = await asyncio.gather(
                    *[save_b64_to_local(b64, category="image") for b64 in b64_images],
                    return_exceptions=False,
                )
                urls.extend(local_from_b64)

            if not urls:
                return GenResult(
                    success=False,
                    error=f"no image in response: {str(data)[:200]}",
                    meta=append_logs(logs_meta, "error", "submit", "响应无图片",
                                     {"model": self.image_model, "request": payload, "response": data}),
                )

            # 远端 URL 下载到本地
            remote_urls = [u for u in urls if u.startswith("http")]
            if remote_urls:
                from app.services.asset_downloader import download_to_local
                local_urls = await asyncio.gather(
                    *[download_to_local(u, category="image") for u in remote_urls],
                    return_exceptions=False,
                )
                # 替换远端 URL 为本地 URL
                final_urls = []
                li = 0
                for u in urls:
                    if u.startswith("http"):
                        final_urls.append(local_urls[li])
                        li += 1
                    else:
                        final_urls.append(u)
                urls = final_urls

            # 响应日志：完整结构摘要（usage/revised_prompt/图片明细；base64 只记长度不落原文，避免日志爆炸）
            logs_meta = append_logs(logs_meta, "info", "response",
                                    f"OpenAI 文生图成功，生成 {len(urls)} 张", {
                                        "model": self.image_model,
                                        "size": size,
                                        "quality": payload.get("quality"),
                                        "created": data.get("created"),
                                        "usage": data.get("usage"),
                                        "revised_prompt": ((data.get("data") or [{}])[0] or {}).get("revised_prompt"),
                                        "images": [
                                            {"url": it.get("url")} if it.get("url")
                                            else {"b64_json_chars": len(it.get("b64_json") or "")}
                                            for it in (data.get("data") or [])
                                        ],
                                        "final_local_urls": urls,
                                    })
            return GenResult(
                urls=urls[:inp.count] if inp.count else urls,
                meta={**logs_meta, "adapter": "openai", "model": self.image_model},
            )

        except httpx.HTTPStatusError as e:
            err = f"OpenAI HTTP {e.response.status_code}: {e.response.text[:300]}"
            logger.error(err)
            return GenResult(
                success=False, error=err,
                meta=append_logs(logs_meta, "error", "submit", err,
                                 {"status_code": e.response.status_code, "request": payload,
                                  "response": e.response.text[:300]}),
            )
        except httpx.TimeoutException as e:
            err = f"OpenAI API 请求超时（{self.image_model}，quality={payload.get('quality')}），请降低质量或稍后重试"
            logger.error(err)
            return GenResult(
                success=False, error=err,
                meta=append_logs(logs_meta, "error", "submit", err, {"request": payload, "timeout": "300s"}),
            )
        except Exception as e:
            err_msg = str(e) or type(e).__name__
            logger.error(f"OpenAI text_to_image failed: {err_msg}")
            return GenResult(
                success=False, error=err_msg[:300],
                meta=append_logs(logs_meta, "error", "submit", f"文生图异常: {err_msg}", {"request": payload}),
            )

    async def fusion_generate(self, inp: GenInput) -> GenResult:
        """融合生图：把元素信息拼到 prompt 里，复用文生图"""
        parts = []
        for el in (inp.elements or []):
            if el.name:
                desc = el.type or "element"
                parts.append(f"{desc}: {el.name}")
        if inp.prompt:
            parts.append(inp.prompt)
        if parts:
            inp.prompt = " | ".join(parts)
        return await self.text_to_image(inp)
