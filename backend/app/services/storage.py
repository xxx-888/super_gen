"""
Storage Service - 文件存储抽象与本地实现

设计:
- StorageBackend: 统一接口 (save / delete / url_for)
- LocalStorage: 落盘到 STORAGE_LOCAL_PATH, 返回 /uploads/... 静态URL
- OssStorage: 预留骨架 (生产环境接入阿里云OSS/S3)

M1 仅实现 LocalStorage; 通过 STORAGE_TYPE 配置切换.
"""
import os
import uuid as uuidlib
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional, Tuple

import aiofiles
from PIL import Image

from app.core.config import settings
from app.core.exceptions import FileUploadException

# 上传扩展名白名单（按类别）——用户可控的原始扩展名不直接采信，
# 防止把 .svg/.html 等可执行脚本载体写进 /uploads 造成存储型 XSS
_EXT_WHITELIST = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".gif"},
    "video": {".mp4", ".webm", ".mov", ".mkv"},
    "audio": {".mp3", ".wav", ".aac", ".m4a", ".ogg"},
    "file": {".txt", ".fdx", ".fountain", ".md"},
}


class StoredFile:
    """存储结果"""
    def __init__(self, url: str, filename: str, size: int, mime_type: str,
                 category: str, width: Optional[int] = None,
                 height: Optional[int] = None, duration: Optional[float] = None):
        self.url = url
        self.filename = filename
        self.size = size
        self.mime_type = mime_type
        self.category = category  # image/video/audio
        self.width = width
        self.height = height
        self.duration = duration


class StorageBackend(ABC):
    """存储后端抽象基类"""

    @abstractmethod
    async def save(self, data: bytes, filename: str, mime_type: str,
                   category: str) -> StoredFile:
        """保存文件, 返回存储结果"""
        ...

    @abstractmethod
    async def delete(self, url: str) -> None:
        """删除文件"""
        ...


class LocalStorage(StorageBackend):
    """本地文件存储"""

    def __init__(self):
        self.base_path = settings.STORAGE_LOCAL_PATH
        self.base_url = "/uploads"  # 由 main.py 挂载静态目录
        os.makedirs(self.base_path, exist_ok=True)

    def _category_dir(self, category: str) -> str:
        return os.path.join(self.base_path, category)

    async def save(self, data: bytes, filename: str, mime_type: str,
                   category: str) -> StoredFile:
        # 按日期分目录: uploads/image/2026/08/uuid.ext
        now = datetime.utcnow()
        subdir = os.path.join(category, str(now.year), f"{now.month:02d}")
        abs_subdir = os.path.join(self.base_path, subdir)
        os.makedirs(abs_subdir, exist_ok=True)

        # 扩展名白名单：用户可控的文件名扩展不直接采信（防上传 .svg/.html
        # 之类的脚本载体到 /uploads 造成存储型 XSS），不在白名单回落为
        # 按 MIME/类别推导的安全扩展名
        ext = (os.path.splitext(filename)[1] or "").lower()
        if ext not in _EXT_WHITELIST.get(category, set()):
            ext = _default_ext(mime_type, category)
        stored_name = f"{uuidlib.uuid4().hex}{ext}"
        abs_path = os.path.join(abs_subdir, stored_name)

        async with aiofiles.open(abs_path, "wb") as f:
            await f.write(data)

        rel_url = f"{self.base_url}/{subdir}/{stored_name}".replace("\\", "/")

        width = height = duration = None
        if category == "image":
            try:
                async with aiofiles.open(abs_path, "rb") as f:
                    img_bytes = await f.read()
                from io import BytesIO
                with Image.open(BytesIO(img_bytes)) as img:
                    width, height = img.size
            except Exception:
                pass

        return StoredFile(
            url=rel_url, filename=stored_name, size=len(data),
            mime_type=mime_type, category=category,
            width=width, height=height, duration=duration,
        )

    async def delete(self, url: str) -> None:
        if url.startswith(self.base_url):
            rel = url[len(self.base_url):].lstrip("/")
            abs_path = os.path.join(self.base_path, rel)
            if os.path.exists(abs_path):
                os.remove(abs_path)


def _default_ext(mime_type: str, category: str) -> str:
    exts = {
        "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
        "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm",
        "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg",
    }
    return exts.get(mime_type, f".{category}")


def get_storage() -> StorageBackend:
    """根据配置获取存储后端 (M1: 仅 local)"""
    storage_type = settings.STORAGE_TYPE
    if storage_type == "local":
        return LocalStorage()
    # oss/minio/s3/cos 预留: 后续实现 OssStorage
    # 当前统一回退到 local, 保证可用
    return LocalStorage()


# 单例 (无状态)
_storage_singleton: Optional[StorageBackend] = None


def get_storage_singleton() -> StorageBackend:
    """获取存储单例"""
    global _storage_singleton
    if _storage_singleton is None:
        _storage_singleton = get_storage()
    return _storage_singleton
