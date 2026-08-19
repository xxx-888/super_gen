"""
ORM Models - 作品展示 (M6)

对标目标网站 work_showcase:
- Work(作品): 已完成的视频/剧集, 可发布到公开画廊.
- 来源: 项目一键成片产出 / 工作台解说剧一键成片产出.
- 公开画廊: is_public=True 的作品瀑布流展示.
"""
from datetime import datetime
from uuid import uuid4
from sqlalchemy import (
    Column, String, Text, Boolean, Integer, Float, DateTime,
    ForeignKey, JSON, Index, UniqueConstraint
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.models import Base, TimestampMixin


class Work(Base, TimestampMixin):
    """作品 (可发布到公开画廊)"""
    __tablename__ = "works"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"))
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"))
    episode_id = Column(UUID(as_uuid=True), ForeignKey("episodes.id", ondelete="SET NULL"))

    title = Column(String(255), nullable=False)
    description = Column(Text)
    cover_url = Column(Text)         # 封面图
    video_url = Column(Text)         # 视频地址
    duration = Column(Float)         # 时长(秒)

    # 来源类型
    source_type = Column(String(30), default="project")  # project/narration/transfer(转绘)

    # 发布状态
    is_public = Column(Boolean, default=False, nullable=False)
    published_at = Column(DateTime(timezone=True))

    # 互动
    view_count = Column(Integer, default=0)
    like_count = Column(Integer, default=0)

    tags = Column(JSONB, default=list)  # 标签(题材/风格)
    meta = Column(JSONB, default=dict)

    # 关系
    author = relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        Index("ix_work_public", "is_public", "published_at"),
        Index("ix_work_user", "user_id"),
    )

    def __repr__(self):
        return f"<Work {self.title} public={self.is_public}>"


class WorkLike(Base, TimestampMixin):
    """点赞记录 (work_id + user_id 唯一, 防重复点赞)"""
    __tablename__ = "work_likes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    work_id = Column(UUID(as_uuid=True), ForeignKey("works.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    __table_args__ = (
        UniqueConstraint("work_id", "user_id", name="uq_work_like_user"),
        Index("ix_work_like_user", "user_id"),
    )

    def __repr__(self):
        return f"<WorkLike work={self.work_id} user={self.user_id}>"
