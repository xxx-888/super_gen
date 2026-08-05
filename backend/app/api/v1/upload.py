"""
Upload API - 文件上传接口
"""
from typing import List
from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.config import settings
from app.core.exceptions import FileUploadException, BadRequestException
from app.models import User, Organization
from app.api.deps import get_current_org
from app.schemas import FileUploadResponse
from app.services.storage import get_storage_singleton

router = APIRouter()

# 允许的 MIME 与大小上限映射
_CATEGORY_CONFIG = {
    "image": settings.ALLOWED_IMAGE_TYPES,
    "video": settings.ALLOWED_VIDEO_TYPES,
    "audio": settings.ALLOWED_AUDIO_TYPES,
}


async def _save(file: UploadFile, category: str) -> FileUploadResponse:
    allowed = _CATEGORY_CONFIG.get(category, [])
    if file.content_type not in allowed:
        raise BadRequestException(
            f"Unsupported {category} type: {file.content_type}. Allowed: {allowed}"
        )

    data = await file.read()
    if len(data) > settings.MAX_UPLOAD_SIZE:
        raise FileUploadException(
            f"File too large: {len(data)} bytes > {settings.MAX_UPLOAD_SIZE}"
        )

    storage = get_storage_singleton()
    stored = await storage.save(
        data=data,
        filename=file.filename or f"upload.{category}",
        mime_type=file.content_type,
        category=category,
    )
    return FileUploadResponse(
        url=stored.url,
        filename=stored.filename,
        size=stored.size,
        mime_type=stored.mime_type,
        category=stored.category,
        width=stored.width,
        height=stored.height,
        duration=stored.duration,
    )


@router.post("/image", response_model=FileUploadResponse)
async def upload_image(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """上传图片"""
    return await _save(file, "image")


@router.post("/video", response_model=FileUploadResponse)
async def upload_video(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """上传视频"""
    return await _save(file, "video")


@router.post("/audio", response_model=FileUploadResponse)
async def upload_audio(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """上传音频"""
    return await _save(file, "audio")
