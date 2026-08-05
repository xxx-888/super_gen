"""
MiniMax (Hailuo-03 / MiniMax-H3) 适配器

支持 MiniMax-H3 的视频生成 V2 接口：
- 图生视频（i2va）：text prompt + 首帧图片 → 视频
- 文生视频（t2va）：仅 text prompt → 视频
- 多模态参考生视频（r2va）：text + 多张参考图片（角色/场景/道具）→ 视频
  本系统的 @引用 关联的角色/场景/道具图片会作为 reference_image 传给 MiniMax。

API 文档：
- 创建任务：POST /v2/video_generation
- 查询任务：GET /v2/query/video_generation/{task_id}
- 鉴权：Bearer {api_key}
- 状态：queued / running / succeeded / failed / cancelled

图片输入支持：公网 URL、data:image/<格式>;base64,<Base64>。
本地 /uploads/ 图片无法公网访问，会自动转成 base64 data URI 上传。

异步模式：提交后返回 task_id，需轮询查询接口获取结果。
"""
import asyncio
import base64
import logging
import os
from typing import Any, Dict, List, Optional

import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult
from app.core.config import settings

logger = logging.getLogger(__name__)

# MiniMax 分辨率映射：本系统用 720p/1080p/2k → MiniMax 用 768P/2K
_RESOLUTION_MAP = {
    "720p": "768P",
    "1080p": "2K",
    "2k": "2K",
    "2K": "2K",
    "768P": "768P",
    "768p": "768P",
}

# 视频时长限制：MiniMax H3 支持 4-15 秒（V2 接口），但本系统允许用户输入到 60 秒
# 超出 MiniMax 上限时自动截断到 15 秒（避免 API 报错）
def _clamp_duration(d: Optional[float]) -> int:
    if d is None:
        return 5
    n = int(d)
    return max(4, min(15, n))


async def _local_url_to_data_uri(url: str) -> str:
    """把本地 /uploads/... 图片转成 base64 data URI。

    MiniMax 需要公网可访问的 URL 或 data URI。本系统的图片存在本地存储，
    MiniMax 服务器无法访问 /uploads/ 路径，所以转成 base64 内嵌发送。
    如果 url 已经是公网 URL（http/https 开头且不是 /uploads/），原样返回。
    """
    if not url:
        return url
    # 公网 URL 直接用
    if url.startswith(("http://", "https://")) and "/uploads/" not in url:
        return url
    # 本地 /uploads/ 路径 → 读文件转 base64
    try:
        storage_path = getattr(settings, "STORAGE_LOCAL_PATH", None)
        if not storage_path:
            return url  # 无存储路径配置，原样返回（可能 MiniMax 能访问）
        # 从 url 提取相对路径：/uploads/image/2026/08/xxx.jpg → image/2026/08/xxx.jpg
        if url.startswith("/uploads/"):
            rel = url[len("/uploads/"):]
        elif url.startswith("uploads/"):
            rel = url[len("uploads/"):]
        else:
            rel = url.lstrip("/")
        abs_path = os.path.join(storage_path, rel)
        if not os.path.exists(abs_path):
            logger.warning(f"Local image not found: {abs_path}, using url as-is")
            return url
        # 读文件
        import aiofiles
        async with aiofiles.open(abs_path, "rb") as f:
            data = await f.read()
        # 推断 MIME
        ext = os.path.splitext(abs_path)[1].lower()
        mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif"}
        mime = mime_map.get(ext, "image/jpeg")
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except Exception as e:
        logger.warning(f"Failed to convert local image to base64 ({url}): {e}")
        return url


class MinimaxAdapter(BaseAdapter):
    """MiniMax H3 视频生成适配器。"""

    SUPPORTS = {
        "text_to_image": False,
        "image_to_image": False,
        "fusion_generate": False,
        "image_to_video": True,
        "first_last_frame": True,
        "lip_sync": False,
        "tts": False,
        "image_edit": False,
    }

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        super().__init__(model_config)
        cfg = self.config or {}
        self.api_key = cfg.get("api_key") or getattr(settings, "MINIMAX_API_KEY", None)
        base = cfg.get("endpoint") or cfg.get("base_url") or "https://api.minimaxi.com"
        # 容错：剥离用户可能填的完整 API 路径，只保留 base（避免 URL 拼接重复）
        # 例如用户填了 https://api.minimaxi.com/v2/video_generation → 剥离成 https://api.minimaxi.com
        base = base.rstrip("/")
        for suffix in ("/v2/video_generation", "/v2/query/video_generation"):
            if base.endswith(suffix):
                base = base[:-len(suffix)]
                break
        self.base_url = base.rstrip("/")
        # 模型名优先从 config.model（前端存的是 config.config.model），否则默认 MiniMax-H3
        cfg_inner = cfg.get("config", {}) if isinstance(cfg.get("config"), dict) else {}
        self.model = cfg_inner.get("model") or cfg.get("model") or "MiniMax-H3"
        # 轮询参数
        self.max_poll_seconds = int(cfg_inner.get("max_poll_seconds", 300))
        self.poll_interval = int(cfg_inner.get("poll_interval", 5))
        # 分辨率偏好（可被 GenInput.extra 覆盖）
        self.default_resolution = cfg_inner.get("resolution") or "768P"

    def _available(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def test_connection(self) -> bool:
        """简单验证：API Key 存在且能访问查询端点（用一个不存在的 task_id 测试鉴权）。"""
        if not self._available():
            return False
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                # 用一个假 task_id 查询：401=密钥错，400=密钥对但 task 无效，都说明密钥可用
                resp = await client.get(
                    f"{self.base_url}/v2/query/video_generation/test_connection",
                    headers=self._headers(),
                )
                # 401=鉴权失败，其他状态码说明密钥通过了鉴权
                return resp.status_code != 401
        except Exception as e:
            logger.warning(f"MiniMax test_connection error: {e}")
            return False

    async def _build_content(self, inp: GenInput) -> list:
        """构造 MiniMax V2 的 content 数组（异步：本地图片需转 base64）。

        模式自动判定：
        - 有 first_frame / last_frame → 图生视频(i2va)
        - 有 elements（@引用的角色/场景/道具图片）→ 多模态参考生视频(r2va)
          注意：first_frame/last_frame 与 reference_image 互斥（MiniMax 规定），不能混用。
        - 都没有 → 文生视频(t2va)
        """
        content = []
        # text 是必填项
        text = inp.prompt or ""
        if inp.extra.get("minimax_prompt"):
            text = inp.extra["minimax_prompt"]
        if not text:
            text = "让画面动起来"
        content.append({"type": "text", "text": text[:7000]})

        # 收集 frame 图片（i2va 模式）
        frame_urls = []
        if inp.image_url:
            frame_urls.append(("first_frame", inp.image_url))
        if inp.first_frame_url:
            frame_urls.append(("first_frame", inp.first_frame_url))
        if inp.last_frame_url:
            frame_urls.append(("last_frame", inp.last_frame_url))

        # 收集 elements 里的参考图片（r2va 模式）—— 角色/场景/道具的 image_url
        ref_urls: List[str] = []
        for el in (inp.elements or []):
            if el.image_url and el.image_url not in ref_urls:
                ref_urls.append(el.image_url)

        if frame_urls:
            # i2va 模式：首帧/尾帧图片（与 r2va 互斥，优先 frame）
            for role, url in frame_urls[:2]:  # 最多首帧+尾帧
                data_uri = await _local_url_to_data_uri(url)
                content.append({"type": "image_url", "image_url": {"url": data_uri}, "role": role})
        elif ref_urls:
            # r2va 模式：参考图片（角色/场景/道具），最多 9 张
            for url in ref_urls[:9]:
                data_uri = await _local_url_to_data_uri(url)
                content.append({"type": "image_url", "image_url": {"url": data_uri}, "role": "reference_image"})

        return content

    async def image_to_video(self, inp: GenInput) -> GenResult:
        """图生视频 / 文生视频：仅提交任务，返回 remote_task_id（不阻塞轮询）。

        MiniMax 视频生成需要 1-3 分钟，同步轮询会导致前端 HTTP 超时。
        所以这里只提交，把 remote_task_id 放进 meta 返回，由 submit_creation
        的后台任务调 poll_result 轮询。
        """
        if not self._available():
            return GenResult(success=False, error="MiniMax api_key not configured")
        try:
            resolution = inp.extra.get("resolution") or self.default_resolution
            ratio = inp.extra.get("ratio") or inp.size or "16:9"
            payload = {
                "model": self.model,
                "content": await self._build_content(inp),
                "resolution": _RESOLUTION_MAP.get(resolution, resolution),
                "duration": _clamp_duration(inp.duration),
                "ratio": ratio if ratio != "adaptive" else "16:9",
            }
            if "watermark_enabled" in inp.extra:
                payload["aigc_watermark"] = bool(inp.extra["watermark_enabled"])

            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{self.base_url}/v2/video_generation",
                    json=payload, headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()

            task_id = data.get("task_id")
            if not task_id:
                err = data.get("error", {}).get("message") if isinstance(data.get("error"), dict) else str(data)[:300]
                return GenResult(success=False, error=f"MiniMax create failed: {err}")

            logger.info(f"MiniMax H3 task submitted: {task_id} (async polling)")
            # 返回 pending 状态 + remote_task_id，由后台轮询
            return GenResult(
                success=True,
                meta={"adapter": "minimax", "model": self.model, "remote_task_id": task_id, "async_poll": True},
            )
        except httpx.HTTPStatusError as e:
            err_body = e.response.text[:300] if e.response else ""
            return GenResult(success=False, error=f"MiniMax HTTP {e.response.status_code}: {err_body}")
        except Exception as e:
            logger.error(f"MiniMax image_to_video error: {e}", exc_info=True)
            return GenResult(success=False, error=f"MiniMax error: {e}")

    async def poll_result(self, remote_task_id: str) -> GenResult:
        """查询单次 MiniMax 任务状态（供后台轮询循环调用，每次只查一次不阻塞）。

        返回:
        - status 仍为 queued/running → GenResult(success=True, meta={"poll_pending": True})
        - succeeded → GenResult(success=True, urls=[下载后的本地URL])
        - failed/cancelled → GenResult(success=False, error=...)
        """
        url = f"{self.base_url}/v2/query/video_generation/{remote_task_id}"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(url, headers=self._headers())
                resp.raise_for_status()
                data = resp.json()

            task = data.get("task") or {}
            status = task.get("status", "")

            if status == "succeeded":
                content = task.get("content") or {}
                video_url = content.get("url")
                if not video_url:
                    return GenResult(success=False, error="MiniMax succeeded but no url")
                from app.services.asset_downloader import download_to_local
                try:
                    local_url = await download_to_local(video_url, category="video")
                except Exception as e:
                    logger.warning(f"MiniMax download failed, using remote: {e}")
                    local_url = video_url
                return GenResult(
                    urls=[local_url],
                    duration=float(task.get("duration", 0)),
                    meta={"adapter": "minimax", "model": self.model, "remote_task_id": remote_task_id,
                          "remote_url": video_url, "resolution": task.get("resolution"), "ratio": task.get("ratio")},
                )

            if status in ("failed", "cancelled"):
                err = task.get("error", {})
                err_msg = err.get("message", status) if isinstance(err, dict) else status
                return GenResult(success=False, error=f"MiniMax task {status}: {err_msg}")

            # queued / running → 还在处理
            return GenResult(success=True, meta={"poll_pending": True, "status": status})

        except Exception as e:
            logger.warning(f"MiniMax poll {remote_task_id} error: {e}")
            # 查询出错不直接失败，让调用方继续重试
            return GenResult(success=True, meta={"poll_pending": True, "error": str(e)})

    async def first_last_frame_video(self, inp: GenInput) -> GenResult:
        """首尾帧生成视频：MiniMax 支持首帧+尾帧。"""
        if not inp.first_frame_url and not inp.last_frame_url:
            return GenResult(success=False, error="first_last_frame 需要 first_frame_url 或 last_frame_url")
        return await self.image_to_video(inp)
