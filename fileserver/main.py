"""独立文件管理服务 - 可单独部署到云服务器

为 super_gen 提供公网可访问的文件上传/下载/管理：
- 参考视频/参考音频需要渠道可下载的公网 URL（MiniMax H3 渠道不收 base64），
  上传到本服务即得公网直链
- 也适合任何需要在线访问文件托管/分享的场景

部署（见 deploy.md）：
    pip install -r requirements.txt
    FILE_SERVER_API_KEY=sk-your-key FILE_SERVER_PUBLIC_URL=https://files.example.com uvicorn main:app --host 0.0.0.0 --port 9000

接口：
    POST   /upload              上传文件（鉴权）→ {url, filename, size}
    GET    /files/{path}        下载/直链访问（公开，供渠道/浏览器拉取）
    GET    /list                文件列表（鉴权，分页）
    DELETE /files/{path}        删除文件（鉴权）
    GET    /healthz             健康检查
"""
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Header, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

API_KEY = os.environ.get("FILE_SERVER_API_KEY", "")
STORAGE_DIR = Path(os.environ.get("FILE_SERVER_DIR", "./data"))
PUBLIC_URL = os.environ.get("FILE_SERVER_PUBLIC_URL", "").rstrip("/")
MAX_SIZE = int(os.environ.get("FILE_SERVER_MAX_SIZE", str(500 * 1024 * 1024)))  # 500MB

app = FastAPI(title="File Server", docs_url=None, redoc_url=None)

# 允许的扩展名（留空 = 不限制）
ALLOWED_EXT = set(
    e.strip() for e in os.environ.get("FILE_SERVER_ALLOWED_EXT", "").split(",") if e.strip()
)

_SAFE_NAME = re.compile(r"[^a-zA-Z0-9._-]+")


def _check_auth(authorization: Optional[str], x_api_key: Optional[str]) -> None:
    if not API_KEY:
        return  # 未配置鉴权 = 开放上传（仅内网/测试用）
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    token = token or x_api_key
    if token != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


def _public_url(rel_path: str) -> str:
    return f"{PUBLIC_URL}/files/{rel_path}"


@app.get("/healthz")
async def healthz():
    return {"ok": True, "storage": str(STORAGE_DIR), "public_url": PUBLIC_URL or "(unset)"}


@app.post("/upload")
async def upload(
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    """上传文件，按 年/月 分目录存储，返回公网直链。同名安全化 + uuid 防覆盖。"""
    _check_auth(authorization, x_api_key)

    filename = os.path.basename(file.filename or "upload.bin")
    ext = os.path.splitext(filename)[1].lower()
    if ALLOWED_EXT and ext.lstrip(".") not in ALLOWED_EXT:
        raise HTTPException(400, f"extension '{ext}' not allowed")

    now = datetime.utcnow()
    safe_stem = _SAFE_NAME.sub("-", os.path.splitext(filename)[0])[:40] or "file"
    rel = f"{now.year}/{now.month:02d}/{safe_stem}-{uuid.uuid4().hex[:12]}{ext}"
    dest = STORAGE_DIR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_SIZE:
                f.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"file too large (> {MAX_SIZE // (1024 * 1024)}MB)")
            f.write(chunk)

    return {
        "url": _public_url(rel),
        "path": rel,
        "filename": filename,
        "size": total,
        "content_type": file.content_type,
    }


@app.get("/list")
async def list_files(
    prefix: str = Query("", description="按目录前缀过滤，如 2026/08"),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    """列出已存文件（按修改时间倒序）。"""
    _check_auth(authorization, x_api_key)
    base = STORAGE_DIR / prefix if prefix else STORAGE_DIR
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
            "mtime": datetime.utcfromtimestamp(p.stat().st_mtime).isoformat(),
        }
        for p in files
    ]
    return {"total": len(items), "items": items[offset: offset + limit]}


@app.delete("/files/{file_path:path}")
async def delete_file(
    file_path: str,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    _check_auth(authorization, x_api_key)
    target = (STORAGE_DIR / file_path).resolve()
    if not str(target).startswith(str(STORAGE_DIR.resolve())):
        raise HTTPException(400, "invalid path")
    if not target.is_file():
        raise HTTPException(404, "not found")
    target.unlink()
    return {"deleted": file_path}


@app.get("/stats")
async def stats(
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    _check_auth(authorization, x_api_key)
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


# 启动时确保存储目录存在（必须在 StaticFiles 挂载前创建，否则冷启动报目录不存在）
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# 公开静态直链（挂载在最后，避免与上面的路由冲突）
app.mount("/files", StaticFiles(directory=str(STORAGE_DIR)), name="files")
