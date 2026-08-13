"""
ORM Models - 项目成员管理

项目级成员: 控制谁可以访问某个项目, 以及在该项目内的角色.
角色: owner(负责人) / manager(管理者) / editor(编辑) / viewer(只读)
与团队级 Membership(M2) 互补: 团队成员是组织级, 项目成员是项目级精细化.
"""
from uuid import uuid4
from sqlalchemy import (
    Column, String, Boolean, DateTime,
    ForeignKey, UniqueConstraint, Index
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.models import Base, TimestampMixin


class ProjectMember(Base, TimestampMixin):
    """项目成员 (项目-用户 多对多)"""
    __tablename__ = "project_members"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    # 项目内角色
    role = Column(String(20), default="viewer", nullable=False)  # owner/manager/editor/viewer
    # 项目创建者自动成为 owner
    added_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    is_active = Column(Boolean, default=True, nullable=False)

    # 关系
    project = relationship("Project", back_populates="project_members")
    user = relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_project_member"),
        Index("ix_project_member_user", "user_id"),
    )

    def __repr__(self):
        return f"<ProjectMember {self.user_id}@{self.project_id} [{self.role}]>"
