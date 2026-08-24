"""视频在线剪辑合成引擎（M7）

按 VideoEditConfig JSON 用 ffmpeg 合成成片，流水线：
  1. 素材解析（本地 /uploads 直取；公网 URL 下载到临时目录）
  2. 逐片段归一化：裁剪(in/out) + 缩放/留黑边到目标分辨率 + 统一 fps/编码/采样率
     + 片段音量（volume=0 等价静音，保留音轨结构以便拼接）
  3. concat 拼接（参数已归一，-c copy 无损快速）
  4. 终混（一步完成）：原声全局音量 + BGM（循环/裁到片长/淡入淡出/amix 混音）
     + ASS 字幕烧录（libass + fontconfig，Noto Sans CJK SC）
  5. 落盘 uploads（storage 服务统一路径/命名），返回 URL

子进程一律 asyncio.to_thread + subprocess.run：
uvicorn --reload 的 SelectorEventLoop 下 asyncio.create_subprocess_exec 不可用
（media_prep 同款教训），同步 subprocess 任何事件循环下都能跑。
"""
import asyncio
import logging
import os
import re
import subprocess
import tempfile
import uuid as uuidlib
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# 输出分辨率预设（白名单，防任意尺寸炸渲染）
RESOLUTION_PRESETS = {
    "720p": (1280, 720),
    "1080p": (1920, 1080),
    "480p": (854, 480),
    "square_720": (720, 720),
    "vertical_720": (720, 1280),
}

_ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,{fontsize},&H00{color},&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,1,{align},40,40,{marginv},1

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
"""


def _ffmpeg_bin() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _run_ffmpeg(args: List[str], step: str) -> None:
    """同步执行 ffmpeg（在 to_thread 里调用），失败抛异常带 stderr 尾部。"""
    cmd = [_ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error"] + args
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)  # noqa: S603
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-600:]
        raise RuntimeError(f"ffmpeg {step} 失败: {tail}")


def _probe_has_audio(src: str) -> bool:
    """素材是否含音轨（无音轨片段补静音，保证 concat 流一致）。"""
    try:
        proc = subprocess.run(
            [_ffmpeg_bin(), "-hide_banner", "-i", src],
            capture_output=True, text=True, timeout=120,
        )
        return "Audio:" in (proc.stderr or "")
    except Exception:
        return True  # 探测失败按有音轨处理，失败让 ffmpeg 自己报


def _probe_duration(src: str) -> Optional[float]:
    """ffmpeg -i 解析 Duration（imageio-ffmpeg 不带 ffprobe）。"""
    try:
        proc = subprocess.run(
            [_ffmpeg_bin(), "-hide_banner", "-i", src],
            capture_output=True, text=True, timeout=120,
        )
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", proc.stderr or "")
        if m:
            h, mi, s = m.groups()
            return int(h) * 3600 + int(mi) * 60 + float(s)
    except Exception as e:
        logger.warning(f"probe duration failed ({src}): {e}")
    return None


def _resolve_local_path(url: str) -> Optional[str]:
    """/uploads/... → 本地绝对路径；非本地返回 None。"""
    if not url:
        return None
    if url.startswith(("http://", "https://")) and "/uploads/" not in url:
        return None
    base = settings.STORAGE_LOCAL_PATH
    rel = url.split("/uploads/", 1)[-1].lstrip("/")
    p = os.path.join(base, rel)
    return p if os.path.exists(p) else None


def _download_to(url: str, dest: str) -> str:
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in resp.iter_bytes(65536):
                    f.write(chunk)
    return dest


def _ass_time(sec: float) -> str:
    sec = max(0.0, float(sec))
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _hex_to_ass_bgra(hex_color: str) -> str:
    """#RRGGBB → ASS 的 &HAABBGGRR（AA=00 不透明）。"""
    h = (hex_color or "#FFFFFF").lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"{b}{g}{r}".upper()


def build_ass_subtitles(subtitles: List[Dict[str, Any]], style: Dict[str, Any],
                        width: int, height: int) -> str:
    """字幕条目 + 样式 → ASS 文本。position: bottom/top；字号按 720p 基准等比缩放。"""
    st = style or {}
    scale = height / 720 if height else 1.0
    fontsize = int(float(st.get("font_size", 28)) * max(0.5, scale))
    color = _hex_to_ass_bgra(st.get("color", "#FFFFFF"))
    position = (st.get("position") or "bottom").lower()
    align, marginv = (2, 36) if position == "bottom" else (8, int(60 * max(0.5, scale)))
    header = _ASS_HEADER.format(
        width=width, height=height, fontsize=fontsize,
        color=color, align=align, marginv=marginv,
    )
    lines = [header]
    for s in subtitles:
        text = str(s.get("text") or "").strip().replace("\n", "\\N")
        if not text:
            continue
        lines.append(
            f"Dialogue: 0,{_ass_time(s.get('start', 0))},{_ass_time(s.get('end', 0))},"
            f"Default,0,0,0,,{text}"
        )
    return "\n".join(lines) + "\n"


def normalize_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    """校验并补全剪辑配置（render 与保存共用的单一校验入口）。"""
    cfg = raw if isinstance(raw, dict) else {}
    # 分辨率：预设名或 {width,height}
    res = cfg.get("resolution") or "720p"
    if isinstance(res, str):
        if res not in RESOLUTION_PRESETS:
            res = "720p"
        width, height = RESOLUTION_PRESETS[res]
    else:
        width = int(res.get("width") or 1280)
        height = int(res.get("height") or 720)
        # 防御：限制在合理范围且为偶数（x264 要求）
        width = max(160, min(3840, width - width % 2))
        height = max(160, min(2160, height - height % 2))

    clips = []
    for c in (cfg.get("clips") or []):
        url = str(c.get("url") or "").strip()
        if not url:
            continue
        clips.append({
            "id": str(c.get("id") or uuidlib.uuid4().hex[:8]),
            "url": url,
            "name": str(c.get("name") or url.split("/")[-1])[:80],
            "in": max(0.0, float(c.get("in") or 0.0)),
            "out": float(c["out"]) if c.get("out") is not None else None,
            "volume": max(0.0, min(2.0, float(c.get("volume") if c.get("volume") is not None else 1.0))),
        })
    if not clips:
        raise ValueError("至少需要一个视频片段")

    audio_cfg = cfg.get("audio") or {}
    volume = max(0.0, min(2.0, float(audio_cfg.get("volume") if audio_cfg.get("volume") is not None else 1.0)))
    bgm_raw = audio_cfg.get("bgm") or None
    bgm = None
    if bgm_raw and str(bgm_raw.get("url") or "").strip():
        bgm = {
            "url": str(bgm_raw["url"]).strip(),
            "volume": max(0.0, min(2.0, float(bgm_raw.get("volume") if bgm_raw.get("volume") is not None else 0.3))),
            "fade_in": max(0.0, min(10.0, float(bgm_raw.get("fade_in") or 0.0))),
            "fade_out": max(0.0, min(10.0, float(bgm_raw.get("fade_out") or 0.0))),
        }

    subtitles = []
    for s in (cfg.get("subtitles") or []):
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        start, end = float(s.get("start") or 0), float(s.get("end") or 0)
        if end <= start:
            end = start + 1.0
        subtitles.append({"id": str(s.get("id") or uuidlib.uuid4().hex[:8]),
                          "start": start, "end": end, "text": text[:120]})

    return {
        "version": 1,
        "resolution": {"width": width, "height": height},
        "clips": clips,
        "audio": {"volume": volume, "bgm": bgm},
        "subtitles": subtitles,
        "subtitle_style": {
            "font_size": int(cfg.get("subtitle_style", {}).get("font_size", 28) or 28),
            "color": str(cfg.get("subtitle_style", {}).get("color") or "#FFFFFF"),
            "position": str(cfg.get("subtitle_style", {}).get("position") or "bottom"),
        },
    }


async def render_edit(config: Dict[str, Any], progress_cb=None) -> Tuple[str, float]:
    """执行合成，返回 (本地 /uploads URL, 总时长秒)。

    progress_cb(stage_pct, message) 供任务进度更新（10→90）。
    """
    cfg = normalize_config(config)
    width, height = cfg["resolution"]["width"], cfg["resolution"]["height"]

    def _p(pct: int, msg: str):
        if progress_cb:
            progress_cb(pct, msg)

    tmpdir = tempfile.mkdtemp(prefix="sg_edit_")
    try:
        # ---- 1. 素材解析（本地直取 / 下载） ----
        clip_srcs: List[str] = []
        for i, c in enumerate(cfg["clips"]):
            local = _resolve_local_path(c["url"])
            if local is None:
                if c["url"].startswith(("http://", "https://")):
                    _p(10 + i * 2, f"下载素材 {c['name']}")
                    dest = os.path.join(tmpdir, f"src_{i}{os.path.splitext(c['url'])[1][:5] or '.mp4'}")
                    local = await asyncio.to_thread(_download_to, c["url"], dest)
                else:
                    raise ValueError(f"素材不可访问: {c['name']}")
            clip_srcs.append(local)

        # ---- 2. 逐片段归一化（裁剪 + 缩放留边 + 统一编码 + 片段音量） ----
        norm_files: List[str] = []
        total_dur = 0.0
        for i, (c, src) in enumerate(zip(cfg["clips"], clip_srcs)):
            dur_src = _probe_duration(src) or 0.0
            t_in = c["in"]
            t_out = c["out"] if (c["out"] and c["out"] > t_in) else dur_src
            if dur_src and t_out > dur_src:
                t_out = dur_src
            seg = max(0.1, (t_out - t_in) if (t_out and t_in is not None) else dur_src or 1.0)
            total_dur += seg
            out_i = os.path.join(tmpdir, f"clip_{i:03d}.mp4")
            _p(20 + int(i / max(1, len(clip_srcs)) * 40), f"处理片段 {i + 1}/{len(clip_srcs)}: {c['name']}")
            vf = (
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                f"setsar=1,fps=30"
            )
            pre = ["-ss", f"{t_in:.3f}", "-to", f"{t_out:.3f}", "-i", src]
            if _probe_has_audio(src):
                encode = ["-vf", vf, "-af", f"volume={c['volume']:.2f}"]
                maps = []
            else:
                # 无音轨：补静音轨（concat 要求各片段流结构一致）
                pre += ["-f", "lavfi", "-t", f"{seg:.3f}", "-i", "anullsrc=r=44100:cl=stereo"]
                encode = ["-vf", vf]
                maps = ["-map", "0:v", "-map", "1:a"]
            await asyncio.to_thread(
                _run_ffmpeg,
                pre + encode + maps +
                ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                 "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-ar", "44100", "-ac", "2",
                 "-t", f"{seg:.3f}",
                 out_i],
                f"clip#{i}",
            )
            norm_files.append(out_i)

        # ---- 3. concat 拼接 ----
        _p(65, "拼接片段")
        list_file = os.path.join(tmpdir, "concat.txt")
        with open(list_file, "w", encoding="utf-8") as f:
            for p in norm_files:
                f.write(f"file '{p}'\n")
        concat_out = os.path.join(tmpdir, "concat.mp4")
        await asyncio.to_thread(
            _run_ffmpeg,
            ["-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", concat_out],
            "concat",
        )

        # ---- 4. 终混：BGM 混音 + 字幕烧录（单命令完成） ----
        _p(78, "混音与字幕")
        bgm = cfg["audio"]["bgm"]
        need_audio_mix = bgm is not None or abs(cfg["audio"]["volume"] - 1.0) > 1e-3
        need_subs = bool(cfg["subtitles"])

        final_in = concat_out
        if need_audio_mix or need_subs:
            args: List[str] = ["-i", concat_out]
            filters: List[str] = []
            map_args: List[str] = []

            if need_audio_mix:
                main_vol = cfg["audio"]["volume"]
                audio_chain = f"[0:a]volume={main_vol:.2f}[va]"
                filters.append(audio_chain)
                if bgm:
                    bgm_local = _resolve_local_path(bgm["url"])
                    if bgm_local is None:
                        if not bgm["url"].startswith(("http://", "https://")):
                            raise ValueError("BGM 素材不可访问")
                        bgm_local = os.path.join(tmpdir, "bgm" + os.path.splitext(bgm["url"])[1][:5])
                        await asyncio.to_thread(_download_to, bgm["url"], bgm_local)
                    args += ["-stream_loop", "-1", "-i", bgm_local]  # 循环铺满片长
                    fades = []
                    if bgm["fade_in"] > 0:
                        fades.append(f"afade=t=in:st=0:d={bgm['fade_in']:.2f}")
                    if bgm["fade_out"] > 0:
                        fades.append(f"afade=t=out:st={max(0.0, total_dur - bgm['fade_out']):.2f}:d={bgm['fade_out']:.2f}")
                    bgm_chain = f"[1:a]volume={bgm['volume']:.2f}"
                    if fades:
                        bgm_chain += "," + ",".join(fades)
                    bgm_chain += "[ba]"
                    filters.append(bgm_chain)
                    filters.append("[va][ba]amix=inputs=2:duration=first:dropout_transition=0[aout]")
                    map_args = ["-map", "0:v", "-map", "[aout]"]
                else:
                    map_args = ["-map", "0:v", "-map", "[va]"]

            if need_subs:
                ass_path = os.path.join(tmpdir, "subs.ass")
                with open(ass_path, "w", encoding="utf-8") as f:
                    f.write(build_ass_subtitles(cfg["subtitles"], cfg["subtitle_style"], width, height))
                if not map_args:
                    map_args = ["-map", "0:v", "-map", "0:a?"]
                vf_ass = f"ass={ass_path.replace(chr(92), '/')}"
                filters.insert(0, f"[0:v]{vf_ass}[vout]" if need_audio_mix else vf_ass)
                if need_audio_mix:
                    map_args = ["-map", "[vout]"] + map_args[2:]

            final_out = os.path.join(tmpdir, "final.mp4")
            _p(85, "合成输出")
            if need_audio_mix:
                await asyncio.to_thread(
                    _run_ffmpeg,
                    args + ["-filter_complex", ";".join(filters)] + map_args +
                    ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                     "-c:a", "aac", "-ar", "44100", "-ac", "2", "-t", f"{total_dur:.3f}", final_out],
                    "final-mix",
                )
            else:
                await asyncio.to_thread(
                    _run_ffmpeg,
                    ["-i", concat_out, "-vf", filters[0],
                     "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                     "-c:a", "copy", final_out],
                    "final-subs",
                )
            final_in = final_out

        # ---- 5. 落盘 uploads ----
        _p(92, "保存成片")
        from app.services.storage import get_storage_singleton
        with open(final_in, "rb") as f:
            data = f.read()
        stored = await get_storage_singleton().save(data, "edited.mp4", "video/mp4", "video")
        _p(96, "完成")
        return stored.url, total_dur
    finally:
        # 清理临时目录（best effort）
        try:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass
