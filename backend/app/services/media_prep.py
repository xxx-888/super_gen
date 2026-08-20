"""上传音视频参考素材的自动规范化（上传链路统一入口 file_server.store_media 调用）

目标：用户上传的音频/视频在入库 / 转传云端之前，就自动处理成生成渠道可直接
使用的参考素材（以最严的 MiniMax 官方 r2va 限制为基准）：

- 音频：WAV/MP3，单段 ≤15s
- 视频：MP4（H.264 + AAC），单段 ≤15s

处理规则：
- 超时长 → 自动截取前 15 秒
- 格式/编码不符 → 自动转码（音频→MP3 128k，视频→H.264+AAC MP4）
- 已合规 → 原样保留，不重复转码
- 无 ffmpeg / 处理失败 → 原样返回（生成链路 minimax_adapter 里还有
  探测+截取兜底，不会因此提交失败）

说明：本系统的音视频上传（资源页参考视频/音频、素材库音视频、画布素材节点）
均为生成参考用途，入库即规范化是安全的；生成的成片/TTS 产物不经过此链路。
"""
import asyncio
import logging
import os
import tempfile
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# 参考素材单段时长上限（秒）；2s 为官方单段下限（过短无法补救，保持原样）
REF_MAX_SECS = 15
REF_MIN_SECS = 2
# 已合规格式（不必转码）；x-wav 为部分浏览器上传 wav 时的写法
_COMPLIANT_AUDIO = {"audio/mpeg", "audio/wav", "audio/x-wav"}
_COMPLIANT_VIDEO = {"video/mp4", "video/quicktime"}


async def _probe_bytes(data: bytes, filename: str) -> Optional[float]:
    """探测字节流的媒体时长（秒）。无 ffmpeg / 解析失败返回 None。"""
    from app.services.video_cover import ffmpeg_exe, probe_duration
    exe = ffmpeg_exe()
    if not exe:
        return None
    suffix = os.path.splitext(filename)[1].lower() or ".bin"
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        return await asyncio.to_thread(probe_duration, exe, tmp)
    except Exception as e:
        logger.warning(f"probe uploaded media duration failed: {e}")
        return None
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


async def normalize_reference_media(
    data: bytes, filename: str, mime_type: str, category: str,
) -> Tuple[bytes, str, str, dict]:
    """规范化上传的音视频参考素材。

    返回 (data, filename, mime_type, meta)；meta = {"processed": bool, "reason": str}
    记录是否处理及原因（写入日志，便于排查"上传后素材变短/格式变了"）。
    """
    meta = {"processed": False, "reason": "skip"}
    if category not in ("video", "audio") or not data:
        return data, filename, mime_type, meta

    # 真实格式以字节魔数为准（浏览器上传的 content_type / 扩展名经常不准）
    from app.adapters.minimax_adapter import _sniff_media_mime
    kind = "video" if category == "video" else "audio"
    ext = os.path.splitext(filename)[1].lower()
    cur_mime = _sniff_media_mime(data[:16], ext) or (mime_type or "")
    compliant = _COMPLIANT_VIDEO if kind == "video" else _COMPLIANT_AUDIO

    dur = await _probe_bytes(data, filename)
    too_long = dur is not None and dur > REF_MAX_SECS + 0.5
    format_ok = cur_mime in compliant
    if not too_long and format_ok:
        meta["reason"] = "compliant"
        return data, filename, mime_type, meta
    if dur is not None and dur < REF_MIN_SECS:
        # 不足官方单段下限，截取/转码都救不了，保持原样（生成时会跳过并告警）
        meta["reason"] = f"too_short({dur:.1f}s)"
        return data, filename, mime_type, meta

    # 需要处理：截取（-t 同时封顶时长）+ 转码为合规编码
    from app.adapters.minimax_adapter import _trim_media_bytes
    suffix = ext or (".mp4" if kind == "video" else ".mp3")
    fd, tmp_in = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        out = await _trim_media_bytes(tmp_in, kind, REF_MAX_SECS)
    finally:
        try:
            os.unlink(tmp_in)
        except OSError:
            pass

    if not out:
        meta["reason"] = "ffmpeg_failed"
        logger.warning(f"normalize uploaded {category} failed, keep original: {filename}")
        return data, filename, mime_type, meta

    new_ext = ".mp4" if kind == "video" else ".mp3"
    base = os.path.splitext(filename or f"upload.{category}")[0]
    new_name = f"{base}{new_ext}"
    new_mime = "video/mp4" if kind == "video" else "audio/mpeg"
    reasons = []
    if too_long:
        reasons.append(f"截取前{REF_MAX_SECS}s(原{dur:.0f}s)")
    if not format_ok:
        reasons.append(f"{cur_mime or '未知格式'}→{new_mime}")
    meta = {"processed": True, "reason": "，".join(reasons), "duration": REF_MAX_SECS}
    logger.info(f"normalize uploaded {category} '{filename}' -> '{new_name}' ({meta['reason']})")
    return out, new_name, new_mime, meta
