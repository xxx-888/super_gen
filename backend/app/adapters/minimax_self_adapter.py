"""
MiniMax-H3 自部署适配器（OpenAI 兼容 /v1 接口）

对接自部署的 MiniMax-H3-NF4 视频生成服务（OpenAI 风格网关）：
- 创建任务：POST /v1/videos           → 202 {id: "video_xxx", status, ...}
- 轮询任务：GET  /v1/videos/{job_id}  → {status: in_progress/completed/failed, progress, url, error}
- 下载视频：GET  /v1/videos/{job_id}/content （需要 Bearer 鉴权头）
- 模型列表：GET  /v1/models
- 鉴权：Authorization: Bearer {api_key}

与官方 MinimaxAdapter（走 api.minimaxi.com /v2）的关键差异：
- 本服务对外只接受纯文生视频 task="t2va"，不支持图片输入（Pydantic 校验锁死）。
- 请求体字段、响应字段（job_id 叫 id、完成态才有 url 相对路径）、下载方式都不同。
- 故单独成文，不复用 MinimaxAdapter。

关于分镜图的处理（image_mode 配置项）：
- "text"（默认）：忽略所有图片输入，只用 prompt 纯文生视频。
- "describe"：先把分镜图交给视觉 LLM 转成画面描述文字，再拼进 prompt 做文生视频。
  describe 失败会降级为纯 prompt，不阻断生成。

异步模式：image_to_video 只提交任务返回 remote_task_id（meta.async_poll=True），
由 creation_service._async_poll_adapter 后台循环调 poll_result 轮询。
"""
import asyncio
import logging
import os
from typing import Any, Dict, List, Optional

import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult, append_logs
from app.core.config import settings

logger = logging.getLogger(__name__)

# 服务端默认值（来自 OpenAPI: task const=t2va, fps const=24, n const=1）
_DEFAULT_MODEL = "DiffSynth-Studio/MiniMax-H3-NF4"

# 服务端限制：seconds 4-15
def _clamp_duration(d: Optional[float]) -> int:
    if d is None:
        return 5
    return max(4, min(15, int(d)))

# 自部署服务经实测固定只支持 832x480（16:9）一种尺寸，
# 传任何其他像素尺寸（含 480x832/640x640/1792x768）都会被服务端 422 拒绝。
# 因此无论用户选什么比例，提交时都统一用 832x480（静默降级到 16:9）。
# 唯一支持的固定尺寸常量：
_FORCED_SIZE = "832x480"
_FORCED_RATIO = "16:9"


async def _local_url_to_data_uri(url: str) -> str:
    """把本地 /uploads/... 图片转成 base64 data URI（供视觉 LLM 读取）。

    与 minimax_adapter 里的实现保持一致：公网 URL 原样返回，本地路径读文件转 base64。
    """
    import base64
    if not url:
        return url
    if url.startswith(("http://", "https://")) and "/uploads/" not in url:
        return url
    try:
        storage_path = getattr(settings, "STORAGE_LOCAL_PATH", None)
        if not storage_path:
            return url
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
        import aiofiles
        async with aiofiles.open(abs_path, "rb") as f:
            data = await f.read()
        ext = os.path.splitext(abs_path)[1].lower()
        mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif"}
        mime = mime_map.get(ext, "image/jpeg")
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except Exception as e:
        logger.warning(f"Failed to convert local image to base64 ({url}): {e}")
        return url


class MinimaxSelfAdapter(BaseAdapter):
    """自部署 MiniMax-H3 NF4 视频适配器（OpenAI 兼容 /v1 接口，仅文生视频）。"""

    SUPPORTS = {
        "text_to_image": False,
        "image_to_image": False,
        "fusion_generate": False,
        "image_to_video": True,       # 系统内视频生成统一入口
        "first_last_frame": True,     # 声明支持，内部降级为文生（服务不接受图片）
        "lip_sync": False,
        "tts": False,
        "image_edit": False,
    }

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        super().__init__(model_config)
        cfg = self.config or {}
        self.api_key = cfg.get("api_key") or getattr(settings, "MINIMAX_SELF_API_KEY", None)
        base = cfg.get("endpoint") or cfg.get("base_url") or ""
        # 容错：剥掉用户可能误填的完整 API 路径，只保留 origin
        base = (base or "").rstrip("/")
        for suffix in ("/v1/videos", "/v1"):
            if base.endswith(suffix):
                base = base[:-len(suffix)]
                break
        self.base_url = base.rstrip("/")
        cfg_inner = cfg.get("config", {}) if isinstance(cfg.get("config"), dict) else {}
        self.model = cfg_inner.get("model") or cfg.get("model") or _DEFAULT_MODEL
        # 分镜图处理模式：
        #   reference（默认，推荐）= 参考图融合生成 ref2va（上传图→带参考图生成）
        #   first_frame = 首帧驱动 fl2va（首帧图→视频）
        #   describe = 图转文（先视觉描述再文生，旧降级方案）
        #   text = 纯文生（忽略所有图片）
        # 注：旧记录可能存了 image_mode="text"。为避免「引用了资源却走文生」，
        # 当 image_mode 未显式配置时默认 reference；text 是用户明确要求的纯文生。
        self.image_mode = cfg_inner.get("image_mode") or "reference"
        # 轮询参数：默认 15 分钟（自部署视频生成耗时较长，部分视频需要等较久）。
        # poll_interval 由上层 _async_poll_adapter 控制（默认 5 秒），这里仅给参考值。
        self.poll_interval = int(cfg_inner.get("poll_interval", 5))
        self.max_poll_seconds = int(cfg_inner.get("max_poll_seconds", 900))
        # 图转文模式用的 LLM 配置覆盖（可选 dict: {model/endpoint/api_key}）
        self.describe_model_config = cfg_inner.get("describe_model") or {}

    def _available(self) -> bool:
        return bool(self.api_key and self.base_url)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def test_connection(self) -> bool:
        """探活：GET /health 返回 200 即认为服务可达。不消耗视频额度。

        status 可以是 ok（正常）或 degraded（负载高但可用），都算连接成功。
        """
        if not self._available():
            return False
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(f"{self.base_url}/health", headers=self._headers())
                if resp.status_code != 200:
                    return False
                data = resp.json()
                # ok=正常，degraded=高负载但可用，都说明服务可达
                return data.get("status") in ("ok", "degraded")
        except Exception as e:
            logger.warning(f"MinimaxSelf test_connection error: {e}")
            return False

    async def _describe_image(self, image_url: str, db=None) -> Optional[str]:
        """图转文：用视觉 LLM 把图片转成画面描述文字。

        使用系统已配置的 LLM（AIModel type=llm 或 settings.LLM_*），
        或 describe_model_config 指定的覆盖配置。失败返回 None（调用方降级）。
        """
        try:
            from app.services.llm_client import LLMClient, LLMMessage
            # 构造 LLM 客户端：优先用适配器配置里指定的 describe_model
            client = None
            if self.describe_model_config and self.describe_model_config.get("api_key"):
                base = self.describe_model_config.get("endpoint") or self.describe_model_config.get("base_url") or ""
                for suffix in ("/chat/completions",):
                    if base.endswith(suffix):
                        base = base[:-len(suffix)]
                        break
                client = LLMClient(
                    api_key=self.describe_model_config["api_key"],
                    base_url=base,
                    model=self.describe_model_config.get("model") or "glm-4v-flash",
                )
            else:
                client = await LLMClient.from_config(db)
            if not client.available:
                logger.warning("[MinimaxSelf] describe 模式但 LLM 未配置，降级为纯 prompt")
                return None

            data_uri = await _local_url_to_data_uri(image_url)
            messages = [
                LLMMessage({
                    "role": "system",
                    "content": "你是一个专业的画面描述助手。请用一段连贯的文字详细描述这张图片的画面内容，"
                               "包括人物外观、动作、表情、服装、场景、环境、光影、色调、构图和视觉风格，"
                               "以便用于文生视频。只输出描述文字，不要分点、不要解释、不要前后缀。",
                }),
                LLMMessage({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请描述这张图片。"},
                        {"type": "image_url", "image_url": {"url": data_uri}},
                    ],
                }),
            ]
            resp = await client.chat(messages, temperature=0.5, max_tokens=512)
            desc = (resp.content or "").strip()
            logger.info(f"[MinimaxSelf] image described ({len(desc)} chars): {desc[:80]}...")
            return desc or None
        except Exception as e:
            logger.warning(f"[MinimaxSelf] describe_image failed, fallback to text-only: {e}")
            return None

    def _resolve_size(self, inp: GenInput) -> tuple:
        """决定提交给服务的像素尺寸。

        自部署服务经实测固定只接受 832x480（16:9），任何其他尺寸都会被 422 拒绝。
        所以无论用户选什么比例，这里都统一返回 832x480（静默降级）。
        返回 (size, requested_ratio) 元组，requested_ratio 用于日志/结果标注。
        """
        ratio = inp.extra.get("ratio") or inp.size or "16:9"
        if ratio != _FORCED_RATIO:
            logger.info(
                f"[MinimaxSelf] ratio '{ratio}' requested but service only supports "
                f"{_FORCED_SIZE}({_FORCED_RATIO}), silently downgrading"
            )
        return _FORCED_SIZE, ratio

    async def _upload_file(self, image_url: str, client: httpx.AsyncClient) -> str:
        """把一张图片上传到自部署服务，返回 file_id（供 ref2va/fl2va 使用）。

        支持两种来源：
        - 本地 /uploads/... 路径：读文件二进制上传
        - 公网 URL（http/https）：用同一个 client 下载后上传

        服务端要求：POST /v1/files (multipart)，purpose 必须是 "video"，
        图片尺寸有最小限制（实测 512x512 正常，16x16 会被拒）。
        返回 file_id（如 "file_xxx"）。失败抛异常，由调用方决定是否降级。
        """
        # 1. 拿到图片二进制 + 文件名 + mime
        if image_url.startswith(("http://", "https://")) and "/uploads/" not in image_url:
            # 公网 URL → 下载
            dl = await client.get(image_url)
            dl.raise_for_status()
            img_bytes = dl.content
            ct = dl.headers.get("content-type", "image/jpeg")
            ext_map = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
            ext = ext_map.get(ct.split(";")[0].strip().lower(), ".jpg")
            filename = f"ref{ext}"
            mime = ct
        else:
            # 本地 /uploads/ → 读文件
            storage_path = getattr(settings, "STORAGE_LOCAL_PATH", None)
            if not storage_path:
                raise ValueError(f"无本地存储配置，无法读取图片: {image_url}")
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
                img_bytes = f.read()
            ext = os.path.splitext(abs_path)[1].lower() or ".jpg"
            mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                        ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif"}
            mime = mime_map.get(ext, "image/jpeg")
            filename = os.path.basename(abs_path) or f"ref{ext}"

        # 2. 上传到服务（multipart/form-data，purpose=video）
        resp = await client.post(
            f"{self.base_url}/v1/files",
            headers={"Authorization": f"Bearer {self.api_key}"},
            files={"file": (filename, img_bytes, mime)},
            data={"purpose": "video"},
        )
        resp.raise_for_status()
        file_id = resp.json().get("id")
        if not file_id:
            raise ValueError(f"上传响应无 file_id: {resp.text[:200]}")
        logger.info(f"[MinimaxSelf] uploaded {image_url} -> {file_id} ({len(img_bytes)} bytes)")
        return file_id

    async def image_to_video(self, inp: GenInput) -> GenResult:
        """提交文生视频任务，返回 remote_task_id（不阻塞轮询）。"""
        if not self._available():
            return GenResult(success=False, error="MiniMax 自部署服务未配置 api_key/endpoint")

        # 构造 prompt
        prompt = (inp.prompt or inp.extra.get("minimax_prompt") or "").strip()
        if not prompt:
            prompt = "让画面动起来"

        # 收集所有可用的参考图 URL（去重，保持顺序）
        # 来源：first_frame_url / image_url / elements 里的 image_url
        ref_urls: List[str] = []
        for u in [inp.first_frame_url, inp.image_url]:
            if u and u not in ref_urls:
                ref_urls.append(u)
        for el in (inp.elements or []):
            if el.image_url and el.image_url not in ref_urls:
                ref_urls.append(el.image_url)

        # 日志基线
        logs_meta: Dict[str, Any] = {"logs": []}

        # describe 模式：图转文（旧降级方案，不依赖服务端图片能力）
        if self.image_mode == "describe" and ref_urls:
            db = inp.extra.get("_db")
            desc = await self._describe_image(ref_urls[0], db=db)
            if desc:
                prompt = f"画面：{desc}。{prompt}"
                logs_meta = append_logs(logs_meta, "info", "describe",
                                        f"图转文成功，描述已拼入 prompt（{len(desc)} 字）")
            else:
                logs_meta = append_logs(logs_meta, "warning", "describe",
                                        "图转文失败，降级为纯文字 prompt")

        try:
            size, requested_ratio = self._resolve_size(inp)
            seconds = _clamp_duration(inp.duration)
            payload: Dict[str, Any] = {
                "prompt": prompt[:16000],
                "model": self.model,
                "size": size,
                "seconds": seconds,
                "generate_sound": True,
            }
            if inp.extra.get("seed") is not None:
                try:
                    payload["seed"] = int(inp.extra["seed"])
                except (TypeError, ValueError):
                    pass

            # 决定 task 模式 + 上传图片（如有）
            # 优先级（用户意图优先于后台配置）：
            # 1. first_frame 模式 + 有图 → fl2va（首帧/尾帧驱动）
            # 2. 有参考图（用户在分镜 @引用了角色/场景资源）→ ref2va（融合生成）
            #    这是用户明确意图：引用了资源就应参与生成，不受 image_mode 旧配置影响。
            # 3. describe 模式 → 已图转文处理，走 t2va
            # 4. text 模式 或 无图 → t2va（纯文生）
            # 注：旧的 image_mode="text" 配置只在「无参考图」时生效；有参考图时强制走 ref2va，
            #     避免「引用了资源却走文生」的问题。
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
                task_mode = "t2va"
                if self.image_mode == "first_frame" and ref_urls:
                    try:
                        first_id = await self._upload_file(ref_urls[0], client)
                        payload["task"] = "fl2va"
                        payload["first_frame_file_id"] = first_id
                        # 尾帧（如有第二张图）
                        if len(ref_urls) >= 2:
                            last_id = await self._upload_file(ref_urls[1], client)
                            payload["last_frame_file_id"] = last_id
                        task_mode = "fl2va"
                        logs_meta = append_logs(logs_meta, "info", "upload",
                                                f"已上传首{'/尾' if 'last_frame_file_id' in payload else ''}帧图",
                                                {"first_frame_file_id": first_id,
                                                 **({"last_frame_file_id": payload["last_frame_file_id"]}
                                                if "last_frame_file_id" in payload else {})})
                    except Exception as ue:
                        logger.warning(f"[MinimaxSelf] fl2va 上传失败，降级为 t2va: {ue}")
                        logs_meta = append_logs(logs_meta, "warning", "upload",
                                                f"首帧图上传失败，降级为纯文生: {ue}")
                        payload["task"] = "t2va"
                elif ref_urls and self.image_mode != "describe":
                    # 有参考图（用户 @引用了角色/场景/道具资源）→ ref2va 融合生成。
                    # 无论 image_mode 是 reference 还是旧的 text，只要有参考图就走 ref2va
                    # （用户引用资源是明确意图，不应被可能过时的 text 配置忽略）。
                    # describe 模式除外（已图转文处理，走 t2va）。
                    try:
                        file_ids = []
                        for u in ref_urls[:9]:  # 最多 9 张参考图
                            fid = await self._upload_file(u, client)
                            file_ids.append(fid)
                        payload["task"] = "ref2va"
                        payload["references"] = [{"type": "image", "file_id": fid} for fid in file_ids]
                        task_mode = "ref2va"
                        logs_meta = append_logs(logs_meta, "info", "upload",
                                                f"已上传 {len(file_ids)} 张参考图（ref2va 融合生成）",
                                                {"file_ids": file_ids, "sources": ref_urls[:len(file_ids)]})
                    except Exception as ue:
                        logger.warning(f"[MinimaxSelf] ref2va 上传失败，降级为 t2va: {ue}")
                        logs_meta = append_logs(logs_meta, "warning", "upload",
                                                f"参考图上传失败，降级为纯文生: {ue}")
                        payload["task"] = "t2va"
                else:
                    payload["task"] = "t2va"

                # 提交视频生成任务
                resp = await client.post(
                    f"{self.base_url}/v1/videos",
                    json=payload, headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()

            job_id = data.get("id")
            if not job_id:
                err = data.get("error") or data.get("detail") or str(data)[:300]
                if isinstance(err, dict):
                    err = err.get("message") or str(err)
                return GenResult(
                    success=False,
                    error=f"MiniMax 自部署创建失败: {err}",
                    meta=append_logs(logs_meta, "error", "submit",
                                     f"创建任务失败: {err}",
                                     {"endpoint": "/v1/videos", "request": payload, "response": data}),
                )

            logger.info(f"[MinimaxSelf] task submitted: {job_id} (task={task_mode}, model={self.model}, size={size}, requested_ratio={requested_ratio}, seconds={seconds})")
            logs_meta = append_logs(logs_meta, "info", "submit",
                                    f"任务已提交（{task_mode}），等待异步生成: {job_id}",
                                    {"job_id": job_id, "task": task_mode, "model": self.model, "size": size,
                                     "requested_ratio": requested_ratio, "seconds": seconds,
                                     "request": payload, "response": data})
            return GenResult(
                success=True,
                meta={
                    **logs_meta,
                    "adapter": "minimax_self",
                    "model": self.model,
                    "remote_task_id": job_id,
                    "async_poll": True,
                    "task": task_mode,
                    "requested_ratio": requested_ratio,
                    "actual_size": size,
                },
            )
        except httpx.HTTPStatusError as e:
            body = e.response.text[:300] if e.response else ""
            return GenResult(
                success=False,
                error=f"MiniMax 自部署 HTTP {e.response.status_code}: {body}",
                meta=append_logs(logs_meta, "error", "submit",
                                 f"HTTP {e.response.status_code}: {body}",
                                 {"endpoint": "/v1/videos", "status_code": e.response.status_code,
                                  "request": payload, "response": body}),
            )
        except Exception as e:
            logger.error(f"[MinimaxSelf] image_to_video error: {e}", exc_info=True)
            return GenResult(
                success=False,
                error=f"MiniMax 自部署错误: {e}",
                meta=append_logs(logs_meta, "error", "submit", f"提交异常: {e}"),
            )

    async def poll_result(self, remote_task_id: str) -> GenResult:
        """查询单次任务状态（供后台轮询循环调用，每次只查一次）。

        - in_progress → GenResult(success=True, meta={"poll_pending": True, "progress": N})
        - completed   → 下载视频到本地，GenResult(success=True, urls=[本地URL])
        - failed      → GenResult(success=False, error=...)
        """
        if not self._available():
            return GenResult(success=False, error="MiniMax 自部署服务未配置")
        url = f"{self.base_url}/v1/videos/{remote_task_id}"
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                resp = await client.get(url, headers=self._headers())
                resp.raise_for_status()
                data = resp.json()

            status = data.get("status", "")
            progress = data.get("progress")

            if status == "completed":
                remote_url = data.get("url") or ""
                if not remote_url:
                    return GenResult(
                        success=False,
                        error="MiniMax 自部署 completed 但无 url 字段",
                        meta=append_logs({"adapter": "minimax_self", "remote_task_id": remote_task_id},
                                         "error", "poll", "completed 但无 url 字段",
                                         {"request": url, "response": data}),
                    )
                # url 是相对路径 /v1/videos/{id}/content，需带鉴权头下载到本地
                local_url, dl_info = await self._download_content(remote_url)
                seconds = data.get("seconds")
                try:
                    dur = float(seconds) if seconds is not None else None
                except (TypeError, ValueError):
                    dur = None
                base_meta = {
                    "adapter": "minimax_self",
                    "model": self.model,
                    "remote_task_id": remote_task_id,
                    "remote_url": remote_url,
                    "size": data.get("size"),
                    "progress": progress,
                }
                base_meta = append_logs(base_meta, "info", "poll",
                                        f"任务完成，视频已下载: {local_url}",
                                        {"remote_url": remote_url, "local_url": local_url, "size": data.get("size"),
                                         "request": url, "response": data, **dl_info})
                return GenResult(success=True, urls=[local_url], duration=dur, meta=base_meta)

            if status == "failed":
                err = data.get("error")
                if isinstance(err, dict):
                    err = err.get("message") or str(err)
                return GenResult(
                    success=False,
                    error=f"MiniMax 自部署任务失败: {err or status}",
                    meta=append_logs({"adapter": "minimax_self", "remote_task_id": remote_task_id},
                                     "error", "poll", f"任务失败: {err or status}",
                                     {"request": url, "response": data}),
                )

            # in_progress / 其他中间态
            return GenResult(
                success=True,
                meta={"poll_pending": True, "status": status, "progress": progress},
            )

        except Exception as e:
            logger.warning(f"[MinimaxSelf] poll {remote_task_id} error: {e}")
            # 查询出错不直接判失败，让调用方继续重试
            return GenResult(
                success=True,
                meta=append_logs({"poll_pending": True, "remote_task_id": remote_task_id},
                                 "warning", "poll", f"查询异常（将重试）: {e}",
                                 {"request": url}),
            )

    async def _download_content(self, remote_url: str) -> tuple:
        """下载视频二进制到本地存储，返回 (本地 URL, 下载信息 dict)。

        remote_url 是相对路径（如 /v1/videos/xxx/content），需拼接 base_url 并带 Bearer 头。
        失败时降级返回完整远端 URL（需鉴权才能访问，但比丢弃结果好）。
        返回的 info dict 含 bytes/ok 等字段，供调用方写日志。
        """
        full_url = remote_url if remote_url.startswith(("http://", "https://")) else f"{self.base_url}{remote_url}"
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

            # 推断扩展名
            ct = content_type.lower().split(";")[0].strip()
            ext_map = {"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov"}
            ext = ext_map.get(ct, ".mp4")
            storage = get_storage_singleton()
            stored = await storage.save(
                data=data, filename=f"minimax_self{ext}", mime_type=ct or "video/mp4", category="video"
            )
            logger.info(f"[MinimaxSelf] video downloaded: {full_url} -> {stored.url} ({total} bytes)")
            return stored.url, {"bytes": total, "ok": True}
        except Exception as e:
            logger.warning(f"[MinimaxSelf] download failed, fallback to remote url: {full_url} ({e})")
            return full_url, {"ok": False, "fallback": True, "error": str(e)}

    async def first_last_frame_video(self, inp: GenInput) -> GenResult:
        """首尾帧入口：自部署服务不支持图片，统一降级为文生视频。

        若配置了 describe 模式，首帧图会被转成画面描述参与生成；text 模式下图片被忽略。
        """
        return await self.image_to_video(inp)
