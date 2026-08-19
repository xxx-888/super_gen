"""
Video Cover Service - 视频封面智能截帧

发布作品未提供封面时, 用 ffmpeg 从视频里截取候选帧(10%/25%/50% 时刻),
按「细节丰富度 × 亮度」打分挑最优的一帧存入存储, 作为画廊封面.
依赖 imageio-ffmpeg 自带的静态 ffmpeg 二进制; 不可用时优雅降级(返回 None, 不带封面).
"""
import asyncio
import logging
import os
import re
import subprocess
import tempfile
from typing import Optional

from PIL import Image, ImageFilter, ImageStat

from app.core.config import settings

logger = logging.getLogger(__name__)

_FFMPEG_EXE: Optional[str] = None


def ffmpeg_exe() -> Optional[str]:
    """获取 ffmpeg 可执行文件路径(懒加载 + 失败缓存, 不反复尝试)"""
    global _FFMPEG_EXE
    if _FFMPEG_EXE is None:
        try:
            import imageio_ffmpeg
            _FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception as e:
            logger.warning(f"imageio-ffmpeg 不可用, 封面自动截帧已停用: {e}")
            _FFMPEG_EXE = ""
    return _FFMPEG_EXE or None


def resolve_source(url: str) -> Optional[str]:
    """把媒体地址解析成 ffmpeg 可读输入: 本地 /uploads 相对路径或 http(s) 直链"""
    if url.startswith("/uploads/"):
        rel = url[len("/uploads/"):].lstrip("/")
        path = os.path.join(settings.STORAGE_LOCAL_PATH, *rel.split("/"))
        return path if os.path.exists(path) else None
    if url.startswith(("http://", "https://")):
        return url
    return None


def probe_duration(exe: str, src: str) -> Optional[float]:
    """解析 ffmpeg -i 的 stderr 拿视频时长(秒)"""
    try:
        r = subprocess.run([exe, "-hide_banner", "-i", src], capture_output=True, timeout=30)
        m = re.search(rb"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr)
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        pass
    return None


def probe_video_info(exe: str, src: str) -> dict:
    """解析 ffmpeg -i 的 stderr 拿分辨率与音轨信息: {width, height, has_audio}"""
    info = {"width": None, "height": None, "has_audio": False}
    try:
        r = subprocess.run([exe, "-hide_banner", "-i", src], capture_output=True, timeout=30)
        err = r.stderr
        m = re.search(rb"Stream #\d+:\d+.*?: Video:.*?(\d{2,5})x(\d{2,5})", err)
        if m:
            info["width"], info["height"] = int(m.group(1)), int(m.group(2))
        if re.search(rb"Stream #\d+:\d+.*?: Audio:", err):
            info["has_audio"] = True
    except Exception:
        pass
    return info


def _extract_frame(exe: str, src: str, pos: float, out_path: str) -> bool:
    """在 pos 秒处截一帧存为 jpg"""
    try:
        r = subprocess.run(
            [exe, "-hide_banner", "-loglevel", "error",
             "-ss", f"{max(pos, 0):.2f}", "-i", src,
             "-frames:v", "1", "-q:v", "3", "-y", out_path],
            capture_output=True, timeout=60,
        )
        return r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0
    except Exception:
        return False


def _frame_score(path: str) -> float:
    """帧质量评分: 边缘细节方差 × 亮度权重 —— 避开纯黑/纯白的空帧"""
    try:
        with Image.open(path) as img:
            gray = img.convert("L").resize((160, 160))
            detail = ImageStat.Stat(gray.filter(ImageFilter.FIND_EDGES)).stddev[0]
            bright = ImageStat.Stat(gray).mean[0]
            return detail * (0.3 + bright / 255.0)
    except Exception:
        return 0.0


def _extract_best_frame(exe: str, src: str) -> Optional[bytes]:
    duration = probe_duration(exe, src) or 10.0
    # 候选时刻: 时长的 10%/25%/50%, 跳过片头可能的全黑帧, 不超过倒数 0.1s
    positions = sorted({
        max(min(duration * f, max(duration - 0.1, 0)), 0.5)
        for f in (0.1, 0.25, 0.5)
    })
    best_path, best_score = None, -1.0
    with tempfile.TemporaryDirectory() as td:
        for i, pos in enumerate(positions):
            p = os.path.join(td, f"f{i}.jpg")
            if _extract_frame(exe, src, pos, p):
                score = _frame_score(p)
                if score > best_score:
                    best_score, best_path = score, p
        if not best_path:
            return None
        with open(best_path, "rb") as f:
            return f.read()


async def extract_video_cover(video_url: str) -> Optional[str]:
    """从视频智能截取封面帧, 存入存储并返回 URL. 任何失败返回 None(调用方降级为无封面)."""
    exe = ffmpeg_exe()
    src = resolve_source(video_url) if exe else None
    if not exe or not src:
        return None
    try:
        data = await asyncio.to_thread(_extract_best_frame, exe, src)
        if not data:
            return None
        from app.services.storage import get_storage_singleton
        stored = await get_storage_singleton().save(data, "cover.jpg", "image/jpeg", "image")
        return stored.url
    except Exception as e:
        logger.warning(f"封面截帧失败 {video_url}: {e}")
        return None
