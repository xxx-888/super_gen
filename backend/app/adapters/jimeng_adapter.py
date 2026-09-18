"""即梦AI (Jimeng / Seedance) 视频生成适配器.

官方 OpenAPI（v1.1，2026-08-07）：
- 异步任务：POST {BASE_URL}/ai-open-platform-api/v1/lz/video/task/create 建任务，
  POST .../task/status 轮询；建议轮询间隔 ≥5s
- 鉴权：Header `ApiKey: <key>`（注意不是 Bearer）
- 响应统一包装：HTTP 200 + code==0 才算成功；HTTP 非 200 走 {code,reason,message}
  系统错误体；余额不足返回 HTTP 429（message 含 40001）
- 模型档位 mode：fast / pro / mini / seedance2.5（即梦 Seedance 2.5，30s/30图/10视频/
  10音频，仅 480p/720p）；档位从后台 config.model 读（如 "seedance2.5"、"pro"），
  未配置默认 fast
- 输入：prompt（无 images/videos 时必填）+ images(videos/audios)[{url, role}]；
  role: first_frame/last_frame/reference_image/reference_video/reference_audio；
  仅接受公网 HttpURL 或 asset://<id>，不支持 data URI —— 本地 /uploads 素材用
  settings.PUBLIC_BASE_URL 拼成绝对地址，未配置则跳过并记警告
- Seedance 2.5 约束（适配器内已前置处理）：
  · 首帧/首尾帧任务仅支持 ratio=adaptive（创建时会被官方同步拒绝）→ 自动纠正
  · 视频编辑/延长任务也应 adaptive + duration=-1（官方模型侧判定，无法前置，
    提交前请在提示词/参数侧自查）
- 状态机：pending/submitted/running → succeeded(返回 video_url)/failed(error)；
  终态不再变化；不支持取消
- 超分 super_resolution_config：链式内部任务，对外仍是一个 task_id，整链失败
  不扣费 —— 参数从 GenInput.extra 透传，由官方网关校验

计费：平台侧为预扣积分制（提交前按计价规则扣、失败退还），官方 usage tokens
仅记入任务日志，不做 tokens→积分换算。
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult, append_logs
from app.core.config import settings

logger = logging.getLogger(__name__)

_CREATE_PATH = "/ai-open-platform-api/v1/lz/video/task/create"
_STATUS_PATH = "/ai-open-platform-api/v1/lz/video/task/status"

# 分档参数矩阵（官方 v1.1）：分辨率 / 时长区间 / 参考素材上限
_MODE_MATRIX: Dict[str, Dict[str, Any]] = {
    "pro":         {"resolutions": {"480p", "720p", "1080p", "4k"}, "duration": (4, 15), "images": 9,  "videos": 3,  "audios": 3},
    "fast":        {"resolutions": {"480p", "720p", "1080p"},       "duration": (4, 15), "images": 9,  "videos": 3,  "audios": 3},
    "mini":        {"resolutions": {"480p", "720p", "1080p"},       "duration": (4, 15), "images": 9,  "videos": 3,  "audios": 3},
    "seedance2.5": {"resolutions": {"480p", "720p"},                "duration": (4, 30), "images": 30, "videos": 10, "audios": 10},
}

# 模型名别名 → 官方 mode（后台 config.model 可能填各种写法）
_MODE_ALIASES: Dict[str, str] = {
    "seedance2.5": "seedance2.5", "seedance2": "seedance2.5", "seedance": "seedance2.5",
    "sd2.5": "seedance2.5", "sd2": "seedance2.5", "即梦2.5": "seedance2.5", "即梦": "fast",
}

_RATIOS = {"16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"}

# 平台侧分辨率写法 → 即梦写法（平台历史用 768P/2K 等大小写混合）
_RESOLUTION_MAP = {
    "480p": "480p", "480P": "480p",
    "720p": "720p", "720P": "720p", "768p": "720p", "768P": "720p",
    "1080p": "1080p", "1080P": "1080p", "2k": "1080p", "2K": "1080p",
    "4k": "4k", "4K": "4k",
}


class JimengAdapter(BaseAdapter):
    """即梦AI 视频生成适配器（文生 / 图生(首尾帧/参考) / 多模态参考）。"""

    ADAPTER_NAME = "jimeng"
    DEFAULT_BASE_URL = ""  # 官方 Base URL 经其管理后台下发，必须配置 endpoint

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
        self.api_key = cfg.get("api_key") or getattr(settings, "JIMENG_API_KEY", None)
        base = cfg.get("endpoint") or cfg.get("base_url") or self.DEFAULT_BASE_URL
        # 容错：用户可能把完整接口路径粘进 endpoint，剥离已知后缀只留 base
        base = (base or "").rstrip("/")
        for suffix in (_CREATE_PATH, _STATUS_PATH, "/ai-open-platform-api"):
            if base.endswith(suffix):
                base = base[:-len(suffix)]
                break
        self.base_url = base.rstrip("/")
        cfg_inner = cfg.get("config", {}) if isinstance(cfg.get("config"), dict) else {}
        # 档位（mode）：config.model 即官方档位名，兼容别名；未识别回退 fast
        self.mode = self._normalize_mode(cfg_inner.get("model") or cfg.get("model"))
        # 轮询参数（官方建议间隔 ≥5s；含超分的整链耗时更长，默认上限放宽到 30 分钟）
        self.max_poll_seconds = int(cfg_inner.get("max_poll_seconds", 1800))
        self.poll_interval = int(cfg_inner.get("poll_interval", 5))
        self.default_resolution = _RESOLUTION_MAP.get(cfg_inner.get("resolution", ""), cfg_inner.get("resolution")) or "720p"
        self.default_ratio = cfg_inner.get("ratio") or "16:9"
        self.generate_audio = bool(cfg_inner.get("generate_audio", True))
        self.watermark = bool(cfg_inner.get("watermark", False))

    # ==================== 工具 ====================

    def _available(self) -> bool:
        # 官方 Base URL 需从其管理后台获取，endpoint 与 key 缺一不可
        return bool(self.api_key and self.base_url)

    def _headers(self) -> Dict[str, str]:
        return {"ApiKey": self.api_key, "Content-Type": "application/json"}

    @staticmethod
    def _normalize_mode(raw: Any) -> str:
        """把后台填写的模型名归一为官方 mode（fast/pro/mini/seedance2.5）。"""
        if not raw:
            return "fast"
        s = str(raw).strip()
        low = s.lower()
        if low in _MODE_MATRIX:
            return low
        if s in _MODE_ALIASES:
            return _MODE_ALIASES[s]
        if low in _MODE_ALIASES:
            return _MODE_ALIASES[low]
        return "fast"

    def _absolutize(self, url: Optional[str], kind: str) -> Tuple[Optional[str], Optional[str]]:
        """即梦只收公网 HttpURL / asset://，把本地 /uploads 拼成绝对地址。

        返回 (绝对地址或 None, 跳过原因)。data URI 不支持（与 MiniMax 不同）。
        """
        if not url:
            return None, None
        if url.startswith(("http://", "https://", "asset://")):
            return url, None
        if url.startswith("/uploads/"):
            public_base = (getattr(settings, "PUBLIC_BASE_URL", None) or "").rstrip("/")
            if not public_base:
                return None, f"本地素材 {url} 需要公网可访问：请在服务端配置 PUBLIC_BASE_URL 后重试（即梦不支持内网/相对地址）"
            return f"{public_base}{url}", None
        if url.startswith("data:"):
            return None, f"{kind} 为 data URI，即梦接口不支持，已跳过（仅接受公网 URL / asset://）"
        return None, f"{kind} 地址格式无法识别，已跳过: {str(url)[:80]}"

    # ==================== 能力实现 ====================

    async def test_connection(self) -> bool:
        """假 task_id 打查询端点：401/403=密钥错，其余（含业务错误）说明通过网关鉴权。"""
        if not self.api_key or not self.base_url:
            return False
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{self.base_url}{_STATUS_PATH}",
                    json={"task_id": "test_connection_probe"},
                    headers=self._headers(),
                )
                return resp.status_code not in (401, 403)
        except Exception as e:
            logger.warning(f"Jimeng test_connection error: {e}")
            return False

    async def image_to_video(self, inp: GenInput) -> GenResult:
        """提交即梦视频任务，返回 remote_task_id（异步，不阻塞轮询）。"""
        if not self._available():
            missing = "api_key" if not self.api_key else "endpoint（即梦 Base URL，从其管理后台获取）"
            return GenResult(success=False, error=f"即梦AI 未配置 {missing}")

        logs_meta: Dict[str, Any] = {"logs": []}
        try:
            matrix = _MODE_MATRIX[self.mode]
            prompt = (inp.prompt or "").strip()

            # ---- 组装参考素材（first/last frame 显式优先） ----
            images: List[Dict[str, str]] = []
            videos: List[Dict[str, str]] = []
            audios: List[Dict[str, str]] = []
            has_frames = False
            if inp.first_frame_url:
                u, why = self._absolutize(inp.first_frame_url, "首帧图片")
                if u: images.append({"url": u, "role": "first_frame"}); has_frames = True
                elif why: logs_meta = append_logs(logs_meta, "warning", "submit", why)
            if inp.last_frame_url:
                u, why = self._absolutize(inp.last_frame_url, "尾帧图片")
                if u: images.append({"url": u, "role": "last_frame"}); has_frames = True
                elif why: logs_meta = append_logs(logs_meta, "warning", "submit", why)

            for el in inp.elements:
                if el.image_url:
                    u, why = self._absolutize(el.image_url, f"参考图[{el.name}]")
                    if u: images.append({"url": u, "role": "reference_image"})
                    elif why: logs_meta = append_logs(logs_meta, "warning", "submit", why)
                if el.video_url:
                    u, why = self._absolutize(el.video_url, f"参考视频[{el.name}]")
                    if u: videos.append({"url": u, "role": "reference_video"})
                    elif why: logs_meta = append_logs(logs_meta, "warning", "submit", why)
                if el.audio_url:
                    u, why = self._absolutize(el.audio_url, f"参考音频[{el.name}]")
                    if u: audios.append({"url": u, "role": "reference_audio"})
                    elif why: logs_meta = append_logs(logs_meta, "warning", "submit", why)

            # 平台 image_url：无参考素材时按官方"首帧驱动"标准图生视频；
            # 与 @引用素材同场时并入参考图（多模态参考）
            if inp.image_url and not has_frames:
                u, why = self._absolutize(inp.image_url, "输入图片")
                if u:
                    images.append({"url": u, "role": "reference_image" if inp.elements else "first_frame"})
                elif why:
                    logs_meta = append_logs(logs_meta, "warning", "submit", why)
            if inp.video_url:
                u, why = self._absolutize(inp.video_url, "输入视频")
                if u: videos.append({"url": u, "role": "reference_video"})
                elif why: logs_meta = append_logs(logs_meta, "warning", "submit", why)
            if inp.audio_url:
                u, why = self._absolutize(inp.audio_url, "输入音频")
                if u: audios.append({"url": u, "role": "reference_audio"})
                elif why: logs_meta = append_logs(logs_meta, "warning", "submit", why)

            # ---- 官方硬性规则：images、videos 都没有时 prompt 必填（纯音频参考也不例外） ----
            if not images and not videos and not prompt:
                return GenResult(
                    success=False, error="即梦AI：未提供图片/视频参考，prompt 为必填项（文生视频）",
                    meta=append_logs(logs_meta, "error", "submit", "缺少 prompt（文生视频必填）"),
                )

            # ---- 分档上限截断（超限素材丢弃并警告，不阻断任务） ----
            if len(images) > matrix["images"]:
                logs_meta = append_logs(logs_meta, "warning", "submit",
                                        f"参考图 {len(images)} 张超出 {self.mode} 档上限 {matrix['images']}，已截断")
                images = images[:matrix["images"]]
            if len(videos) > matrix["videos"]:
                logs_meta = append_logs(logs_meta, "warning", "submit",
                                        f"参考视频 {len(videos)} 个超出 {self.mode} 档上限 {matrix['videos']}，已截断")
                videos = videos[:matrix["videos"]]
            if len(audios) > matrix["audios"]:
                logs_meta = append_logs(logs_meta, "warning", "submit",
                                        f"参考音频 {len(audios)} 段超出 {self.mode} 档上限 {matrix['audios']}，已截断")
                audios = audios[:matrix["audios"]]

            # ---- 分辨率：平台写法映射 + 档位校验（seedance2.5 自动降到 720p） ----
            raw_res = inp.extra.get("resolution") or self.default_resolution
            resolution = _RESOLUTION_MAP.get(raw_res, str(raw_res).lower())
            if resolution not in matrix["resolutions"]:
                if self.mode == "seedance2.5":
                    logs_meta = append_logs(logs_meta, "warning", "submit",
                                            f"seedance2.5 仅支持 480p/720p，已将 {resolution} 自动降为 720p")
                    resolution = "720p"
                else:
                    return GenResult(
                        success=False,
                        error=f"即梦AI：分辨率 {resolution} 不被 {self.mode} 档支持（可用: {', '.join(sorted(matrix['resolutions']))}）",
                        meta=append_logs(logs_meta, "error", "submit", f"非法分辨率 {resolution} for {self.mode}"),
                    )

            # ---- 宽高比：白名单校验 + seedance2.5 首尾帧强制 adaptive（官方创建时会同步拒绝） ----
            ratio = str(inp.extra.get("ratio") or inp.size or self.default_ratio)
            if ratio not in _RATIOS:
                logs_meta = append_logs(logs_meta, "warning", "submit",
                                        f"ratio={ratio} 不在即梦支持列表，回退 16:9")
                ratio = "16:9"
            if self.mode == "seedance2.5" and has_frames and ratio != "adaptive":
                logs_meta = append_logs(logs_meta, "warning", "submit",
                                        "seedance2.5 首帧/首尾帧任务仅支持 ratio=adaptive（官方约束），已自动纠正")
                ratio = "adaptive"

            # ---- 时长：-1 智能时长；区间外按档位夹紧并警告 ----
            duration = inp.duration if inp.duration is not None else 5
            try:
                duration = int(duration)
            except (TypeError, ValueError):
                duration = 5
            if duration != -1:
                lo, hi = matrix["duration"]
                if duration < lo or duration > hi:
                    logs_meta = append_logs(logs_meta, "warning", "submit",
                                            f"时长 {duration}s 超出 {self.mode} 档范围 [{lo},{hi}]，已夹紧为 {min(max(duration, lo), hi)}s")
                    duration = min(max(duration, lo), hi)

            # ---- 组 payload ----
            payload: Dict[str, Any] = {
                "prompt": prompt,
                "mode": self.mode,
                "resolution": resolution,
                "ratio": ratio,
                "duration": duration,
                "generate_audio": bool(inp.extra.get("generate_audio", self.generate_audio)),
                "watermark": bool(inp.extra.get("watermark_enabled", self.watermark)),
            }
            if images: payload["images"] = images
            if videos: payload["videos"] = videos
            if audios: payload["audios"] = audios
            if inp.extra.get("seed") is not None:
                payload["seed"] = inp.extra["seed"]
            if inp.extra.get("return_last_frame") or (self.config.get("config") or {}).get("return_last_frame"):
                payload["return_last_frame"] = True
            # 以下高级参数由调用方透传，官方网关负责校验（错误原样带回任务日志）
            for k in ("tools", "super_resolution_config", "ips", "bitrate_mode", "execution_expires_after"):
                if inp.extra.get(k) is not None:
                    payload[k] = inp.extra[k]

            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{self.base_url}{_CREATE_PATH}", json=payload, headers=self._headers(),
                )
                body: Dict[str, Any] = {}
                try:
                    body = resp.json()
                except Exception:
                    pass
                if resp.status_code != 200 or body.get("code") not in (0, None):
                    # 余额不足：官方约定 HTTP 429 + message 含 40001
                    err = str(body.get("message") or body.get("reason") or resp.text)[:300]
                    if resp.status_code == 429 or "40001" in err:
                        err = f"即梦AI 账户余额不足（HTTP 429/40001）：{err}"
                    return GenResult(
                        success=False, error=f"即梦AI 创建任务失败: {err}",
                        meta=append_logs(logs_meta, "error", "submit", f"创建失败: {err}",
                                         {"http_status": resp.status_code, "request": payload,
                                          "response": body, "trace_id": body.get("trace_id")}),
                    )

            task_id = (body.get("data") or {}).get("task_id")
            if not task_id:
                return GenResult(
                    success=False, error=f"即梦AI 创建任务失败: 响应缺少 task_id",
                    meta=append_logs(logs_meta, "error", "submit", "响应缺少 task_id", {"response": body}),
                )

            logger.info(f"Jimeng task submitted: {task_id} (mode={self.mode}, async polling)")
            logs_meta = append_logs(logs_meta, "info", "submit",
                                    f"任务已提交，等待异步生成: {task_id}",
                                    {"task_id": task_id, "mode": self.mode, "resolution": resolution,
                                     "ratio": ratio, "duration": duration,
                                     "images": len(images), "videos": len(videos), "audios": len(audios),
                                     "trace_id": body.get("trace_id")})
            return GenResult(
                success=True,
                meta={**logs_meta, "adapter": self.ADAPTER_NAME, "model": self.mode,
                      "remote_task_id": task_id, "async_poll": True},
            )

        except Exception as e:
            logger.error(f"Jimeng image_to_video error: {e}", exc_info=True)
            return GenResult(
                success=False, error=f"即梦AI error: {e}",
                meta=append_logs(logs_meta, "error", "submit", f"提交异常: {e}"),
            )

    async def poll_result(self, remote_task_id: str) -> GenResult:
        """单次查询即梦任务状态（后台轮询循环调用）。

        - pending/submitted/running → poll_pending（含超分时 running 会持续到整链完成）
        - succeeded → 下载成片到本地（失败降级远端 URL），usage/duration 记入 meta
        - failed → success=False（TaskTypeConstraint 给出可操作的修复建议）
        """
        url = f"{self.base_url}{_STATUS_PATH}"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(url, json={"task_id": remote_task_id},
                                         headers=self._headers())
                resp.raise_for_status()
                body = resp.json()
            if body.get("code") not in (0, None):
                # 业务错误（如 task_id 无效）：带 trace_id 记警告，按瞬时错误重试，
                # 由外层轮询超时兜底，避免一次网关抖动误杀任务
                return GenResult(success=True, meta=append_logs(
                    {"poll_pending": True, "remote_task_id": remote_task_id},
                    "warning", "poll",
                    f"查询返回业务错误（将重试）: {body.get('message')}",
                    {"response": body, "trace_id": body.get("trace_id")}))

            data = body.get("data") or {}
            status = data.get("status", "")

            if status == "succeeded":
                video_url = data.get("video_url")
                if not video_url:
                    return GenResult(
                        success=False, error="即梦AI succeeded 但未返回 video_url",
                        meta=append_logs({"adapter": self.ADAPTER_NAME, "remote_task_id": remote_task_id},
                                         "error", "poll", "succeeded 但无 video_url", {"response": body}),
                    )
                from app.services.asset_downloader import download_to_local
                download_fallback = False
                try:
                    local_url = await download_to_local(video_url, category="video")
                except Exception as e:
                    logger.warning(f"Jimeng download failed, using remote: {e}")
                    local_url = video_url
                    download_fallback = True
                usage = data.get("usage") or {}
                meta: Dict[str, Any] = {
                    "adapter": self.ADAPTER_NAME, "model": self.mode,
                    "remote_task_id": remote_task_id, "remote_url": video_url,
                    "resolution": data.get("resolution"), "seed": data.get("seed"),
                    "fps": data.get("framespersecond"),
                    "usage_tokens": usage.get("completion_tokens"),
                    "remote_duration": data.get("duration"),
                }
                if data.get("last_frame_url"):
                    meta["last_frame_url"] = data["last_frame_url"]
                meta = append_logs(meta, "info", "poll",
                                   f"任务完成，视频已{'下载' if not download_fallback else '下载失败降级为远端'}: {local_url}",
                                   {"remote_url": video_url, "local_url": local_url,
                                    "fallback": download_fallback, "usage": usage,
                                    "duration": data.get("duration"), "response": body})
                return GenResult(
                    urls=[local_url],
                    duration=float(data["duration"]) if data.get("duration") is not None else None,
                    meta=meta,
                )

            if status == "failed":
                err = str(data.get("error") or "unknown")
                hint = ""
                if "TaskTypeConstraint" in err:
                    hint = "（seedance2.5 的视频编辑/延长任务需 ratio=adaptive 且 duration=-1，请调整后重新提交）"
                return GenResult(
                    success=False, error=f"即梦AI 任务失败: {err}{hint}",
                    meta=append_logs({"adapter": self.ADAPTER_NAME, "remote_task_id": remote_task_id},
                                     "error", "poll", f"任务失败: {err}{hint}", {"response": body}),
                )

            # pending / submitted / running → 继续轮询
            return GenResult(success=True, meta={"poll_pending": True, "status": status})

        except Exception as e:
            logger.warning(f"Jimeng poll {remote_task_id} error: {e}")
            return GenResult(
                success=True,
                meta=append_logs({"poll_pending": True, "remote_task_id": remote_task_id},
                                 "warning", "poll", f"查询异常（将重试）: {e}", {"request": url}),
            )

    async def first_last_frame_video(self, inp: GenInput) -> GenResult:
        """首尾帧生成视频：即梦通过 images[].role=first_frame/last_frame 支持。"""
        if not inp.first_frame_url and not inp.last_frame_url:
            return GenResult(success=False, error="first_last_frame 需要 first_frame_url 或 last_frame_url")
        return await self.image_to_video(inp)
