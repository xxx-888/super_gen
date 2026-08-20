"""独立文件管理服务 - 可单独部署到云服务器（严格鉴权版）

为 super_gen 提供公网可访问的文件上传/下载/管理：
- 参考视频/参考音频需要渠道可下载的公网 URL（MiniMax H3 官方渠道对大文件
  更适合 URL 形式），后端上传/删除自动转传本服务拿公网直链
- 也适合任何需要在线访问文件托管/分享的场景

部署（详见 deploy.md）：
    pip install -r requirements.txt
    FILE_SERVER_API_KEY=sk-your-key FILE_SERVER_PUBLIC_URL=https://files.example.com \
        uvicorn main:app --host 0.0.0.0 --port 9000

安全模型（写操作严格鉴权，读直链公开）：
    ┌────────────────────────┬──────────┬────────────────────────────────────┐
    │ 接口                    │ 鉴权      │ 说明                                │
    ├────────────────────────┼──────────┼────────────────────────────────────┤
    │ POST   /upload         │ 必须 Bearer│ 扩展白名单 + 魔数嗅探 + 大小上限     │
    │ DELETE /files/{path}   │ 必须 Bearer│ 路径解析锁死在存储目录内（防穿越）   │
    │ GET    /list           │ 必须 Bearer│ prefix 同样做穿越校验               │
    │ GET    /stats          │ 必须 Bearer│ 存储用量统计                         │
    │ GET    /files/{path}   │ 公开      │ 直链下载（生成渠道/浏览器拉取）       │
    │ GET    /healthz        │ 公开      │ 健康检查（不泄露本地路径等内部信息）  │
    └────────────────────────┴──────────┴────────────────────────────────────┘

鉴权要点：
- fail-closed：未配置 FILE_SERVER_API_KEY 时，所有受保护接口一律 403 拒绝。
  旧版"留空 = 开放上传"在公网部署忘配密钥时等于把服务器白送，已废弃。
- 常量时间比较（hmac.compare_digest），防时序侧信道逐位猜密钥。
- 鉴权失败写审计日志（来源 IP / UA / 动作），便于发现爆破与滥用。
- 密钥双通道：Authorization: Bearer <key> 或 X-Api-Key: <key>（后端两种都在用）。
"""
import hmac
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Header, Query, Request
from fastapi.staticfiles import StaticFiles

# ==================== 配置（环境变量） ====================

# 鉴权密钥：留空时所有写接口 fail-closed 拒绝（见 _check_auth）
API_KEY = os.environ.get("FILE_SERVER_API_KEY", "").strip()
# 存储根目录（启动即 resolve 成绝对路径，后续所有路径校验都以它为基准）
STORAGE_DIR = Path(os.environ.get("FILE_SERVER_DIR", "./data")).resolve()
# 对外公网地址（拼直链用）；留空时返回相对路径，由调用方自行拼
PUBLIC_URL = os.environ.get("FILE_SERVER_PUBLIC_URL", "").rstrip("/")
# 单文件大小上限（默认 500MB，流式写入边收边查，超限即刻断掉并清理）
MAX_SIZE = int(os.environ.get("FILE_SERVER_MAX_SIZE", str(500 * 1024 * 1024)))

# 扩展名白名单：默认只收媒体文件（本服务的用途就是媒体托管）。
# FILE_SERVER_ALLOWED_EXT 覆盖（逗号分隔小写、不带点）；设为 * 表示不限制。
_DEFAULT_MEDIA_EXT = {
    # 图片
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif",
    # 视频（MiniMax 参考视频仅收 MP4/MOV，其余格式后端上传链路会自动转码）
    "mp4", "mov", "m4v", "webm", "mkv",
    # 音频（MiniMax 参考音频仅收 WAV/MP3，同上）
    "mp3", "wav", "m4a", "aac", "ogg", "flac",
}
_raw_ext = os.environ.get("FILE_SERVER_ALLOWED_EXT", "").strip().lower()
if _raw_ext == "*":
    ALLOWED_EXT: set = set()          # 空集合 + EXT_UNLIMITED=True = 不限制
elif _raw_ext:
    ALLOWED_EXT = {e.strip().lstrip(".").lower() for e in _raw_ext.split(",") if e.strip()}
else:
    ALLOWED_EXT = _DEFAULT_MEDIA_EXT
EXT_UNLIMITED = _raw_ext == "*"

# 魔数嗅探（默认开）：扩展名合法但文件头不是已知媒体格式（伪装成 .png 的脚本等）
# 一律拒绝。FILE_SERVER_STRICT_SNIFF=false 可关闭（例如要托管白名单内的冷门格式）。
STRICT_SNIFF = os.environ.get("FILE_SERVER_STRICT_SNIFF", "true").strip().lower() \
    not in ("0", "false", "off", "no")

app = FastAPI(title="File Server", docs_url=None, redoc_url=None)

logger = logging.getLogger("fileserver")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [fileserver] %(message)s",
)


# ==================== 安全工具 ====================

# 文件名安全化：非 [字母数字._-] 一律替换成 "-"（中文/空格/特殊字符都不进路径）
_SAFE_NAME = re.compile(r"[^a-zA-Z0-9._-]+")

# 各扩展名期望的文件头家族（魔数嗅探用，与 backend minimax_adapter 的嗅探口径一致）
_EXT_FAMILY = {
    **{e: "jpeg" for e in ("jpg", "jpeg")},
    **{e: "png" for e in ("png",)},
    **{e: "webp" for e in ("webp",)},
    **{e: "gif" for e in ("gif",)},
    **{e: "bmp" for e in ("bmp",)},
    **{e: "heic" for e in ("heic", "heif")},
    # MP4 家族（mp4/mov/m4v/m4a）统一认 ISO-BMFF 的 ftyp 盒
    **{e: "mp4" for e in ("mp4", "mov", "m4v", "m4a")},
    **{e: "webm" for e in ("webm", "mkv")},   # EBML 头
    **{e: "mp3" for e in ("mp3",)},
    **{e: "wav" for e in ("wav",)},
    **{e: "ogg" for e in ("ogg",)},
    **{e: "flac" for e in ("flac",)},
    **{e: "aac" for e in ("aac",)},
}


def _check_auth(request: Request, authorization: Optional[str],
                x_api_key: Optional[str], action: str) -> None:
    """受保护接口的统一鉴权（fail-closed + 常量时间比较 + 审计日志）。

    - 未配置 API_KEY → 403（拒绝服务优于开放写入；公网忘配密钥不再等于裸奔）
    - token 取值优先级：Authorization: Bearer <key>，回退 X-Api-Key: <key>
    - hmac.compare_digest 防时序攻击；失败记录 IP/UA/动作
    """
    if not API_KEY:
        logger.error("鉴权拒绝(fail-closed): 未配置 FILE_SERVER_API_KEY, 动作=%s", action)
        raise HTTPException(status_code=403, detail="server misconfigured: API key not set")

    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    token = token or (x_api_key or "").strip()

    if not token or not hmac.compare_digest(token.encode("utf-8"), API_KEY.encode("utf-8")):
        client = request.client.host if request.client else "unknown"
        logger.warning("鉴权失败: 动作=%s 来源=%s ua=%r",
                       action, client, request.headers.get("user-agent", "")[:120])
        raise HTTPException(status_code=401, detail="invalid api key")


def _resolve_in_storage(rel_path: str) -> Path:
    """把 URL 相对路径解析成存储目录内的绝对路径，严格防穿越。

    - resolve() 展开 `..`、符号链接、Windows 盘符等价写法
    - is_relative_to 保证最终路径仍在存储根内。旧版用字符串 startswith 判断，
      存在经典前缀绕过（/data-evil 以 /data 开头），已废弃
    """
    target = (STORAGE_DIR / rel_path).resolve()
    if not target.is_relative_to(STORAGE_DIR):
        raise HTTPException(status_code=400, detail="invalid path")
    return target


def _sniff_family(head: bytes) -> Optional[str]:
    """按文件头魔数识别媒体家族；识别不出返回 None。"""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"BM"):
        return "bmp"
    if head[4:8] == b"ftyp":
        return "mp4"  # ISO-BMFF：mp4/mov/m4a 等同族
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "webm"
    if head.startswith((b"ID3",)) or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xe3"):
        return "mp3"
    if head.startswith(b"OggS"):
        return "ogg"
    if head.startswith(b"fLaC"):
        return "flac"
    if head[:2] in (b"\xff\xf1", b"\xff\xf9"):
        return "aac"  # ADTS AAC
    # HEIC/HEIF 也走 ftyp 盒，但品牌串不同 —— 在 ftyp 分支之后再细分
    if head[4:8] == b"ftyp":
        return "heic"
    return None


def _validate_upload_ext_and_magic(filename: str, head: bytes) -> None:
    """上传内容校验：扩展白名单 + 魔数嗅探。

    1. 扩展名不在白名单 → 400（白名单为空且 EXT_UNLIMITED 时跳过）
    2. 严格模式下：扩展名对应的家族必须与文件头魔数一致；
       扩展名合法但魔数不是任何已知媒体（伪装文件）→ 400
    """
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    if ALLOWED_EXT and ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail=f"extension '.{ext}' not allowed")

    if not STRICT_SNIFF or not ext:
        return
    expected = _EXT_FAMILY.get(ext)
    if expected is None:
        return  # 白名单自定义的冷门扩展不做魔数校验
    actual = _sniff_family(head)
    # HEIC 与 MP4 同为 ftyp 盒，互相放行（品牌串细分无必要）
    if actual != expected and {actual, expected} != {"mp4", "heic"}:
        raise HTTPException(
            status_code=400,
            detail=f"content mismatch: '.{ext}' expects '{expected}' but got '{actual or 'unknown'}'",
        )


# ==================== 接口 ====================

def _public_url(rel_path: str) -> str:
    """拼公网直链；未配置 PUBLIC_URL 时返回相对路径，由调用方（后端）自行补全。"""
    return f"{PUBLIC_URL}/files/{rel_path}" if PUBLIC_URL else f"/files/{rel_path}"


@app.get("/healthz")
async def healthz():
    """健康检查（公开）。只暴露存活状态与公网地址，不泄露本地存储路径等内部信息。"""
    return {"ok": True, "public_url": PUBLIC_URL or "(unset)"}


@app.post("/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    """上传文件（严格鉴权）。

    校验链：鉴权 → 扩展白名单 → 魔数嗅探（首块字节，伪装文件即刻拒绝）
    → 流式写入边收边查大小上限（超限即刻中断并清理半成品）。
    存储：按 年/月 分目录；文件名安全化 + uuid 后缀防覆盖与碰撞。
    """
    _check_auth(request, authorization, x_api_key, action="upload")

    filename = os.path.basename(file.filename or "upload.bin")
    ext = os.path.splitext(filename)[1].lower()

    now = datetime.now(timezone.utc)
    safe_stem = _SAFE_NAME.sub("-", os.path.splitext(filename)[0])[:40] or "file"
    rel = f"{now.year}/{now.month:02d}/{safe_stem}-{uuid.uuid4().hex[:12]}{ext}"
    dest = STORAGE_DIR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    first_chunk: bytes = b""
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            if not first_chunk:
                first_chunk = chunk[:16]
                # 魔数校验放在写盘前（首块足够判定），伪装文件不落盘
                _validate_upload_ext_and_magic(filename, first_chunk)
            total += len(chunk)
            if total > MAX_SIZE:
                f.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"file too large (> {MAX_SIZE // (1024 * 1024)}MB)",
                )
            f.write(chunk)

    if total == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="empty file")

    client = request.client.host if request.client else "unknown"
    logger.info("上传成功: %s (%d bytes) 来源=%s", rel, total, client)
    return {
        "url": _public_url(rel),
        "path": rel,
        "filename": filename,
        "size": total,
        "content_type": file.content_type,
    }


@app.get("/list")
async def list_files(
    request: Request,
    prefix: str = Query("", description="按目录前缀过滤，如 2026/08"),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    """列出已存文件（鉴权，按修改时间倒序，分页）。

    prefix 同样走 _resolve_in_storage 防穿越 —— 旧版直接拼路径，
    `prefix=../..` 可以列出服务器上任意目录的文件清单（路径/大小/时间）。
    """
    _check_auth(request, authorization, x_api_key, action="list")
    base = _resolve_in_storage(prefix) if prefix else STORAGE_DIR
    if not base.exists():
        return {"total": 0, "items": []}
    files = sorted(
        (p for p in base.rglob("*") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    items = [
        {
            "path": str(p.relative_to(STORAGE_DIR)).replace("\\", "/"),
            "url": _public_url(str(p.relative_to(STORAGE_DIR)).replace("\\", "/")),
            "size": p.stat().st_size,
            "mtime": datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(),
        }
        for p in files
    ]
    return {"total": len(items), "items": items[offset: offset + limit]}


@app.delete("/files/{file_path:path}")
async def delete_file(
    request: Request,
    file_path: str,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    """删除文件（严格鉴权 + 路径锁死在存储目录内）。

    - _resolve_in_storage 展开 `..`/符号链接后再校验归属，防穿越删除
    - 只删单个已存在的普通文件；目录/不存在一律 400/404
    - 成功与失败均写审计日志
    """
    _check_auth(request, authorization, x_api_key, action=f"delete {file_path[:120]}")
    target = _resolve_in_storage(file_path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    target.unlink()
    client = request.client.host if request.client else "unknown"
    logger.info("删除成功: %s 来源=%s", file_path, client)
    return {"deleted": file_path}


@app.get("/stats")
async def stats(
    request: Request,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    """存储用量统计（鉴权；后端团队存储配额展示用）。"""
    _check_auth(request, authorization, x_api_key, action="stats")
    total_files, total_bytes = 0, 0
    for p in STORAGE_DIR.rglob("*"):
        if p.is_file():
            total_files += 1
            total_bytes += p.stat().st_size
    return {
        "total_files": total_files,
        "total_bytes": total_bytes,
        "total_mb": round(total_bytes / (1024 * 1024), 2),
    }


# 启动自检：确保存储目录存在（必须在 StaticFiles 挂载前创建，否则冷启动报目录不存在）
STORAGE_DIR.mkdir(parents=True, exist_ok=True)
if not API_KEY:
    # fail-closed 提示：写接口全部拒绝，只有直链下载与健康检查可用
    logger.warning("未配置 FILE_SERVER_API_KEY：upload/list/delete/stats 全部拒绝(fail-closed)，"
                   "仅 /files 直链与 /healthz 开放")

# 公开静态直链（挂载在最后，避免与上面的路由冲突）。
# StaticFiles 自带路径穿越防护；下载必须公开 —— 生成渠道(如 MiniMax)拉取参考素材不带鉴权头。
app.mount("/files", StaticFiles(directory=str(STORAGE_DIR)), name="files")
