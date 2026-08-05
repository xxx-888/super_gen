"""
ORM Models - 集(Episode) 片段管理 (M4)

对标目标网站 project_page/snippets:
- Episode(集): 剧集的一集, 如"第56集". 按集组织, 每集有状态机.
- 状态机: asset(资产待生成) -> pending_submit(待提交) -> video_editing(视频编辑) -> completed(已完成)
- Scene 下沉为"片段/分镜", 归属到 Episode.
- 一键成片: 编排整集的生成流水线.
- 智能审片 / 此步后停止: 辅助创作流程.
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


# Episode 状态机
EPISODE_STATUS_ASSET = "asset"                # 资产(待生成)
EPISODE_STATUS_PENDING_SUBMIT = "pending_submit"  # 待提交
EPISODE_STATUS_VIDEO_EDITING = "video_editing"    # 视频编辑
EPISODE_STATUS_COMPLETED = "completed"            # 已完成
EPISODE_STATUSES = [
    EPISODE_STATUS_ASSET, EPISODE_STATUS_PENDING_SUBMIT,
    EPISODE_STATUS_VIDEO_EDITING, EPISODE_STATUS_COMPLETED,
]

# Scene 创作模式
CREATION_MODE_IMAGE_TO_VIDEO = "image_to_video"      # 图片生成视频
CREATION_MODE_FIRST_LAST_FRAME = "first_last_frame"  # 首尾帧生成视频
CREATION_MODE_FUSION = "fusion"                       # 融合生成视频


class Episode(Base, TimestampMixin):
    """集 - 剧集的一集(如"第56集")"""
    __tablename__ = "episodes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    script_id = Column(UUID(as_uuid=True), ForeignKey("scripts.id"))  # 关联剧本(可空)
    number = Column(Integer, nullable=False)  # 集号(1,2,3...)
    title = Column(String(255))               # 显示名, 如"第56集"

    # 状态机
    status = Column(String(30), default=EPISODE_STATUS_ASSET, nullable=False)

    # 创作辅助开关
    stop_after_step = Column(Boolean, default=False)  # 此步后停止
    smart_review = Column(Boolean, default=False)     # 智能审片开关

    cover_image_url = Column(Text)
    sort_order = Column(Integer, default=0)
    meta = Column(JSONB, default=dict)  # 一键成片进度、统计等

    # 关系
    project = relationship("Project", back_populates="episodes")
    scenes = relationship("Scene", back_populates="episode", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("project_id", "number", name="uq_episode_project_number"),
        Index("ix_episode_project_sort", "project_id", "sort_order"),
    )

    def __repr__(self):
        return f"<Episode #{self.number} [{self.status}]>"
