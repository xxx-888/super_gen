"""
ORM Models - 企业素材库 (团队级共享素材)

对标目标网站 enterprise_material:
- 三类素材: image / video / audio
- 目录树: 按角色/场景/物品分类(仅图片), 支持嵌套文件夹
- 团队存储配额: 由 Organization.storage_quota_mb / storage_used_mb 管理
- 同步至项目库: 把团队素材复制为项目级 Character/SceneBackground/Prop
"""
from datetime import datetime
from uuid import uuid4
from sqlalchemy import (
    Column, String, Text, Boolean, Integer, Float, DateTime,
    ForeignKey, JSON, UniqueConstraint, Index
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.models import Base, TimestampMixin


class TeamFolder(Base, TimestampMixin):
    """素材目录树 (文件夹)

    class_type: character/scene/prop (图片分类), video/audio 用通用 folder
    支持嵌套: parent_id 自引用
    """
    __tablename__ = "team_folders"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    class_type = Column(String(20), nullable=False)  # character/scene/prop/general
    name = Column(String(255), nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("team_folders.id"))
    item_count = Column(Integer, default=0)

    # 关系
    children = relationship("TeamFolder", backref="parent", remote_side=[id], lazy="selectin")
    materials = relationship("TeamMaterial", back_populates="folder", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_team_folder_org_class", "org_id", "class_type"),
    )

    def __repr__(self):
        return f"<TeamFolder {self.class_type}/{self.name}>"


class TeamMaterial(Base, TimestampMixin):
    """团队素材 (图片/视频/音频)"""
    __tablename__ = "team_materials"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    category = Column(String(20), nullable=False)  # image/video/audio
    class_type = Column(String(20))  # character/scene/prop (仅图片有意义)
    folder_id = Column(UUID(as_uuid=True), ForeignKey("team_folders.id"))

    name = Column(String(255), nullable=False)
    url = Column(Text, nullable=False)
    thumbnail_url = Column(Text)
    size_bytes = Column(Integer, default=0)
    mime_type = Column(String(100))
    width = Column(Integer)  # 图片宽
    height = Column(Integer)  # 图片高
    duration = Column(Float)  # 音视频时长(秒)
    meta = Column(JSONB, default=dict)  # 关联角色名、朝向等扩展信息

    # 上传者
    uploaded_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))

    # 关系
    folder = relationship("TeamFolder", back_populates="materials")
    sync_logs = relationship("MaterialSyncLog", back_populates="material", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_team_material_org_cat", "org_id", "category"),
        Index("ix_team_material_folder", "folder_id"),
    )

    def __repr__(self):
        return f"<TeamMaterial {self.category}/{self.name}>"


class MaterialSyncLog(Base, TimestampMixin):
    """企业素材 → 项目库 同步记录

    把团队素材复制为项目级资源(Character/SceneBackground/Prop/AudioAsset)时记录.
    target_type: character/scene_bg/prop/audio
    """
    __tablename__ = "material_sync_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    material_id = Column(UUID(as_uuid=True), ForeignKey("team_materials.id"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    target_type = Column(String(20), nullable=False)  # character/scene_bg/prop/audio
    target_id = Column(UUID(as_uuid=True), nullable=False)
    synced_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))

    # 关系
    material = relationship("TeamMaterial", back_populates="sync_logs")

    __table_args__ = (
        UniqueConstraint("material_id", "project_id", "target_type", name="uq_sync_material_project_type"),
        Index("ix_sync_log_org_project", "org_id", "project_id"),
    )

    def __repr__(self):
        return f"<SyncLog {self.material_id}->{self.target_type}>"
