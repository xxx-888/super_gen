"""
Material Library API - 企业素材库接口 (M3)

路由前缀: /organizations/{org_id}/materials
端点:
- GET    /              素材列表(分类/目录/搜索/分页)
- POST   /              上传素材(multipart + 校验配额)
- GET    /{id}          素材详情
- PUT    /{id}          编辑素材
- POST   /{id}/move     移动素材
- DELETE /{id}          删除素材
- POST   /{id}/sync     同步至项目库
- GET    /folders       目录树
- POST   /folders       创建文件夹
- PUT    /folders/{fid} 编辑文件夹
- DELETE /folders/{fid} 删除文件夹
- GET    /storage       存储用量
"""
from uuid import UUID
from typing import Optional, List
from fastapi import APIRouter, Depends, File, UploadFile, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.config import settings
from app.core.exceptions import BadRequestException, FileUploadException
from app.api.deps import verify_org_membership, get_current_org, verify_org_or_project_member
from app.models import User, Organization, TeamMaterial
from app.schemas import (
    TeamFolderResponse, TeamFolderCreate,
    TeamMaterialResponse, TeamMaterialUpdate,
    MoveMaterialRequest, SyncToProjectRequest, StorageUsageResponse,
)
from app.services import material_service
from app.services.storage import get_storage_singleton

router = APIRouter()

_CATEGORY_CONFIG = {
    "image": settings.ALLOWED_IMAGE_TYPES,
    "video": settings.ALLOWED_VIDEO_TYPES,
    "audio": settings.ALLOWED_AUDIO_TYPES,
}


def _require_write(membership) -> None:
    """写操作权限：owner/admin 可管理（增删改），member 可上传。
    超级管理员在 verify_org_membership 里已设为 owner 角色。
    """
    if membership.role not in ("owner", "admin", "member"):
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("需要团队成员权限才能操作素材")


def _require_admin(membership) -> None:
    """管理权限：仅 owner/admin 可删除、修改他人素材。"""
    if membership.role not in ("owner", "admin"):
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("需要管理员权限才能执行此操作")


# ==================== 目录树 (必须在 /{material_id} 之前注册, 避免 folders/storage 被当作 material_id) ====================

@router.get("/folders", response_model=List[TeamFolderResponse])
async def list_folders(
    org_id: UUID,
    class_type: Optional[str] = Query(None),
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    return await material_service.list_folders(db, org_id, class_type)


@router.post("/folders", response_model=TeamFolderResponse, status_code=201)
async def create_folder(
    org_id: UUID, body: TeamFolderCreate,
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    return await material_service.create_folder(db, org_id, body.name, body.class_type, body.parent_id)


@router.put("/folders/{folder_id}", response_model=TeamFolderResponse)
async def update_folder(
    org_id: UUID, folder_id: UUID, body: TeamFolderCreate,
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    return await material_service.update_folder(db, org_id, folder_id, body.name)


@router.delete("/folders/{folder_id}")
async def delete_folder(
    org_id: UUID, folder_id: UUID,
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    await material_service.delete_folder(db, org_id, folder_id)
    return {"message": "Deleted"}


# ==================== 存储用量 ====================

@router.get("/storage", response_model=StorageUsageResponse)
async def get_storage(
    org_id: UUID,
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    return await material_service.get_storage_usage(db, org_id)


# ==================== 素材列表 / CRUD ====================

@router.get("", response_model=List[TeamMaterialResponse])
async def list_materials(
    org_id: UUID,
    category: Optional[str] = Query(None),
    class_type: Optional[str] = Query(None),
    folder_id: Optional[UUID] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(60, ge=1, le=200),
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """素材列表（分页）。团队成员均可查看，超级管理员可查看所有。"""
    offset = (page - 1) * page_size
    return await material_service.list_materials(
        db, org_id, category, class_type, folder_id, search, page_size, offset
    )


@router.get("/count")
async def count_materials(
    org_id: UUID,
    category: Optional[str] = Query(None),
    class_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """素材总数（用于前端分页）。团队成员均可查看。"""
    total = await material_service.count_materials(db, org_id, category)
    return {"total": total}


@router.post("", response_model=TeamMaterialResponse, status_code=201)
async def upload_material(
    org_id: UUID,
    file: UploadFile = File(...),
    category: str = Query(..., description="image/video/audio"),
    class_type: Optional[str] = Query(None),
    folder_id: Optional[UUID] = Query(None),
    name: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    membership = Depends(verify_org_membership),
):
    """上传素材到企业素材库(校验配额). 团队成员均可上传。"""
    _require_write(membership)
    allowed = _CATEGORY_CONFIG.get(category, [])
    if file.content_type not in allowed:
        raise BadRequestException(f"Unsupported {category} type: {file.content_type}")

    data = await file.read()
    if len(data) > settings.MAX_UPLOAD_SIZE:
        raise FileUploadException("File too large")

    # 配额校验
    await material_service.check_quota(db, org_id, len(data))

    # 存储
    storage = get_storage_singleton()
    stored = await storage.save(
        data=data, filename=file.filename or f"upload.{category}",
        mime_type=file.content_type, category=category,
    )

    m = await material_service.create_material(
        db, org_id, current_user.id,
        name=name or file.filename or stored.filename,
        url=stored.url, category=category,
        size_bytes=stored.size, mime_type=stored.mime_type,
        thumbnail_url=stored.url if category == "image" else None,
        width=stored.width, height=stored.height, duration=stored.duration,
        class_type=class_type, folder_id=folder_id,
    )
    return m


@router.post("/from-url", response_model=TeamMaterialResponse, status_code=201)
async def create_material_from_url(
    org_id: UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    membership = Depends(verify_org_membership),
):
    """从已有 URL 创建团队素材（同步项目资源到素材库）。团队成员可操作。"""
    _require_write(membership)
    url = (body or {}).get("url", "").strip()
    name = (body or {}).get("name", "").strip() or "未命名"
    category = (body or {}).get("category", "image")
    class_type = (body or {}).get("class_type")
    meta = (body or {}).get("meta") or {}

    if not url:
        raise BadRequestException("url is required")

    m = await material_service.create_material(
        db, org_id, current_user.id,
        name=name, url=url, category=category,
        size_bytes=0,  # 引用 URL，无本地文件大小
        thumbnail_url=url if category == "image" else None,
        class_type=class_type,
        meta=meta,
    )
    await db.commit()
    await db.refresh(m)
    return m


@router.get("/{material_id}", response_model=TeamMaterialResponse)
async def get_material(
    org_id: UUID, material_id: UUID,
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    return await material_service.get_material(db, org_id, material_id)


@router.put("/{material_id}", response_model=TeamMaterialResponse)
async def update_material(
    org_id: UUID, material_id: UUID, body: TeamMaterialUpdate,
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """修改素材信息。仅 owner/admin 可操作。"""
    _require_admin(membership)
    return await material_service.update_material(
        db, org_id, material_id, body.name, body.class_type, body.folder_id, body.meta
    )


@router.post("/{material_id}/move", response_model=TeamMaterialResponse)
async def move_material(
    org_id: UUID, material_id: UUID, body: MoveMaterialRequest,
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """移动素材到指定文件夹。仅 owner/admin 可操作。"""
    _require_admin(membership)
    return await material_service.move_material(db, org_id, material_id, body.folder_id)


@router.delete("/{material_id}")
async def delete_material(
    org_id: UUID, material_id: UUID,
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """删除素材。仅 owner/admin 可操作。"""
    _require_admin(membership)
    await material_service.delete_material(db, org_id, material_id)
    return {"message": "Deleted"}


@router.post("/{material_id}/sync")
async def sync_to_project(
    org_id: UUID, material_id: UUID, body: SyncToProjectRequest,
    current_user: User = Depends(get_current_user),
    membership = Depends(verify_org_membership),
    db: AsyncSession = Depends(get_db),
):
    """同步素材至项目库(复制为项目级资源)."""
    return await material_service.sync_to_project(
        db, org_id, material_id, body.project_id, body.target_type, current_user.id
    )
