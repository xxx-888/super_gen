"""
Video Compose Service - 分镜视频合并成片

把一集的所有已生成分镜视频按序号顺序合并成一个完整视频:
1. 逐个转码规范化(统一分辨率/帧率/编码, 无音轨的补静音) —— 避免分辨率或
   编码不一致导致拼接花屏/失败
2. concat demuxer 无损拼接
3. 存入存储返回 URL

依赖 imageio-ffmpeg 自带的 ffmpeg; 不可用时抛异常由调用方提示.
"""
import asyncio
import logging
import os
import subprocess
import tempfile
from typing import List, Optional

from app.services.video_cover import ffmpeg_exe, resolve_source, probe_video_info

logger = logging.getLogger(__name__)

# 统一输出参数: 帧率与压缩档位(画质与速度平衡)
TARGET_FPS = 30
X264_PRESET = "veryfast"
X264_CRF = "23"


def _normalize_clip(exe: str, src: str, out_path: str, width: int, height: int) -> bool:
    """转码规范化单个分镜: 统一分辨率(等比缩放+黑边填充)/帧率/编码, 无音轨补静音"""
    info = probe_video_info(exe, src)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )
    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-i", src]
    if not info["has_audio"]:
        # 无音轨: 补一条静音轨(-shortest 截断到视频长度)
        cmd += ["-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo"]
    cmd += [
        "-vf", vf, "-r", str(TARGET_FPS),
        "-c:v", "libx264", "-preset", X264_PRESET, "-crf", str(X264_CRF),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "44100", "-ac", "2",
    ]
    if not info["has_audio"]:
        cmd += ["-shortest"]
    cmd.append(out_path)
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=300)
        ok = r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0
        if not ok:
            logger.warning(f"normalize clip failed: {r.stderr.decode(errors='ignore')[-300:]}")
        return ok
    except Exception as e:
        logger.warning(f"normalize clip error: {e}")
        return False


def _concat(exe: str, clip_paths: List[str], out_path: str) -> bool:
    """concat demuxer 无损拼接(输入已统一编码参数)"""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        list_path = f.name
        for p in clip_paths:
            # ffmpeg concat 列表: 单引号包裹 + 正斜杠(Windows 兼容)
            f.write("file '" + p.replace("\\", "/").replace("'", "'\\''") + "'\n")
    try:
        r = subprocess.run(
            [exe, "-y", "-hide_banner", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", list_path,
             "-c", "copy", "-movflags", "+faststart", out_path],
            capture_output=True, timeout=600,
        )
        ok = r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0
        if not ok:
            logger.warning(f"concat failed: {r.stderr.decode(errors='ignore')[-300:]}")
        return ok
    except Exception as e:
        logger.warning(f"concat error: {e}")
        return False
    finally:
        os.unlink(list_path)


def _compose_sync(exe: str, sources: List[str]) -> Optional[bytes]:
    """同步合并流程(在线程池里跑): 规范化 → 拼接 → 读出结果 bytes"""
    # 目标分辨率取第一个能探测到的分镜(偶数对齐, yuv420p 要求), 探测不到回退 1280x720
    width = height = None
    for s in sources:
        info = probe_video_info(exe, s)
        if info["width"] and info["height"]:
            width, height = info["width"] - info["width"] % 2, info["height"] - info["height"] % 2
            break
    if not width:
        width, height = 1280, 720

    with tempfile.TemporaryDirectory() as td:
        normalized = []
        for i, s in enumerate(sources):
            p = os.path.join(td, f"n{i:04d}.mp4")
            if not _normalize_clip(exe, s, p, width, height):
                raise RuntimeError(f"分镜 #{i + 1} 转码失败, 无法合并")
            normalized.append(p)
        out = os.path.join(td, "composed.mp4")
        if not _concat(exe, normalized, out):
            raise RuntimeError("分镜拼接失败, 请稍后重试")
        with open(out, "rb") as f:
            return f.read()


async def compose_videos(video_urls: List[str]) -> str:
    """按传入顺序合并视频, 存入存储并返回 URL. 失败抛 RuntimeError(带用户可读信息)."""
    if not video_urls:
        raise RuntimeError("没有可合并的视频")
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("视频合并功能不可用(服务器未安装 ffmpeg)")

    sources: List[str] = []
    for i, u in enumerate(video_urls):
        s = resolve_source(u)
        if not s:
            raise RuntimeError(f"分镜 #{i + 1} 的视频文件无法访问: {u}")
        sources.append(s)

    try:
        data = await asyncio.to_thread(_compose_sync, exe, sources)
    except RuntimeError:
        raise
    except Exception as e:
        logger.warning(f"compose videos failed: {e}")
        raise RuntimeError("视频合并失败, 请稍后重试")

    from app.services.storage import get_storage_singleton
    stored = await get_storage_singleton().save(data, "composed.mp4", "video/mp4", "video")
    return stored.url
