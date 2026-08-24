"""
MiniMax (Hailuo-03 / MiniMax-H3) 适配器

支持 MiniMax-H3 的视频生成 V2 接口：
- 图生视频（i2va）：text prompt + 首帧图片 → 视频
- 文生视频（t2va）：仅 text prompt → 视频
- 多模态参考生视频（r2va）：text + 参考图片（角色/场景/道具，≤9）、
  参考视频（≤3，MP4/MOV）、参考音频（≤3，WAV/MP3）→ 视频。
  本系统的 @引用 关联的图片/音视频资源会作为对应 reference_* 传给 MiniMax；
  官方渠道的本地音视频文件自动转 base64 data URI 内嵌。

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
import subprocess
from typing import Any, Dict, List, Optional

import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult, append_logs
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


def _sniff_image_mime(head: bytes) -> Optional[str]:
    """从文件头魔数识别图片真实格式。

    MiniMax/CompShare 服务端会校验 data URI 声明的 content-type 与图片字节
    是否一致（不符报 400 "content type does not match the image bytes"），
    而本地存储的扩展名经常与真实格式不符（如 JPEG 存成 .png），必须以字节为准。
    """
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if head.startswith(b"BM"):
        return "image/bmp"
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"heim", b"heis",
                                               b"mif1", b"msf1", b"heif", b"avif"):
        return "image/heic"
    return None


def _sniff_media_mime(head: bytes, ext: str) -> Optional[str]:
    """从文件头魔数识别视频/音频格式（图片之外的参考素材，先魔数后扩展名）。"""
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"M4A ", b"M4B "):
            return "audio/mp4"
        if brand == b"qt  ":
            return "video/quicktime"
        return "video/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):  # EBML
        return "video/webm" if ext == ".webm" else "video/x-matroska"
    if head.startswith(b"FLV"):
        return "video/x-flv"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"ID3") or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xe3"):
        return "audio/mpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    ext_map = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
               ".webm": "video/webm", ".mkv": "video/x-matroska", ".flv": "video/x-flv",
               ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
               ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac"}
    return ext_map.get(ext)


# 官方 v2 接口参考音视频的格式白名单与本地文件转 data URI 的大小上限：
# - 格式（官方文档）：参考视频仅 MP4/MOV，参考音频仅 WAV/MP3；
#   不合式提交会导致整单被 400 拒绝，必须提前过滤（可转码的走 ffmpeg 兜底）
# - 大小：音频单文件 ≤15MB、视频取 30MB（base64 膨胀 ~33%，
#   官方请求体总上限 64MB，需给文本/参考图留余量）
# - 时长：单段 [2,15]s 且同类型总时长 ≤15s → 多条参考按 15÷条数分配单段预算，
#   超限自动 ffmpeg 截取前 N 秒并转码为 MP3/MP4
_REF_AUDIO_MIMES = {"audio/wav", "audio/mpeg"}
_REF_VIDEO_MIMES = {"video/mp4", "video/quicktime"}
_REF_AUDIO_MAX_BYTES = 15 * 1024 * 1024
_REF_VIDEO_MAX_BYTES = 30 * 1024 * 1024
# 官方对 data URI 声明的 content-type 按格式名词做白名单校验（audio/<fmt> 的 fmt
# 只认 wav/mp3），标准 MIME audio/mpeg 会报 audio format ".mpeg" not allowed、
# video/quicktime 同理 → 发送前映射成官方接受的名词（字节本身不变，MP3/MOV 容器合法）
_DATA_URI_MIME_MAP = {
    "audio/mpeg": "audio/mp3",
    "video/quicktime": "video/mov",
}
# 官方单段时长上下限（秒）；多条参考的总时长上限 15s 在 _collect_media 里按条数拆分
_REF_MEDIA_MIN_SECS = 2
_REF_MEDIA_TOTAL_SECS = 15


def _resolve_local_path(url: str) -> Optional[str]:
    """把本地存储 URL 解析成实际存在的绝对路径；非本地形式或文件不存在返回 None。

    支持 /uploads/...、uploads/...、相对路径，以及 http(s)://host/uploads/...
    （宿主机地址形式的本地存储地址，MiniMax 服务端访问不到）。
    """
    if url.startswith(("http://", "https://")) and "/uploads/" not in url:
        return None
    storage_path = getattr(settings, "STORAGE_LOCAL_PATH", None)
    if not storage_path:
        return None
    idx = url.find("/uploads/")
    rel = url[idx + len("/uploads/"):] if idx >= 0 else url.lstrip("/")
    abs_path = os.path.join(storage_path, rel)
    return abs_path if os.path.exists(abs_path) else None


async def _local_media_to_data_uri(url: str, kind: str) -> Optional[str]:
    """本地音视频参考转 base64 data URI（官方 v2 接口支持 base64 输入）。

    公网 URL 原样返回；本地文件按 kind(video/audio) 校验格式白名单与大小上限，
    不满足 / 文件不存在 / 读取失败时返回 None，由调用方跳过并告警
    （data URI 声明的 content-type 必须与真实字节一致，服务端会校验）。
    """
    if url.startswith(("http://", "https://")) and "/uploads/" not in url:
        return url  # 公网 URL 直接可用
    abs_path = _resolve_local_path(url)
    if not abs_path:
        return None
    try:
        max_bytes = _REF_VIDEO_MAX_BYTES if kind == "video" else _REF_AUDIO_MAX_BYTES
        if os.path.getsize(abs_path) > max_bytes:
            return None
        import aiofiles
        async with aiofiles.open(abs_path, "rb") as f:
            data = await f.read()
        ext = os.path.splitext(abs_path)[1].lower()
        mime = _sniff_media_mime(data[:16], ext)
        allowed = _REF_VIDEO_MIMES if kind == "video" else _REF_AUDIO_MIMES
        if mime not in allowed:
            logger.warning(f"Reference {kind} mime {mime} not allowed "
                           f"(allowed: {sorted(allowed)}): {abs_path}")
            return None
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{_DATA_URI_MIME_MAP.get(mime, mime)};base64,{b64}"
    except Exception as e:
        logger.warning(f"Failed to convert local {kind} to data URI ({url}): {e}")
        return None


async def _probe_media_duration(url: str) -> Optional[float]:
    """探测参考音视频时长（秒）。复用 imageio-ffmpeg 的 ffmpeg 解析 -i 信息；
    无 ffmpeg / 解析失败 / 远程不可达返回 None（调用方按原样透传处理）。"""
    try:
        from app.services.video_cover import ffmpeg_exe, probe_duration
        exe = ffmpeg_exe()
        if not exe:
            return None
        src = _resolve_local_path(url) or url
        return await asyncio.to_thread(probe_duration, exe, src)
    except Exception as e:
        logger.warning(f"probe reference media duration failed ({url}): {e}")
        return None


async def _trim_media_bytes(src: str, kind: str, max_secs: int) -> Optional[bytes]:
    """ffmpeg 截取 src（本地路径或公网 URL）前 max_secs 秒并转官方合规编码
    （音频→MP3，视频→H.264+AAC MP4），返回文件字节。失败/超限返回 None。
    上传链路的 media_prep.normalize_reference_media 也复用此函数。"""
    try:
        from app.services.video_cover import ffmpeg_exe
        exe = ffmpeg_exe()
        if not exe:
            return None
        import tempfile
        is_video = kind == "video"
        fd, tmp_out = tempfile.mkstemp(suffix=".mp4" if is_video else ".mp3")
        os.close(fd)
        try:
            if is_video:
                cmd = [exe, "-y", "-v", "error", "-i", src,
                       "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                       "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                       "-t", str(max_secs), tmp_out]
            else:
                cmd = [exe, "-y", "-v", "error", "-i", src,
                       "-vn", "-c:a", "libmp3lame", "-b:a", "128k",
                       "-t", str(max_secs), tmp_out]
            # 注意：不能用 asyncio.create_subprocess_exec —— uvicorn --reload 在 Windows 上
            # 跑 SelectorEventLoop，async 子进程抛 NotImplementedError（表现为"自动截取失败"，
            # 上传规范化与生成时截取会一起静默失效）。to_thread + 同步 subprocess 在任何
            # 事件循环下都可用（与 video_cover.probe_duration 同一模式）。
            r = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, timeout=180)
            if r.returncode != 0 or not os.path.exists(tmp_out) or os.path.getsize(tmp_out) == 0:
                logger.warning(f"Trim reference {kind} failed ({src}): {(r.stderr or b'')[-300:]!r}")
                return None
            max_bytes = _REF_VIDEO_MAX_BYTES if is_video else _REF_AUDIO_MAX_BYTES
            if os.path.getsize(tmp_out) > max_bytes:
                return None
            with open(tmp_out, "rb") as f:
                return f.read()
        finally:
            try:
                os.unlink(tmp_out)
            except OSError:
                pass
    except Exception as e:
        logger.warning(f"Trim reference {kind} error ({src}): {e}")
        return None


async def _trim_media_to_data_uri(url: str, kind: str, max_secs: int) -> Optional[str]:
    """ffmpeg 截取媒体前 max_secs 秒并转官方合规编码（音频→MP3，视频→H.264+AAC MP4），
    读回转 base64 data URI。kind: "video"/"audio"。失败返回 None。

    本地路径与公网 URL 均可作为输入（ffmpeg 自带 http 拉流）。
    """
    src = _resolve_local_path(url) or url
    data = await _trim_media_bytes(src, kind, max_secs)
    if data is None:
        return None
    mime = "video/mp4" if kind == "video" else "audio/mpeg"
    return f"data:{_DATA_URI_MIME_MAP.get(mime, mime)};base64,{base64.b64encode(data).decode('ascii')}"


async def _prepare_ref_media(url: str, kind_label: str, max_secs: int) -> tuple:
    """按官方时长/格式限制处理单条参考音/视频，返回 (最终形式, 告警或None)。

    - 公网 URL：时长合规（或探测不到）→ 原样透传；超限 → 自动截取转 data URI
    - 本地文件：合规 → data URI；格式/大小不合规或超时长 → ffmpeg 截取/转码兜底
    - 时长 <2s（官方单段下限）→ 跳过（无法补救）
    """
    kind = "video" if kind_label == "视频" else "audio"
    remote = url.startswith(("http://", "https://")) and "/uploads/" not in url
    dur = await _probe_media_duration(url)

    if dur is not None and dur < _REF_MEDIA_MIN_SECS:
        return None, f"参考{kind_label}时长 {dur:.1f}s 不足官方下限 2s，已跳过"

    if dur is None or dur <= max_secs:
        if remote:
            return url, None
        uri = await _local_media_to_data_uri(url, kind)
        if uri:
            return uri, None
        # 格式/大小不合规但可转码：截取转 MP3/MP4 兜底（-t 同时封顶时长）
        uri = await _trim_media_to_data_uri(url, kind, max_secs)
        if uri:
            return uri, (f"参考{kind_label}格式不受官方支持"
                         f"（{'视频MP4/MOV' if kind == 'video' else '音频WAV/MP3'}），"
                         f"已自动转码为 {'MP4' if kind == 'video' else 'MP3'} 内嵌")
        limit = "MP4/MOV≤30MB" if kind == "video" else "WAV/MP3≤15MB"
        return None, f"参考{kind_label}为本地文件但不满足内嵌条件（{limit}），已跳过"

    # 超出单段时长预算 → 自动截取前 max_secs 秒（同步转成合规编码）
    uri = await _trim_media_to_data_uri(url, kind, max_secs)
    if uri:
        return uri, (f"参考{kind_label}时长 {dur:.0f}s 超官方单段上限，"
                     f"已自动截取前 {max_secs}s 提交")
    # 截取失败：跳过而不是原样提交——超限素材原样提交会被官方整单拒绝，
    # 丢一条参考好过整个任务失败
    return None, (f"参考{kind_label}时长 {dur:.0f}s 超官方上限 15s 且自动截取失败，"
                  f"已跳过（可重新上传该素材触发入库规范化）")


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
        # 推断 MIME：优先按文件头魔数（服务端会校验与字节的一致性），
        # 识别失败再回退扩展名，最终兜底 image/jpeg
        ext = os.path.splitext(abs_path)[1].lower()
        mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif"}
        mime = (_sniff_image_mime(data[:16]) or _sniff_media_mime(data[:16], ext)
                or mime_map.get(ext, "image/jpeg"))
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except Exception as e:
        logger.warning(f"Failed to convert local image to base64 ({url}): {e}")
        return url


class MinimaxAdapter(BaseAdapter):
    """MiniMax H3 视频生成适配器。"""

    # 渠道差异点（子类 MinimaxCompshareAdapter 覆盖，其余协议两者完全一致）：
    # - ADAPTER_NAME: 写进 GenResult.meta["adapter"] 的标识（任务详情展示/排查用）
    # - DEFAULT_BASE_URL: 未配置 endpoint 时的默认 API 地址
    # - MAX_PROMPT_CHARS: 文本提示词长度上限（官方 7000，CompShare 渠道 5000）
    # - FORCE_WATERMARK_FALSE: True 时强制 aigc_watermark=false（渠道仅支持关闭水印）
    ADAPTER_NAME = "minimax"
    DEFAULT_BASE_URL = "https://api.minimaxi.com"
    MAX_PROMPT_CHARS = 7000
    FORCE_WATERMARK_FALSE = False
    # 渠道是否支持 reference_video / reference_audio（实测 CompShare 渠道
    # 对任意 URL 形式的视频参考都返回 RetCode 230 "Params [reference URL]
    # not available"（参数未实现，非下载失败）——不支持时自动跳过并警告）
    SUPPORTS_REFERENCE_MEDIA = True
    # 官方 v2 接口的 video_url/audio_url 支持 base64 data URI（请求体 ≤64MB），
    # 本地 /uploads 音视频参考会自动转 data URI 内嵌；CompShare 渠道不支持，
    # 子类置 False 维持"仅公网 URL"策略
    SUPPORTS_MEDIA_DATA_URI = True

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
        base = cfg.get("endpoint") or cfg.get("base_url") or self.DEFAULT_BASE_URL
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

    def _map_resolution(self, resolution: str) -> str:
        """把系统分辨率偏好映射为 API 取值（子类可覆盖，如渠道仅开放 768P）。"""
        return _RESOLUTION_MAP.get(resolution, resolution)

    async def _build_content(self, inp: GenInput) -> tuple:
        """构造 MiniMax V2 的 content 数组（异步：本地图片需转 base64）。

        返回 (content_list, warnings)：warnings 为组包时被跳过的参考素材说明
        （写入任务日志，不阻断生成）。

        模式自动判定（MiniMax 规定首尾帧与参考素材互斥，不能混用）：
        - 有显式 first_frame_url / last_frame_url（首尾帧节点）→ 图生视频(i2va)
        - 有 elements（@引用的角色/场景/道具图片、音效、视频）→ 多模态参考生视频(r2va)；
          参考图 ≤9、参考视频/音频各 ≤3；此时若还给了 image_url（如分镜图）也并入参考图
          （作首帧会与互斥约束冲突，且旧逻辑在此场景下直接丢弃参考图，表现为"参考图不生效"）
        - 只有 image_url → 标准图生视频（首帧驱动）
        - 都没有 → 文生视频(t2va)

        参考素材格式约束（官方 v2 文档）：
        - 参考图片：公网 URL / data URI 均可（≤9 张，服务端解码校验过）
        - 参考视频：≤3 个，仅 MP4/MOV，单段 [2,15]s 且总时长 ≤15s；
          参考音频：≤3 个，仅 WAV/MP3，时长限制相同。
          官方接口 video_url/audio_url 同样接受 base64 data URI（请求体总限 64MB）。
          本地 /uploads 及公网超长素材会自动 ffmpeg 截取（按时长预算）转
          MP3/MP4 后以 data URI 内嵌；不合式且无法转码的跳过并记入 warnings。
          （CompShare 渠道 2026-08-24 实测 URL 与 data URI 均已支持）
        """
        text = inp.prompt or ""
        if inp.extra.get("minimax_prompt"):
            text = inp.extra["minimax_prompt"]
        if not text:
            text = "让画面动起来"

        # 显式首尾帧 → i2va（用户明确要求帧控制，优先级最高）
        explicit_frames = []
        if inp.first_frame_url:
            explicit_frames.append(("first_frame", inp.first_frame_url))
        if inp.last_frame_url:
            explicit_frames.append(("last_frame", inp.last_frame_url))

        # 收集 elements 里的参考素材（r2va 模式）：
        #   图片（角色/场景/道具 image_url，≤9）→ reference_image
        #   视频（video_url，≤3）→ reference_video
        #   音频（audio_url，≤3）→ reference_audio
        ref_urls: List[str] = []
        ref_video_urls: List[str] = []
        ref_audio_urls: List[str] = []
        for el in (inp.elements or []):
            if el.image_url and el.image_url not in ref_urls:
                ref_urls.append(el.image_url)
            if el.video_url and el.video_url not in ref_video_urls:
                ref_video_urls.append(el.video_url)
            if el.audio_url and el.audio_url not in ref_audio_urls:
                ref_audio_urls.append(el.audio_url)
        # 视频生视频：请求直接携带的输入视频也作为参考视频（videoToVideo 链路）
        if inp.video_url and inp.video_url not in ref_video_urls:
            ref_video_urls.append(inp.video_url)

        if explicit_frames:
            content = [{"type": "text", "text": text[:self.MAX_PROMPT_CHARS]}]
            for role, url in explicit_frames[:2]:  # 最多首帧+尾帧
                data_uri = await _local_url_to_data_uri(url)
                content.append({"type": "image_url", "image_url": {"url": data_uri}, "role": role})
            return content, []

        if ref_urls or ref_video_urls or ref_audio_urls:
            warnings: List[str] = []
            # r2va：image_url（如分镜图）并入参考图列表头部
            if inp.image_url and inp.image_url not in ref_urls:
                ref_urls.insert(0, inp.image_url)
            urls = ref_urls[:9]        # 参考图最多 9 张（data URI 可用）
            # 参考视频/音频：仅透传公网 URL；本地文件跳过（渠道不收 data URI）。
            # 渠道未实现该能力时（SUPPORTS_REFERENCE_MEDIA=False）全部跳过，
            # 避免整单提交失败（RetCode 230）。
            def _usable_remote(u: str) -> bool:
                return u.startswith(("http://", "https://")) and "/uploads/" not in u

            async def _collect_media(urls: List[str], kind: str) -> List[str]:
                """收集参考音/视频（各 ≤3）。官方限制：单段 [2,15]s 且同类型总时长 ≤15s，
                多条时按 15÷条数分配单段预算（1条=15s、2条=7s、3条=5s）。
                官方渠道：探测时长，超限自动 ffmpeg 截取前 N 秒转 MP3/MP4 内嵌，
                公网 URL 合规则直传；不支持 data URI 的渠道：仅收公网 URL。"""
                picked = urls[:3]
                budget = max(_REF_MEDIA_MIN_SECS,
                             _REF_MEDIA_TOTAL_SECS // max(1, len(picked))) if picked else _REF_MEDIA_TOTAL_SECS
                out: List[str] = []
                for u in picked:
                    if self.SUPPORTS_MEDIA_DATA_URI:
                        result, note = await _prepare_ref_media(u, kind, budget)
                    elif _usable_remote(u):
                        result, note = u, None
                    else:
                        result, note = None, (f"1 个参考{kind}为本地文件，该渠道仅支持公网 URL，"
                                              f"已跳过（可上传到文件服务器后用公网链接引用）")
                    if note:
                        warnings.append(note)
                    if result:
                        out.append(result)
                return out

            if self.SUPPORTS_REFERENCE_MEDIA:
                vids = await _collect_media(ref_video_urls, "视频")
                auds = await _collect_media(ref_audio_urls, "音频")
            else:
                skipped_media = len(ref_video_urls) + len(ref_audio_urls)
                if skipped_media:
                    warnings.append(f"{skipped_media} 个视频/音频参考已自动忽略："
                                    f"该渠道暂未实现 reference_video/reference_audio 能力"
                                    f"（提交会被拒），图片参考不受影响")
                vids, auds = [], []
            # 提示词原文直发，不注入任何自动绑定语 —— 用户编辑的是什么就发什么
            #（素材指代由提示词里的 [角色:名]/[场景:名] 等芯片文本自行表达）
            content = [{"type": "text", "text": text[:self.MAX_PROMPT_CHARS]}]
            for url in urls:
                data_uri = await _local_url_to_data_uri(url)
                content.append({"type": "image_url", "image_url": {"url": data_uri},
                                "role": "reference_image"})
            for url in vids:
                content.append({"type": "video_url", "video_url": {"url": url},
                                "role": "reference_video"})
            for url in auds:
                content.append({"type": "audio_url", "audio_url": {"url": url},
                                "role": "reference_audio"})
            return content, warnings

        content = [{"type": "text", "text": text[:self.MAX_PROMPT_CHARS]}]
        if inp.image_url:
            data_uri = await _local_url_to_data_uri(inp.image_url)
            content.append({"type": "image_url", "image_url": {"url": data_uri}, "role": "first_frame"})
        return content, []

    async def image_to_video(self, inp: GenInput) -> GenResult:
        """图生视频 / 文生视频：仅提交任务，返回 remote_task_id（不阻塞轮询）。

        MiniMax 视频生成需要 1-3 分钟，同步轮询会导致前端 HTTP 超时。
        所以这里只提交，把 remote_task_id 放进 meta 返回，由 submit_creation
        的后台任务调 poll_result 轮询。
        """
        if not self._available():
            return GenResult(success=False, error="MiniMax api_key not configured")
        logs_meta: Dict[str, Any] = {"logs": []}
        try:
            resolution = inp.extra.get("resolution") or self.default_resolution
            ratio = inp.extra.get("ratio") or inp.size or "16:9"
            content, ref_warnings = await self._build_content(inp)
            for w in ref_warnings:
                logs_meta = append_logs(logs_meta, "warning", "submit", w)
            payload = {
                "model": self.model,
                "content": content,
                "resolution": self._map_resolution(resolution),
                "duration": _clamp_duration(inp.duration),
                "ratio": ratio if ratio != "adaptive" else "16:9",
            }
            if self.FORCE_WATERMARK_FALSE:
                # CompShare 渠道仅支持不带水印，显式传 false（默认行为是带水印）
                payload["aigc_watermark"] = False
            elif "watermark_enabled" in inp.extra:
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
                return GenResult(
                    success=False,
                    error=f"MiniMax create failed: {err}",
                    meta=append_logs(logs_meta, "error", "submit",
                                     f"创建任务失败: {err}",
                                     {"endpoint": "/v2/video_generation", "model": self.model,
                                      "request": payload, "response": data}),
                )

            logger.info(f"MiniMax H3 task submitted: {task_id} (async polling)")
            logs_meta = append_logs(logs_meta, "info", "submit",
                                    f"任务已提交，等待异步生成: {task_id}",
                                    {"task_id": task_id, "model": self.model, "resolution": payload["resolution"],
                                     "ratio": payload["ratio"], "duration": payload["duration"],
                                     "request": payload, "response": data})
            # 返回 pending 状态 + remote_task_id，由后台轮询
            return GenResult(
                success=True,
                meta={**logs_meta, "adapter": self.ADAPTER_NAME, "model": self.model,
                      "remote_task_id": task_id, "async_poll": True},
            )
        except httpx.HTTPStatusError as e:
            err_body = e.response.text[:300] if e.response else ""
            return GenResult(
                success=False,
                error=f"MiniMax HTTP {e.response.status_code}: {err_body}",
                meta=append_logs(logs_meta, "error", "submit",
                                 f"HTTP {e.response.status_code}: {err_body}",
                                 {"status_code": e.response.status_code,
                                  "request": payload, "response": err_body}),
            )
        except Exception as e:
            logger.error(f"MiniMax image_to_video error: {e}", exc_info=True)
            return GenResult(
                success=False,
                error=f"MiniMax error: {e}",
                meta=append_logs(logs_meta, "error", "submit", f"提交异常: {e}"),
            )

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
                    return GenResult(
                        success=False,
                        error="MiniMax succeeded but no url",
                        meta=append_logs({"adapter": "minimax", "remote_task_id": remote_task_id},
                                         "error", "poll", "succeeded 但无 url",
                                         {"request": url, "response": data}),
                    )
                from app.services.asset_downloader import download_to_local
                download_fallback = False
                try:
                    local_url = await download_to_local(video_url, category="video")
                except Exception as e:
                    logger.warning(f"MiniMax download failed, using remote: {e}")
                    local_url = video_url
                    download_fallback = True
                base_meta = {"adapter": "minimax", "model": self.model, "remote_task_id": remote_task_id,
                             "remote_url": video_url, "resolution": task.get("resolution"), "ratio": task.get("ratio")}
                base_meta = append_logs(base_meta, "info", "poll",
                                        f"任务完成，视频已{'下载' if not download_fallback else '下载失败降级为远端'}: {local_url}",
                                        {"remote_url": video_url, "local_url": local_url,
                                         "fallback": download_fallback, "duration": task.get("duration"),
                                         "request": url, "response": data})
                return GenResult(
                    urls=[local_url],
                    duration=float(task.get("duration", 0)),
                    meta=base_meta,
                )

            if status in ("failed", "cancelled"):
                err = task.get("error", {})
                err_msg = err.get("message", status) if isinstance(err, dict) else status
                return GenResult(
                    success=False,
                    error=f"MiniMax task {status}: {err_msg}",
                    meta=append_logs({"adapter": "minimax", "remote_task_id": remote_task_id},
                                     "error", "poll", f"任务 {status}: {err_msg}",
                                     {"request": url, "response": data}),
                )

            # queued / running → 还在处理
            return GenResult(success=True, meta={"poll_pending": True, "status": status})

        except Exception as e:
            logger.warning(f"MiniMax poll {remote_task_id} error: {e}")
            # 查询出错不直接失败，让调用方继续重试
            return GenResult(
                success=True,
                meta=append_logs({"poll_pending": True, "remote_task_id": remote_task_id},
                                 "warning", "poll", f"查询异常（将重试）: {e}",
                                 {"request": url}),
            )

    async def first_last_frame_video(self, inp: GenInput) -> GenResult:
        """首尾帧生成视频：MiniMax 支持首帧+尾帧。"""
        if not inp.first_frame_url and not inp.last_frame_url:
            return GenResult(success=False, error="first_last_frame 需要 first_frame_url 或 last_frame_url")
        return await self.image_to_video(inp)
