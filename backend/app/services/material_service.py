"""
Material Library Service - 企业素材库业务逻辑 (M3)

职责:
- 素材 CRUD (列表/上传/编辑/移动/删除) + 卡片/表格视图
- 目录树 (文件夹 CRUD, 按角色/场景/物品分类)
- 团队存储配额统计与校验
- 同步至项目库 (把团队素材复制为项目级 Character/SceneBackground/Prop)
"""
from uuid import UUID
from typing import Optional, List, Dict, Any
from sqlalchemy import select, func, and_, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.exceptions import (
    NotFoundException, BadRequestException, ForbiddenException, QuotaExceededException,
)
from app.models import (
    Organization, TeamMaterial, TeamFolder, MaterialSyncLog,
    Project, Character, SceneBackground, Prop, AudioAsset, Membership,
)


# 分类常量
CATEGORY_IMAGE = "image"
CATEGORY_VIDEO = "video"
CATEGORY_AUDIO = "audio"

# 图片的目录分类
CLASS_TYPES = ["character", "scene", "prop"]


# ==================== 目录树 ====================

async def list_folders(db: AsyncSession, org_id: UUID, class_type: Optional[str] = None) -> List[TeamFolder]:
    """获取目录树(可按 class_type 筛选)."""
    stmt = select(TeamFolder).where(TeamFolder.org_id == org_id)
    if class_type:
        stmt = stmt.where(TeamFolder.class_type == class_type)
    stmt = stmt.order_by(TeamFolder.created_at.asc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def create_folder(
    db: AsyncSession, org_id: UUID, name: str, class_type: str,
    parent_id: Optional[UUID] = None,
) -> TeamFolder:
    """创建文件夹."""
    if class_type not in CLASS_TYPES and class_type != "general":
        raise BadRequestException(f"Invalid class_type: {class_type}")
    f = TeamFolder(org_id=org_id, name=name, class_type=class_type, parent_id=parent_id)
    db.add(f)
    await db.flush()
    return f


async def update_folder(db: AsyncSession, org_id: UUID, folder_id: UUID, name: Optional[str] = None) -> TeamFolder:
    r = await db.execute(select(TeamFolder).where(TeamFolder.id == folder_id, TeamFolder.org_id == org_id))
    f = r.scalar_one_or_none()
    if f is None:
        raise NotFoundException("Folder not found", resource="TeamFolder")
    if name is not None:
        f.name = name
    await db.flush()
    return f


async def delete_folder(db: AsyncSession, org_id: UUID, folder_id: UUID) -> None:
    """删除文件夹(素材移至未分类, 即 folder_id=NULL)."""
    r = await db.execute(select(TeamFolder).where(TeamFolder.id == folder_id, TeamFolder.org_id == org_id))
    f = r.scalar_one_or_none()
    if f is None:
        raise NotFoundException("Folder not found", resource="TeamFolder")
    # 把文件夹下素材的 folder_id 置空(避免级联删除素材)
    await db.execute(
        TeamMaterial.__table__.update()
        .where(TeamMaterial.folder_id == folder_id)
        .values(folder_id=None)
    )
    await db.execute(delete(TeamFolder).where(TeamFolder.id == folder_id))
    await db.flush()


async def ensure_default_folders(db: AsyncSession, org_id: UUID) -> None:
    """确保团队有默认的分类文件夹(角色/场景/物品). 幂等."""
    for ct in CLASS_TYPES:
        r = await db.execute(
            select(TeamFolder).where(TeamFolder.org_id == org_id, TeamFolder.class_type == ct)
        )
        if r.scalar_one_or_none() is None:
            db.add(TeamFolder(org_id=org_id, name=ct, class_type=ct))
    await db.flush()


# ==================== 素材列表 / CRUD ====================

async def list_materials(
    db: AsyncSession, org_id: UUID,
    category: Optional[str] = None,
    class_type: Optional[str] = None,
    folder_id: Optional[UUID] = None,
    search: Optional[str] = None,
    limit: int = 100, offset: int = 0,
) -> List[TeamMaterial]:
    """素材列表(分页/筛选)."""
    stmt = select(TeamMaterial).where(TeamMaterial.org_id == org_id)
    if category:
        stmt = stmt.where(TeamMaterial.category == category)
    if class_type:
        stmt = stmt.where(TeamMaterial.class_type == class_type)
    if folder_id is not None:
        stmt = stmt.where(TeamMaterial.folder_id == folder_id)
    if search:
        stmt = stmt.where(TeamMaterial.name.ilike(f"%{search}%"))
    stmt = stmt.order_by(TeamMaterial.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def count_materials(
    db: AsyncSession, org_id: UUID, category: Optional[str] = None
) -> int:
    stmt = select(func.count(TeamMaterial.id)).where(TeamMaterial.org_id == org_id)
    if category:
        stmt = stmt.where(TeamMaterial.category == category)
    result = await db.execute(stmt)
    return result.scalar() or 0


async def get_material(db: AsyncSession, org_id: UUID, material_id: UUID) -> TeamMaterial:
    r = await db.execute(
        select(TeamMaterial).where(TeamMaterial.id == material_id, TeamMaterial.org_id == org_id)
    )
    m = r.scalar_one_or_none()
    if m is None:
        raise NotFoundException("Material not found", resource="TeamMaterial")
    return m


async def create_material(
    db: AsyncSession, org_id: UUID, user_id: UUID,
    name: str, url: str, category: str,
    size_bytes: int = 0, mime_type: Optional[str] = None,
    thumbnail_url: Optional[str] = None, width: Optional[int] = None,
    height: Optional[int] = None, duration: Optional[float] = None,
    class_type: Optional[str] = None, folder_id: Optional[UUID] = None,
    meta: Optional[Dict] = None,
) -> TeamMaterial:
    """创建素材记录(上传后调用)."""
    m = TeamMaterial(
        org_id=org_id, name=name, url=url, category=category,
        size_bytes=size_bytes, mime_type=mime_type,
        thumbnail_url=thumbnail_url, width=width, height=height,
        duration=duration, class_type=class_type, folder_id=folder_id,
        meta=meta or {}, uploaded_by=user_id,
    )
    db.add(m)
    await db.flush()
    # 更新团队存储用量
    await _add_storage_usage(db, org_id, size_bytes)
    # 更新文件夹计数
    if folder_id:
        await _bump_folder_count(db, folder_id, 1)
    return m


async def update_material(
    db: AsyncSession, org_id: UUID, material_id: UUID,
    name: Optional[str] = None, class_type: Optional[str] = None,
    folder_id: Optional[UUID] = None, meta: Optional[Dict] = None,
) -> TeamMaterial:
    m = await get_material(db, org_id, material_id)
    old_folder = m.folder_id
    if name is not None: m.name = name
    if class_type is not None: m.class_type = class_type
    if folder_id != old_folder:
        m.folder_id = folder_id
        if old_folder:
            await _bump_folder_count(db, old_folder, -1)
        if folder_id:
            await _bump_folder_count(db, folder_id, 1)
    if meta is not None: m.meta = {**(m.meta or {}), **meta}
    await db.flush()
    return m


async def move_material(db: AsyncSession, org_id: UUID, material_id: UUID, folder_id: Optional[UUID]) -> TeamMaterial:
    """移动素材到指定文件夹(None=未分类)."""
    return await update_material(db, org_id, material_id, folder_id=folder_id)


async def delete_material(db: AsyncSession, org_id: UUID, material_id: UUID) -> None:
    m = await get_material(db, org_id, material_id)
    size = m.size_bytes or 0
    folder_id = m.folder_id
    await db.delete(m)
    await db.flush()
    await _add_storage_usage(db, org_id, -size)
    if folder_id:
        await _bump_folder_count(db, folder_id, -1)


# ==================== 存储配额 ====================

async def get_storage_usage(db: AsyncSession, org_id: UUID) -> Dict[str, Any]:
    """团队存储用量统计."""
    # 按类别聚合
    result = await db.execute(
        select(TeamMaterial.category, func.sum(TeamMaterial.size_bytes))
        .where(TeamMaterial.org_id == org_id)
        .group_by(TeamMaterial.category)
    )
    by_cat = {r[0]: int(r[1] or 0) for r in result.all()}
    total = sum(by_cat.values())

    # 更新 org 的 storage_used_mb (以 MB 计, 向上取整)
    used_mb = (total + 1024 * 1024 - 1) // (1024 * 1024)
    org_r = await db.execute(select(Organization).where(Organization.id == org_id))
    org = org_r.scalar_one_or_none()
    quota_mb = org.storage_quota_mb if org else 10240
    if org:
        org.storage_used_mb = used_mb
    await db.flush()

    return {
        "used_bytes": total,
        "used_mb": used_mb,
        "quota_mb": quota_mb,
        "usage_percent": round(used_mb / quota_mb * 100, 1) if quota_mb else 0,
        "by_category": by_cat,
    }


async def check_quota(db: AsyncSession, org_id: UUID, add_bytes: int) -> None:
    """校验上传是否会超配额."""
    usage = await get_storage_usage(db, org_id)
    new_used_mb = (usage["used_bytes"] + add_bytes) / (1024 * 1024)
    if new_used_mb > usage["quota_mb"]:
        raise QuotaExceededException(
            f"Storage quota exceeded: {new_used_mb:.1f}MB > {usage['quota_mb']}MB",
            quota_type="storage",
        )


async def _add_storage_usage(db: AsyncSession, org_id: UUID, delta_bytes: int) -> None:
    """增减团队存储用量(立即重算, 保证准确)."""
    await get_storage_usage(db, org_id)


# ==================== 同步至项目库 ====================

async def sync_to_project(
    db: AsyncSession, org_id: UUID, material_id: UUID, project_id: UUID,
    target_type: str, user_id: UUID,
) -> Dict[str, Any]:
    """把团队素材同步(复制)到项目库.

    target_type: character/scene_bg/prop/audio
    返回新建的项目级资源信息.
    """
    m = await get_material(db, org_id, material_id)

    # 校验项目归属该团队
    pr = await db.execute(select(Project).where(Project.id == project_id, Project.org_id == org_id))
    project = pr.scalar_one_or_none()
    if project is None:
        raise NotFoundException("Project not found in this organization", resource="Project")

    # 检查是否已同步(避免重复)
    exist = await db.execute(
        select(MaterialSyncLog).where(
            MaterialSyncLog.material_id == material_id,
            MaterialSyncLog.project_id == project_id,
            MaterialSyncLog.target_type == target_type,
        )
    )
    if exist.scalar_one_or_none():
        raise BadRequestException("Material already synced to this project")

    target = None
    if target_type == "character":
        target = Character(
            project_id=project_id, name=m.name,
            appearance_prompt=m.meta.get("appearance_prompt") if m.meta else None,
            image_url=m.url, images=[],  # 多角度图列表, 同步时留空
        )
    elif target_type == "scene_bg":
        target = SceneBackground(
            project_id=project_id, name=m.name,
            prompt=m.meta.get("prompt") if m.meta else None,
            image_url=m.url,
        )
    elif target_type == "prop":
        target = Prop(
            project_id=project_id, name=m.name,
            prompt=m.meta.get("prompt") if m.meta else None,
            image_url=m.url,
        )
    elif target_type == "audio":
        if m.category != CATEGORY_AUDIO:
            raise BadRequestException("Only audio material can sync as audio asset")
        target = AudioAsset(
            project_id=project_id, name=m.name, type="sfx",
            url=m.url, duration=m.duration,
        )
    else:
        raise BadRequestException(f"Invalid target_type: {target_type}")

    db.add(target)
    await db.flush()

    log = MaterialSyncLog(
        org_id=org_id, material_id=material_id, project_id=project_id,
        target_type=target_type, target_id=target.id, synced_by=user_id,
    )
    db.add(log)
    await db.flush()

    return {
        "sync_id": str(log.id),
        "target_type": target_type,
        "target_id": str(target.id),
        "target_name": target.name,
    }


# ==================== 内部工具 ====================

async def _bump_folder_count(db: AsyncSession, folder_id: UUID, delta: int) -> None:
    r = await db.execute(select(TeamFolder).where(TeamFolder.id == folder_id))
    f = r.scalar_one_or_none()
    if f:
        f.item_count = max(0, (f.item_count or 0) + delta)
        await db.flush()
