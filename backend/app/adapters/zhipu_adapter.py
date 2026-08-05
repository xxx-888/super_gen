"""
Zhipu Adapter - 智谱 AI 真实适配器（CogView 文生图 + CogVideoX 图生视频）

接通智谱开放平台真实 API，让流水线产出真实图片/视频。
统一走 https://open.bigmodel.cn/api/paas/v4 端点，用单个 API Key。

能力：
- text_to_image / fusion_generate: CogView 文生图
    POST /images/generations  同步返回 {data:[{url}]}
- image_to_video: CogVideoX 图生视频（异步）
    POST /videos/generations 提交 → GET /async-result/{id} 轮询
- first_last_frame_video: CogVideoX 首尾帧（image_url 传两个 url 数组）

配置读取优先级（适配器自取，不依赖 API 端点传参）：
1. 传入的 model_config（AIModel 表，provider=zhipu）
2. settings.LLM_API_KEY / LLM_BASE_URL（与 LLM 共用同一个智谱 key）

注意：CogVideoX 是异步任务，提交后需要轮询，单镜视频生成通常 30-120 秒。
"""
import asyncio
import logging
from typing import Optional, Dict, Any, List

import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult
from app.core.config import settings

logger = logging.getLogger(__name__)


# glm-image 推荐尺寸（文档官方值，最大像素 2^22）
_GLM_IMAGE_SIZE = {
    "1:1": "1280x1280",
    "16:9": "1728x960",
    "9:16": "960x1728",
    "4:3": "1472x1088",
    "3:4": "1088x1472",
    "3:2": "1568x1056",
    "2:3": "1056x1568",
}
# cogview-3 系列推荐尺寸（最大像素 2^21，需被 16 整除）
_COGVIEW_SIZE = {
    "1:1": "1024x1024",
    "16:9": "1440x720",
    "9:16": "720x1440",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "3:2": "1344x768",
    "2:3": "768x1344",
}
# CogVideoX 视频分辨率
_VIDEO_SIZE = {
    "16:9": "1920x1080",
    "9:16": "1080x1920",
    "1:1": "1080x1080",
}


class ZhipuAdapter(BaseAdapter):
    """智谱 AI 适配器（CogView 文生图 + CogVideoX 视频）。"""

    SUPPORTS = {
        "text_to_image": True,
        "image_to_image": False,
        "fusion_generate": True,
        "image_to_video": True,
        "first_last_frame": True,
        "lip_sync": False,
        "tts": False,
        "image_edit": False,
    }

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        super().__init__(model_config)
        cfg = self.config or {}
        # 优先从 model_config 读，回退到 settings（LLM_API_KEY 与 CogView/CogVideoX 同一个智谱 key）
        self.api_key = cfg.get("api_key") or getattr(settings, "LLM_API_KEY", None)
        base = cfg.get("endpoint") or cfg.get("base_url") or getattr(settings, "LLM_BASE_URL", None) \
            or "https://open.bigmodel.cn/api/paas/v4"
        # 容错：用户可能在后台 endpoint 填了完整方法路径（如 .../paas/v4/images/generations），
        # 统一剥离已知的后缀，只保留到 base（paas/v4），避免拼接时路径重复导致 404。
        for suffix in ("/images/generations", "/videos/generations", "/async-result", "/chat/completions"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
                break
        self.base_url = base.rstrip("/")
        # 各能力的 model 名：后台 config 里可填 image_model/video_model，或直接填 model（按 type 推断）
        cfg_inner = cfg.get("config", {}) if isinstance(cfg.get("config"), dict) else {}
        cfg_model = cfg_inner.get("model")  # 后台通用 model 字段
        cfg_type = cfg.get("type", "")
        # 文生图模型：优先 image_model，其次若该条配置是 text_to_image 则用 model 字段
        self.image_model = (
            cfg_inner.get("image_model") or cfg.get("image_model")
            or (cfg_model if cfg_type == "text_to_image" else None)
            or "cogview-3-flash"
        )
        # 视频模型：优先 video_model，其次若该条配置是 image_to_video 则用 model 字段
        self.video_model = (
            cfg_inner.get("video_model") or cfg.get("video_model")
            or (cfg_model if cfg_type == "image_to_video" else None)
            or "cogvideox"
        )
        self.max_poll_seconds = int(cfg_inner.get("max_poll_seconds", 180))
        self.poll_interval = int(cfg_inner.get("poll_interval", 5))
        # 文生图默认参数（后台 config 可覆盖；测试连接用 standard，正式生成用 hd）
        self.image_quality = cfg_inner.get("quality") or "hd"
        self.watermark_enabled = cfg_inner.get("watermark_enabled", True)

    def _available(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def test_connection(self) -> bool:
        """测试连接：用最快最省的方式（临时切到 cogview-3-flash + standard + 1024，约 8 秒）。

        不用配置里的 glm-image + hd（那要 40+ 秒），专门用最快的组合验证 API Key 有效性。
        """
        if not self._available():
            return False
        # 临时用 cogview-3-flash + standard（最快），不改动 self 的配置
        saved_model, saved_quality = self.image_model, self.image_quality
        try:
            self.image_model = "cogview-3-flash"
            self.image_quality = "standard"
            res = await self.text_to_image(GenInput(prompt="test", size="1:1", count=1))
            return res.success
        except Exception as e:
            logger.warning(f"Zhipu test_connection failed: {e}")
            return False
        finally:
            self.image_model = saved_model
            self.image_quality = saved_quality

    def _pick_image_size(self, ratio: str) -> str:
        """按当前 image_model 选合适的像素尺寸（glm-image 和 cogview 系列推荐值不同）。"""
        if self.image_model.startswith("glm-image"):
            return _GLM_IMAGE_SIZE.get(ratio, "1280x1280")
        return _COGVIEW_SIZE.get(ratio, "1024x1024")

    # ==================== 文生图（CogView / GLM-Image） ====================
    async def text_to_image(self, inp: GenInput) -> GenResult:
        """文生图（同步）。支持 glm-image / cogview-3-flash 等，带 quality + watermark 参数。"""
        if not self._available():
            return GenResult(success=False, error="Zhipu api_key not configured")
        size = self._pick_image_size(inp.size)
        # 优先用 inp.extra 里的覆盖，否则用配置默认值
        quality = (inp.extra.get("quality") if inp.extra else None) or self.image_quality
        watermark = (inp.extra.get("watermark_enabled") if inp.extra else None)
        if watermark is None:
            watermark = self.watermark_enabled
        payload: Dict[str, Any] = {
            "model": self.image_model,
            "prompt": (inp.prompt or "a photo")[:1500],
            "size": size,
            "quality": quality,
            "watermark_enabled": bool(watermark),
        }
        # glm-image 仅支持 hd，若传了 standard 会被忽略，这里不强制纠正（让 API 自己处理）
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    f"{self.base_url}/images/generations",
                    json=payload, headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()
            urls = [d.get("url") for d in (data.get("data") or []) if d.get("url")]
            if not urls:
                return GenResult(success=False, error=f"no image url in response: {str(data)[:200]}")
            # 远端 URL 会过期(约24h), 异步下载到本地并用本地 URL 替换; 失败则降级保留原 URL
            from app.services.asset_downloader import download_to_local
            local_urls = await asyncio.gather(
                *[download_to_local(u, category="image") for u in urls],
                return_exceptions=False,
            )
            return GenResult(
                urls=[u for u in local_urls[:inp.count]] if inp.count else list(local_urls),
                meta={
                    "adapter": "zhipu", "model": self.image_model, "raw": data,
                    "remote_urls": urls,  # 保留原始远端 URL 备用
                },
            )
        except httpx.HTTPStatusError as e:
            err = f"CogView HTTP {e.response.status_code}: {e.response.text[:300]}"
            logger.error(err)
            return GenResult(success=False, error=err)
        except Exception as e:
            logger.error(f"CogView failed: {e}")
            return GenResult(success=False, error=str(e)[:300])

    async def fusion_generate(self, inp: GenInput) -> GenResult:
        """融合生图：把元素信息拼到 prompt 里，复用文生图。"""
        # 把元素（角色/场景/物品）的描述融入 prompt
        parts = [inp.prompt]
        for el in inp.elements:
            if el.name:
                desc = el.name
                # 可扩展：从 meta 取外观描述
                parts.append(desc)
        enriched = GenInput(
            prompt="，".join(parts),
            elements=[],  # 已融入 prompt
            size=inp.size, count=inp.count,
        )
        return await self.text_to_image(enriched)

    # ==================== 图生视频（CogVideoX，异步） ====================
    async def image_to_video(self, inp: GenInput) -> GenResult:
        """CogVideoX 图生视频：提交 → 轮询 → 返回视频 URL。"""
        if not self._available():
            return GenResult(success=False, error="Zhipu api_key not configured")
        if not inp.image_url:
            return GenResult(success=False, error="image_to_video 需要 image_url")

        size = _VIDEO_SIZE.get(inp.size, "1920x1080")
        payload: Dict[str, Any] = {
            "model": self.video_model,
            "image_url": inp.image_url,
            "prompt": (inp.prompt or "让画面动起来")[:512],
            "quality": "quality",
            "size": size,
        }
        if inp.duration:
            payload["duration"] = int(inp.duration) if inp.duration in (5, 10) else 5

        try:
            # 1. 提交任务
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{self.base_url}/videos/generations",
                    json=payload, headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()
            task_id = data.get("id")
            if not task_id:
                return GenResult(success=False, error=f"no task id: {str(data)[:200]}")
            logger.info(f"CogVideoX task submitted: {task_id}")

            # 2. 轮询结果
            return await self._poll_video(task_id)
        except httpx.HTTPStatusError as e:
            err = f"CogVideoX submit HTTP {e.response.status_code}: {e.response.text[:300]}"
            logger.error(err)
            return GenResult(success=False, error=err)
        except Exception as e:
            logger.error(f"CogVideoX failed: {e}")
            return GenResult(success=False, error=str(e)[:300])

    async def first_last_frame_video(self, inp: GenInput) -> GenResult:
        """首尾帧生视频：image_url 传 [首帧url, 尾帧url]。"""
        if not inp.first_frame_url:
            return GenResult(success=False, error="first_last_frame 需要 first_frame_url")
        frames = [inp.first_frame_url]
        if inp.last_frame_url:
            frames.append(inp.last_frame_url)
        merged = GenInput(
            prompt=inp.prompt, image_url=frames if len(frames) > 1 else frames[0],
            size=inp.size, duration=inp.duration,
        )
        return await self.image_to_video(merged)

    # ==================== 异步轮询 ====================
    async def _poll_video(self, task_id: str) -> GenResult:
        """轮询 CogVideoX 任务结果。"""
        deadline_polls = self.max_poll_seconds // self.poll_interval
        url = f"{self.base_url}/async-result/{task_id}"
        async with httpx.AsyncClient(timeout=30) as client:
            for _ in range(deadline_polls):
                await asyncio.sleep(self.poll_interval)
                try:
                    resp = await client.get(url, headers=self._headers())
                    resp.raise_for_status()
                    data = resp.json()
                except Exception as e:
                    logger.warning(f"poll {task_id} error: {e}")
                    continue
                status = data.get("task_status")
                logger.debug(f"poll {task_id}: {status}")
                if status == "SUCCESS":
                    vids = data.get("video_result") or []
                    urls = [v.get("url") for v in vids if v.get("url")]
                    covers = [v.get("cover_image_url") for v in vids if v.get("cover_image_url")]
                    if not urls:
                        return GenResult(success=False, error=f"SUCCESS but no video url: {str(data)[:200]}")
                    # 远端 URL 会过期, 异步下载视频与封面到本地; 失败降级保留原 URL
                    from app.services.asset_downloader import download_to_local
                    local_videos = await asyncio.gather(
                        *[download_to_local(u, category="video") for u in urls],
                        return_exceptions=False,
                    )
                    local_covers = await asyncio.gather(
                        *[download_to_local(c, category="image") for c in covers],
                        return_exceptions=False,
                    ) if covers else []
                    return GenResult(
                        urls=list(local_videos),
                        thumbnail_urls=list(local_covers),
                        meta={
                            "adapter": "zhipu", "model": self.video_model, "task_id": task_id,
                            "remote_urls": urls,            # 保留原始远端视频 URL 备用
                            "remote_covers": covers,        # 保留原始远端封面 URL 备用
                        },
                    )
                if status == "FAIL":
                    return GenResult(success=False, error=f"CogVideoX task FAIL: {str(data)[:300]}")
                # PROCESSING → 继续轮询
        return GenResult(success=False, error=f"CogVideoX task {task_id} timeout after {self.max_poll_seconds}s")
