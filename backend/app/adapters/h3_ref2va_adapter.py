"""
MiniMax-H3 Ref2VA 自部署适配器(多图参考生视频)

对接项目内 h3-deploy/service.py 自部署服务(单卡 4-bit 量化版 MiniMax-H3 Ref2VA):
- 提交任务:POST /v1/ref2video (multipart: images[] + prompt + height/width/num_frames/seed)
  → {task_id, status: queued}
- 轮询任务:GET /v1/tasks/{task_id}
  → {status: queued/encoding/denoising/decoding/completed/failed, progress, eta_s, error}
- 下载视频:GET /v1/videos/{file} (需 Bearer 鉴权)
- 探活:    GET /healthz → {ready: bool, busy, queued, vram}

与 MinimaxSelfAdapter(OpenAI 兼容网关)的关键差异:
- 本服务只做 ref2va(多图参考生视频),必须至少 1 张参考图,不支持纯文生;
  参考图直接以 multipart 文件上传,无 file_id 中转。
- 生成较慢(单卡 ~12 分钟/条),轮询间隔/超时默认放大;
  任务串行执行,服务端自动排队。

多图参考收集顺序与 MinimaxSelfAdapter 一致:
first_frame_url → image_url → elements[].image_url(去重,最多 9 张),
prompt 里用 <Picture 1>、<Picture 2>… 按顺序引用。

异步模式:image_to_video 只提交任务返回 remote_task_id(meta.async_poll=True),
由 creation_service._async_poll_adapter 后台循环调 poll_result 轮询。
"""
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult, append_logs
from app.core.config import settings

logger = logging.getLogger(__name__)

# 服务端限制(见 h3-deploy/service.py):32G 显存保护上限 960*544 像素
_MAX_PIXELS = 960 * 544
# 常用比例 → (宽,高)(均为 32 的倍数,面积不超上限)
_RATIO_DIMS = {
    "16:9": (960, 544),
    "9:16": (544, 960),
    "4:3": (736, 544),
    "3:4": (544, 736),
    "1:1": (544, 544),
}
_DEFAULT_DIMS = (960, 544)


def _resolve_dims(inp: GenInput) -> Tuple[int, int, str]:
    """按请求比例选服务端可接受的像素尺寸。返回 (width, height, ratio)。"""
    ratio = inp.extra.get("ratio") or inp.size or "16:9"
    dims = _RATIO_DIMS.get(ratio) or _DEFAULT_DIMS
    return dims[0], dims[1], ratio


def _duration_to_frames(duration: Optional[float]) -> int:
    """秒数 → 服务端 num_frames(24fps,内部对齐 17n+5)。

    H3 的视频 VAE 只编码 17n+5 帧且上限 360:有效档位 124(≈5s)..345(≈14.4s),
    15 秒请求会自动落到 345 帧(≈14.4s)。
    """
    seconds = duration if duration and duration > 0 else 5
    raw = int(round(seconds * 24))
    # 对齐到 17n+5,并夹在有效档位内:n∈[7,20] → 124..345
    n = max(7, min(20, round((raw - 5) / 17)))
    return 17 * n + 5


def _frames_to_seconds(frames: int) -> float:
    return round(frames / 24.0, 2)


class H3Ref2VAAdapter(BaseAdapter):
    """自部署 MiniMax-H3 Ref2VA 多图参考生视频适配器。"""

    SUPPORTS = {
        "text_to_image": False,
        "image_to_image": False,
        "fusion_generate": False,
        "image_to_video": True,       # 系统内视频生成统一入口(多图参考)
        "first_last_frame": True,     # 声明支持,首帧作为第 1 张参考图
        "lip_sync": False,
        "tts": False,
        "image_edit": False,
    }

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        super().__init__(model_config)
        cfg = self.config or {}
        self.api_key = cfg.get("api_key") or getattr(settings, "H3_REF2VA_API_KEY", None)
        base = cfg.get("endpoint") or cfg.get("base_url") or ""
        # 容错:剥掉用户可能误填的完整 API 路径,只保留 origin
        base = (base or "").rstrip("/")
        for suffix in ("/v1/ref2video", "/v1"):
            if base.endswith(suffix):
                base = base[:-len(suffix)]
                break
        self.base_url = base.rstrip("/")
        cfg_inner = cfg.get("config", {}) if isinstance(cfg.get("config"), dict) else {}
        self.model = cfg_inner.get("model") or cfg.get("model") or "MiniMax-H3-Ref2VA-NF4"
        # 单卡串行 + ~12 分钟/条:轮询间隔与超时都比常规云 API 放大
        self.poll_interval = int(cfg_inner.get("poll_interval", 15))
        self.max_poll_seconds = int(cfg_inner.get("max_poll_seconds", 1800))

    def _available(self) -> bool:
        return bool(self.api_key and self.base_url)

    def _headers(self) -> Dict[str, str]:
        # multipart 由 httpx 自动设置 Content-Type,这里只带鉴权
        return {"Authorization": f"Bearer {self.api_key}"}

    async def test_connection(self) -> bool:
        """探活:GET /healthz 返回 200 且 ready=True(模型加载完成)。"""
        if not self._available():
            return False
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(f"{self.base_url}/healthz", headers=self._headers())
                if resp.status_code != 200:
                    return False
                return bool(resp.json().get("ready"))
        except Exception as e:
            logger.warning(f"[H3Ref2VA] test_connection error: {e}")
            return False

    def _wrong_capability(self, capability: str) -> GenResult:
        """被图片类任务误选中时给出可操作的提示(常见于后台把类型误配成文生图)。"""
        return GenResult(
            success=False,
            error=("H3 Ref2VA 是多图参考生视频模型,不支持图片生成。"
                   "请在后台把该模型的「类型」配置为「图生视频(image_to_video)」;"
                   "分镜图/融合生图请另配文生图模型(如智谱/OpenAI)。"),
            meta=append_logs(None, "error", "submit",
                             f"H3Ref2VAAdapter 不支持 {capability}(模型类型疑似配错)"),
        )

    async def text_to_image(self, inp: GenInput) -> GenResult:
        return self._wrong_capability("text_to_image")

    async def fusion_generate(self, inp: GenInput) -> GenResult:
        return self._wrong_capability("fusion_generate")

    async def image_edit(self, inp: GenInput) -> GenResult:
        return self._wrong_capability("image_edit")

    def _collect_ref_urls(self, inp: GenInput) -> List[str]:
        """收集参考图 URL(去重、保持顺序):first_frame → image → elements。"""
        urls: List[str] = []
        for u in [inp.first_frame_url, inp.image_url]:
            if u and u not in urls:
                urls.append(u)
        for el in (inp.elements or []):
            if el.image_url and el.image_url not in urls:
                urls.append(el.image_url)
        return urls[:9]  # 服务端上限 9 张

    async def _load_image(self, image_url: str, client: httpx.AsyncClient) -> Tuple[str, bytes, str]:
        """把一张图片读成 (filename, bytes, mime)。本地 /uploads 读文件,公网 URL 下载。"""
        if image_url.startswith(("http://", "https://")) and "/uploads/" not in image_url:
            dl = await client.get(image_url)
            dl.raise_for_status()
            ct = dl.headers.get("content-type", "image/jpeg")
            ext_map = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
            ext = ext_map.get(ct.split(";")[0].strip().lower(), ".jpg")
            return f"ref{ext}", dl.content, ct
        storage_path = getattr(settings, "STORAGE_LOCAL_PATH", None)
        if not storage_path:
            raise ValueError(f"无本地存储配置,无法读取图片: {image_url}")
        if image_url.startswith("/uploads/"):
            rel = image_url[len("/uploads/"):]
        elif image_url.startswith("uploads/"):
            rel = image_url[len("uploads/"):]
        else:
            rel = image_url.lstrip("/")
        abs_path = os.path.join(storage_path, rel)
        if not os.path.exists(abs_path):
            raise FileNotFoundError(f"本地图片不存在: {abs_path}")
        with open(abs_path, "rb") as f:
            data = f.read()
        ext = os.path.splitext(abs_path)[1].lower() or ".jpg"
        mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif"}
        mime = mime_map.get(ext, "image/jpeg")
        return os.path.basename(abs_path) or f"ref{ext}", data, mime

    async def image_to_video(self, inp: GenInput) -> GenResult:
        """提交多图参考生视频任务,返回 remote_task_id(不阻塞轮询)。"""
        if not self._available():
            return GenResult(success=False, error="H3 Ref2VA 自部署服务未配置 api_key/endpoint")

        prompt = (inp.prompt or "").strip() or "让画面动起来"
        # 清洗富文本编辑器混入的零宽字符
        prompt = prompt.replace("\u200b", "").replace("\u200c", "").replace("\ufeff", "")
        ref_urls = self._collect_ref_urls(inp)
        logs_meta: Dict[str, Any] = {"logs": []}

        # 参考绑定指令:官方 ref2va 提示词规范会显式引用 <Picture N> 来锚定参考图,
        # 用户提示词通常不写,导致模型对参考的注意力弱、角色还原度低。自动补一句。
        if ref_urls:
            pics = "、".join(f"<Picture {i + 1}>" for i in range(len(ref_urls)))
            prompt = (f"画面主体必须严格参考 {pics}:保持参考图中人物/场景相同的容貌、"
                      f"发型、服装与风格。" + prompt)

        if not ref_urls:
            return GenResult(
                success=False,
                error="H3 Ref2VA 为多图参考模式,至少需要 1 张参考图(分镜图或 @引用的资源图)",
                meta=append_logs(logs_meta, "error", "submit", "无参考图,ref2va 无法提交"),
            )

        width, height, requested_ratio = _resolve_dims(inp)
        num_frames = _duration_to_frames(inp.duration)
        # 质量档位 → 去噪步数:standard=30(约7分钟/条),hd=49(默认,约12分钟/条)
        quality = str(inp.extra.get("quality") or "hd").lower()
        steps = 30 if quality == "standard" else 49
        # 交付分辨率 → 成品上采样(lanczos 插值:得到交付分辨率,不增加真实细节;
        # 原生 720p 生成在 32G 显存上会 OOM,故生成分辨率固定 960x544)
        res = str(inp.extra.get("resolution") or "").lower()
        upscale = "1080p" if res in ("1080p", "2k", "4k") else ("720p" if res in ("720p", "768p") else "")

        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
                # 读取全部参考图(multipart 直接上传,无 file_id 中转)
                files = []
                for i, u in enumerate(ref_urls):
                    fname, data, mime = await self._load_image(u, client)
                    files.append(("images", (f"{i:02d}_{fname}", data, mime)))
                form = {
                    "prompt": prompt[:16000],
                    "height": str(height),
                    "width": str(width),
                    "num_frames": str(num_frames),
                    "steps": str(steps),
                }
                if upscale:
                    form["upscale"] = upscale
                if inp.extra.get("seed") is not None:
                    try:
                        form["seed"] = str(int(inp.extra["seed"]))
                    except (TypeError, ValueError):
                        pass

                logs_meta = append_logs(logs_meta, "info", "upload",
                                        f"已附带 {len(files)} 张参考图(multipart 直传)",
                                        {"sources": ref_urls})
                resp = await client.post(
                    f"{self.base_url}/v1/ref2video",
                    headers=self._headers(), files=files, data=form,
                )
                resp.raise_for_status()
                data = resp.json()

            task_id = data.get("task_id")
            if not task_id:
                err = data.get("detail") or data.get("error") or str(data)[:300]
                return GenResult(
                    success=False,
                    error=f"H3 Ref2VA 创建失败: {err}",
                    meta=append_logs(logs_meta, "error", "submit", f"创建任务失败: {err}",
                                     {"endpoint": "/v1/ref2video", "response": data}),
                )

            seconds = _frames_to_seconds(num_frames)
            logger.info(
                f"[H3Ref2VA] task submitted: {task_id} "
                f"(refs={len(ref_urls)}, {width}x{height}, {seconds}s, steps={steps}, upscale={upscale or 'none'})"
            )
            logs_meta = append_logs(logs_meta, "info", "submit",
                                    f"任务已提交(ref2va,{len(ref_urls)} 张参考图,steps={steps}{' ,'+upscale+' 上采样' if upscale else ''}),排队/生成中: {task_id}",
                                    {"job_id": task_id, "refs": len(ref_urls),
                                     "width": width, "height": height, "steps": steps,
                                     "upscale": upscale or None,
                                     "seconds": seconds, "ratio": requested_ratio})
            return GenResult(
                success=True,
                meta={
                    **logs_meta,
                    "adapter": "h3_ref2va",
                    "model": self.model,
                    "remote_task_id": task_id,
                    "async_poll": True,
                    "task": "ref2va",
                    "requested_ratio": requested_ratio,
                    "actual_size": f"{width}x{height}",
                },
            )
        except httpx.HTTPStatusError as e:
            body = e.response.text[:300] if e.response else ""
            return GenResult(
                success=False,
                error=f"H3 Ref2VA HTTP {e.response.status_code}: {body}",
                meta=append_logs(logs_meta, "error", "submit",
                                 f"HTTP {e.response.status_code}: {body}",
                                 {"endpoint": "/v1/ref2video",
                                  "status_code": e.response.status_code, "response": body}),
            )
        except Exception as e:
            logger.error(f"[H3Ref2VA] image_to_video error: {e}", exc_info=True)
            return GenResult(
                success=False,
                error=f"H3 Ref2VA 错误: {e}",
                meta=append_logs(logs_meta, "error", "submit", f"提交异常: {e}"),
            )

    async def poll_result(self, remote_task_id: str) -> GenResult:
        """查询单次任务状态(供后台轮询循环调用,每次只查一次)。

        - queued/encoding/denoising/decoding → poll_pending(带 progress/eta)
        - completed → 下载视频到本地,GenResult(success=True, urls=[本地URL])
        - failed    → GenResult(success=False, error=...)
        """
        if not self._available():
            return GenResult(success=False, error="H3 Ref2VA 自部署服务未配置")
        url = f"{self.base_url}/v1/tasks/{remote_task_id}"
        base_meta = {"adapter": "h3_ref2va", "model": self.model, "remote_task_id": remote_task_id}
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                resp = await client.get(url, headers=self._headers())
                resp.raise_for_status()
                data = resp.json()

            status = data.get("status", "")
            progress = data.get("progress")

            if status == "completed":
                # video 字段形如 "xxxx.mp4";video_url 为相对路径 /v1/videos/xxx.mp4
                remote_url = data.get("video_url") or (
                    f"/v1/videos/{data['video']}" if data.get("video") else "")
                if not remote_url:
                    return GenResult(
                        success=False,
                        error="H3 Ref2VA completed 但无视频地址",
                        meta=append_logs(base_meta, "error", "poll",
                                         "completed 但无视频地址", {"response": data}),
                    )
                local_url, dl_info = await self._download_content(remote_url)
                base_meta = append_logs(base_meta, "info", "poll",
                                        f"任务完成,视频已下载: {local_url}",
                                        {"remote_url": remote_url, "local_url": local_url,
                                         "response": {k: v for k, v in data.items() if k != "trace"},
                                         **dl_info})
                return GenResult(
                    success=True,
                    urls=[local_url],
                    duration=data.get("duration"),
                    meta=base_meta,
                )

            if status == "failed":
                err = (data.get("error") or status or "")[:500]
                return GenResult(
                    success=False,
                    error=f"H3 Ref2VA 任务失败: {err}",
                    meta=append_logs(base_meta, "error", "poll", f"任务失败: {err}",
                                     {"response": {k: v for k, v in (data or {}).items()
                                                   if k != "trace"}}),
                )

            if status == "cancelled":
                return GenResult(
                    success=False,
                    error="H3 Ref2VA 任务已取消",
                    meta=append_logs(base_meta, "info", "poll", "远端任务已取消"),
                )

            # queued / encoding / denoising / decoding 等中间态
            meta = {**base_meta, "poll_pending": True, "status": status}
            if progress is not None:
                meta["progress"] = progress
            if data.get("eta_s") is not None:
                meta["eta_s"] = data.get("eta_s")
            return GenResult(success=True, meta=meta)

        except Exception as e:
            logger.warning(f"[H3Ref2VA] poll {remote_task_id} error: {e}")
            # 查询出错不直接判失败,让调用方继续重试
            return GenResult(
                success=True,
                meta=append_logs({**base_meta, "poll_pending": True},
                                 "warning", "poll", f"查询异常(将重试): {e}", {"request": url}),
            )

    async def _download_content(self, remote_url: str) -> Tuple[str, Dict[str, Any]]:
        """下载视频二进制到本地存储,返回 (本地 URL, 下载信息 dict)。"""
        full_url = remote_url if remote_url.startswith(("http://", "https://")) \
            else f"{self.base_url}{remote_url}"
        try:
            from app.services.storage import get_storage_singleton
            timeout = httpx.Timeout(15.0, read=180.0, write=15.0, pool=15.0)
            max_bytes = 300 * 1024 * 1024  # 300MB
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                async with client.stream("GET", full_url, headers=self._headers()) as resp:
                    resp.raise_for_status()
                    content_type = resp.headers.get("content-type", "video/mp4")
                    chunks = []
                    total = 0
                    async for chunk in resp.aiter_bytes():
                        total += len(chunk)
                        if total > max_bytes:
                            raise ValueError(f"video too large (> {max_bytes // (1024*1024)}MB)")
                        chunks.append(chunk)
                    data = b"".join(chunks)

            ct = content_type.lower().split(";")[0].strip()
            ext_map = {"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov"}
            ext = ext_map.get(ct, ".mp4")
            storage = get_storage_singleton()
            stored = await storage.save(
                data=data, filename=f"h3_ref2va{ext}", mime_type=ct or "video/mp4", category="video"
            )
            logger.info(f"[H3Ref2VA] video downloaded: {full_url} -> {stored.url} ({total} bytes)")
            return stored.url, {"bytes": total, "ok": True}
        except Exception as e:
            logger.warning(f"[H3Ref2VA] download failed, fallback to remote url: {full_url} ({e})")
            return full_url, {"ok": False, "fallback": True, "error": str(e)}

    async def cancel_task(self, remote_task_id: str) -> bool:
        """请求远端取消任务(尽力而为,失败不影响本地取消)。"""
        if not self._available():
            return False
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.base_url}/v1/tasks/{remote_task_id}/cancel",
                    headers=self._headers(),
                )
                ok = resp.status_code == 200
                logger.info(f"[H3Ref2VA] cancel {remote_task_id}: "
                            f"{resp.status_code} {resp.text[:120] if ok else resp.text[:200]}")
                return ok
        except Exception as e:
            logger.warning(f"[H3Ref2VA] cancel {remote_task_id} error: {e}")
            return False

    async def first_last_frame_video(self, inp: GenInput) -> GenResult:
        """首尾帧入口:ref2va 无首尾帧概念,首帧作为第 1 张参考图生成。"""
        return await self.image_to_video(inp)
