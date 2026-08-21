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

# GPT 生图支持的尺寸白名单（按档位）
#   1K: 1024x1024 / 1024x1536 / 1536x1024
#   2K: 2048x2048 / 2048x1152
#   3K: 3840x2160 / 2160x3840
_ALLOWED_SIZES = {
    "1024x1024", "1024x1536", "1536x1024",
    "2048x2048", "2048x1152",
    "3840x2160", "2160x3840",
}

# 比例类别 × 档位 → 像素尺寸（缺档自动向低档回退，如 2K 竖版回退 1K）
_SIZE_BY_TIER = {
    "1k": {"square": "1024x1024", "landscape": "1536x1024", "portrait": "1024x1536"},
    "2k": {"square": "2048x2048", "landscape": "2048x1152"},
    "3k": {"landscape": "3840x2160", "portrait": "2160x3840"},
}
_TIER_ORDER = ["3k", "2k", "1k"]

# gpt-image 质量档位：只生成 中/高 档（low 一律升到 medium，auto 固定 high）
_GPT_IMAGE_QUALITY = {
    "hd": "high", "high": "high", "auto": "high",
    "standard": "medium", "medium": "medium", "low": "medium",
}


def _orientation_of(ratio: str) -> str:
    """比例 → 方向类别：square / landscape / portrait"""
    r = (ratio or "").strip().lower()
    if r in ("1:1", "1/1", "square"):
        return "square"
    try:
        w, h = r.replace("/", ":").split(":")
        if w and h:
            return "landscape" if float(w) >= float(h) else "portrait"
    except (ValueError, ZeroDivisionError):
        pass
    return "square"


class OpenAIAdapter(BaseAdapter):
    """OpenAI 文生图适配器（dall-e-3 / gpt-image-1）。"""

    SUPPORTS = {
        "text_to_image": True,
        "fusion_generate": True,
        "image_to_image": True,
        "image_to_video": False,
        "first_last_frame": False,
        "lip_sync": False,
        "tts": False,
        "image_edit": True,
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
        # 出站代理（config.proxy / config.proxy_url）：api.openai.com 等端点在大陆服务器
        # 不可直连，可在后台「配置模型」的 config JSON 里填 "proxy": "http://host:port"
        self.proxy = (str(cfg.get("proxy") or cfg.get("proxy_url") or "")).strip() or None

    def _client(self, timeout) -> httpx.AsyncClient:
        """按模型配置构建 httpx 客户端（未配代理时行为与裸 AsyncClient 一致）"""
        return httpx.AsyncClient(timeout=timeout, proxy=self.proxy)

    def _available(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _pick_size(self, ratio: str, resolution: Optional[str] = None) -> str:
        """比例 + 分辨率档位 → OpenAI 像素尺寸.

        - 显式传入白名单内的 WxH 直接使用
        - resolution 含 2k → 2K 档；3k/4k → 3K 档（GPT 生图最高档）；其余 → 1K
        - 目标档位缺该比例时向低档回退（2K 竖版→1K 竖版，3K 方图→2K→1K）
        """
        r = (ratio or "").strip().lower()
        if r in _ALLOWED_SIZES:
            return r
        # 分辨率档位
        res = (resolution or "").strip().lower()
        tier = "3k" if res in ("3k", "4k", "2160p") else ("2k" if res in ("2k", "2048p") else "1k")
        orient = _orientation_of(r)
        for t in _TIER_ORDER[_TIER_ORDER.index(tier):]:
            size = _SIZE_BY_TIER[t].get(orient)
            if size:
                return size
        return "1024x1024"

    def _gpt_image_quality(self, raw_quality: Optional[str]) -> str:
        """gpt-image 质量档位：只允许 medium/high（low 升 medium，未知值 high）"""
        return _GPT_IMAGE_QUALITY.get((raw_quality or "").strip().lower(), "high")

    async def test_connection(self) -> bool:
        if not self._available():
            return False
        try:
            async with self._client(15) as client:
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

        size = self._pick_size(inp.size or "1:1", (inp.extra or {}).get("resolution"))
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
        # gpt-image 系列（gpt-image-1/gpt-image-2）质量只发 medium/high：
        # low 一律升到 medium，auto 固定 high，不生成低档图
        elif self.image_model.startswith("gpt-image"):
            payload["quality"] = self._gpt_image_quality(raw_quality)

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
            async with self._client(None) as client:
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
        """融合生图：有参考图（image_url / @引用元素图）时走图生图（edits），否则拼 prompt 文生图"""
        has_ref_image = bool(inp.image_url) or any(
            el.image_url for el in (inp.elements or []) if getattr(el, "image_url", None)
        )
        if has_ref_image:
            return await self.image_to_image(inp)
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

    # ==================== 图生图（参考图 → 图） ====================

    @staticmethod
    def _sniff_image_mime(head: bytes) -> str:
        if head.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if head.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            return "image/webp"
        if head.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif"
        return "image/png"  # OpenAI edits 要求 png/webp/jpg，兜底 png

    async def _load_image_bytes(self, url: str) -> Optional[tuple]:
        """把参考图（本地 /uploads 或公网 URL）读成 (bytes, mime)，失败返回 None。"""
        import os as _os
        try:
            if url.startswith(("http://", "https://")) and "/uploads/" not in url:
                async with self._client(30) as client:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    return resp.content, self._sniff_image_mime(resp.content[:16])
            from app.core.config import settings
            rel = url[len("/uploads/"):] if url.startswith("/uploads/") else url.lstrip("/")
            path = _os.path.join(settings.STORAGE_LOCAL_PATH, rel)
            if not _os.path.exists(path):
                return None
            with open(path, "rb") as f:
                data = f.read()
            return data, self._sniff_image_mime(data[:16])
        except Exception as e:
            logger.warning(f"load reference image failed ({url}): {e}")
            return None

    async def image_to_image(self, inp: GenInput) -> GenResult:
        """图生图：参考图 + 提示词 → 新图（OpenAI Images Edits，gpt-image 系列支持多图）。

        参考图来源：inp.image_url 优先，其次 @引用 elements 的图片（最多 4 张，
        gpt-image-1 支持 image[] 多图输入）。dall-e-2 仅支持单图。
        """
        if not self._available():
            return GenResult(success=False, error="OpenAI api_key not configured")
        if self.image_model.startswith("dall-e-3"):
            return GenResult(success=False, error="dall-e-3 不支持图生图，请把模型切换为 gpt-image 系列")

        # 收集参考图（去重）
        ref_urls = []
        if inp.image_url:
            ref_urls.append(inp.image_url)
        for el in (inp.elements or []):
            if el.image_url and el.image_url not in ref_urls:
                ref_urls.append(el.image_url)
        if not ref_urls:
            return GenResult(success=False, error="图生图需要至少一张参考图（image_url 或 @引用资源）")
        ref_urls = ref_urls[:4]

        images = []
        for u in ref_urls:
            loaded = await self._load_image_bytes(u)
            if loaded:
                images.append(loaded)
        if not images:
            return GenResult(success=False, error=f"参考图全部加载失败: {ref_urls}")

        size = self._pick_size(inp.size or "1:1", (inp.extra or {}).get("resolution"))
        data_fields = {
            "model": self.image_model,
            "prompt": (inp.prompt or "根据参考图生成")[:4000],
            "size": size,
            "n": str(min(inp.count or 1, 1)),
        }
        # gpt-image 的 edits 接口同样支持质量档位：只发 medium/high
        if self.image_model.startswith("gpt-image"):
            raw_q = (inp.extra.get("quality") if inp.extra else None) or self.image_quality
            data_fields["quality"] = self._gpt_image_quality(raw_q)
        files = [("image[]" if len(images) > 1 else "image", (f"ref{i}.png", b, m))
                 for i, (b, m) in enumerate(images)]
        logs_meta: Dict[str, Any] = {"logs": []}
        logs_meta = append_logs(logs_meta, "info", "request",
                                f"POST {self.base_url}/images/edits（{len(images)} 张参考图）",
                                {"model": self.image_model, "size": size,
                                 "prompt": (inp.prompt or "")[:300],
                                 "refs": ref_urls})
        try:
            async with self._client(None) as client:
                resp = await client.post(
                    f"{self.base_url}/images/edits",
                    data=data_fields, files=files,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                resp.raise_for_status()
                data = resp.json()

            urls = []
            b64s = [it["b64_json"] for it in (data.get("data") or []) if it.get("b64_json")]
            if b64s:
                from app.services.asset_downloader import save_b64_to_local
                urls.extend(await asyncio.gather(*[save_b64_to_local(b, category="image") for b in b64s]))
            for it in (data.get("data") or []):
                if it.get("url"):
                    urls.append(it["url"])
            if not urls:
                return GenResult(success=False, error=f"no image in response: {str(data)[:200]}",
                                 meta=append_logs(logs_meta, "error", "submit", "响应无图片",
                                                  {"model": self.image_model, "response": data}))
            # 远端 URL 落本地
            remote = [u for u in urls if u.startswith("http")]
            if remote:
                from app.services.asset_downloader import download_to_local
                local = await asyncio.gather(*[download_to_local(u, category="image") for u in remote])
                urls = [local[remote.index(u)] if u in remote else u for u in urls]
            logs_meta = append_logs(logs_meta, "info", "response",
                                    f"图生图成功，生成 {len(urls)} 张",
                                    {"model": self.image_model, "final_local_urls": urls})
            return GenResult(urls=urls, meta={**logs_meta, "adapter": "openai", "model": self.image_model})
        except httpx.HTTPStatusError as e:
            err = f"OpenAI HTTP {e.response.status_code}: {e.response.text[:300]}"
            return GenResult(success=False, error=err,
                             meta=append_logs(logs_meta, "error", "submit", err,
                                              {"status_code": e.response.status_code,
                                               "response": e.response.text[:300]}))
        except Exception as e:
            logger.error(f"OpenAI image_to_image failed: {e}", exc_info=True)
            return GenResult(success=False, error=str(e)[:300],
                             meta=append_logs(logs_meta, "error", "submit", f"图生图异常: {e}"))

    async def image_edit(self, inp: GenInput) -> GenResult:
        """图片改创：与图生图同链路（参考图 + 指令 → 新图）。"""
        return await self.image_to_image(inp)
