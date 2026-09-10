"""
Upload API - 文件上传接口
"""
from typing import List
from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.config import settings
from app.core.exceptions import FileUploadException, BadRequestException, ForbiddenException
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

# 通用上传日配额（每用户）：文件数与字节数双限，防滥用刷存储。
# 素材库（materials）另有团队存储配额；此入口此前完全无限制。
UPLOAD_DAILY_FILE_LIMIT = 300
UPLOAD_DAILY_BYTES_LIMIT = 5 * 1024 * 1024 * 1024  # 5GB/天


async def _check_and_record_quota(user_id, size: int) -> None:
    """Redis 每用户日配额：当天累计文件数/字节数超限即拒。

    Redis 异常时放行（fail-open，与登录锁定策略一致）；先记后存失败
    也只影响计数偏大，不做回滚。
    """
    from datetime import date
    from app.core.redis import get_redis
    try:
        r = get_redis()
        if r is None:
            return
        day = date.today().isoformat()
        cnt_key = f"upload:cnt:{user_id}:{day}"
        bytes_key = f"upload:bytes:{user_id}:{day}"
        cnt = int(await r.get(cnt_key) or 0)
        used = int(await r.get(bytes_key) or 0)
        if cnt >= UPLOAD_DAILY_FILE_LIMIT:
            raise ForbiddenException(f"今日上传文件数已达上限（{UPLOAD_DAILY_FILE_LIMIT} 个/天）")
        if used + size > UPLOAD_DAILY_BYTES_LIMIT:
            raise ForbiddenException("今日上传流量已达上限（5GB/天），请明天再试或清理后使用素材库")
        pipe = r.pipeline()
        pipe.incrby(cnt_key, 1)
        pipe.incrby(bytes_key, size)
        pipe.expire(cnt_key, 90000)
        pipe.expire(bytes_key, 90000)
        await pipe.execute()
    except ForbiddenException:
        raise
    except Exception:
        return  # Redis 不可用时放行


async def _save(file: UploadFile, category: str, normalize: bool = True, user_id=None) -> FileUploadResponse:
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

    if user_id is not None:
        await _check_and_record_quota(user_id, len(data))

    # 统一存储入口：配置文件服务器后视频/音频/图片自动转传云端；
    # 双写开关（后台设置，默认开）控制本地是否另存一份。转传失败一律降级本地。
    from app.services.file_server import store_media
    final_url, local_stored = await store_media(
        data, file.filename or f"upload.{category}", file.content_type, category,
        normalize=normalize)

    return FileUploadResponse(
        url=final_url,
        filename=file.filename or f"upload.{category}",
        size=local_stored.size if local_stored else len(data),
        mime_type=file.content_type,
        width=local_stored.width if local_stored else None,
        height=local_stored.height if local_stored else None,
        duration=local_stored.duration if local_stored else None,
    )


@router.post("/image", response_model=FileUploadResponse)
async def upload_image(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """上传图片"""
    return await _save(file, "image", user_id=current_user.id)


@router.post("/video", response_model=FileUploadResponse)
async def upload_video(
    file: UploadFile = File(...),
    skip_normalize: bool = False,
    current_user: User = Depends(get_current_user),
):
    """上传视频。skip_normalize=true 保留完整素材（剪辑器导入用，
    默认走参考素材规范化：超 15s 截前 15s + 转码合规格式）"""
    return await _save(file, "video", normalize=not skip_normalize, user_id=current_user.id)


@router.post("/audio", response_model=FileUploadResponse)
async def upload_audio(
    file: UploadFile = File(...),
    skip_normalize: bool = False,
    current_user: User = Depends(get_current_user),
):
    """上传音频。skip_normalize=true 保留完整素材（剪辑器导入用）"""
    return await _save(file, "audio", normalize=not skip_normalize, user_id=current_user.id)
