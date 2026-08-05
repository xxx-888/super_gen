"""
ORM Models - 组织/团队 与 成员关系 (多租户地基)

设计要点:
- 每个 User 注册时自动创建一个 personal Organization, 保证单用户体验不变.
- 真实团队通过 Membership 关联多个成员.
- Project / TeamMaterial 等业务实体通过 org_id 归属到团队.
- MemberGroup / PermissionGroup 为后续 M2 团队管理预留模型, 首批仅建表.
"""
from datetime import datetime
from uuid import uuid4
from sqlalchemy import (
    Column, String, Text, Boolean, Integer, DateTime,
    ForeignKey, JSON, UniqueConstraint, Index
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.models import Base, TimestampMixin


class Organization(Base, TimestampMixin):
    """组织/团队 (多租户边界)"""
    __tablename__ = "organizations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    name = Column(String(255), nullable=False)
    avatar_url = Column(Text)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    is_personal = Column(Boolean, default=False, nullable=False)  # 个人团队(注册自动创建)
    # 存储配额(MB); personal 默认 10GB, 对标目标网站"基础档 10GB"
    storage_quota_mb = Column(Integer, default=10240, nullable=False)
    storage_used_mb = Column(Integer, default=0, nullable=False)
    settings = Column(JSONB, default=dict)

    # 关系
    owner = relationship("User", foreign_keys=[owner_id])
    memberships = relationship("Membership", back_populates="org", cascade="all, delete-orphan")
    credit_account = relationship(
        "CreditAccount", back_populates="org", uselist=False, cascade="all, delete-orphan"
    )
    credit_transactions = relationship("CreditTransaction", back_populates="org")
    projects = relationship("Project", back_populates="org", foreign_keys="Project.org_id")

    def __repr__(self):
        return f"<Organization {self.name}>"


class Membership(Base, TimestampMixin):
    """成员关系 (User ↔ Organization)

    role: owner(创建者) / admin(管理员) / member(普通成员)
    """
    __tablename__ = "memberships"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    role = Column(String(20), default="member", nullable=False)
    display_name = Column(String(100))  # 团队内显示名(可覆盖 nickname)
    is_active = Column(Boolean, default=True, nullable=False)

    # 关系
    org = relationship("Organization", back_populates="memberships")
    user = relationship("User", back_populates="memberships")

    __table_args__ = (
        UniqueConstraint("org_id", "user_id", name="uq_membership_org_user"),
        Index("ix_membership_user", "user_id"),
    )

    def __repr__(self):
        return f"<Membership {self.user_id}@{self.org_id} [{self.role}]>"


# ==================== M2 预留模型 (首批仅建表, 业务逻辑后续实现) ====================

class MemberGroup(Base, TimestampMixin):
    """成员组 (M2 团队管理使用)"""
    __tablename__ = "member_groups"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    name = Column(String(255), nullable=False)
    leader_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    description = Column(Text)
    member_ids = Column(JSONB, default=list)  # 简化: 直接存 user_id 列表(M2 可改关联表)

    def __repr__(self):
        return f"<MemberGroup {self.name}>"


class PermissionGroup(Base, TimestampMixin):
    """权限组 (角色模板, M2 团队管理使用)

    permissions JSONB 结构示例:
        {"view": true, "edit": true, "delete": false, "download": true}
    """
    __tablename__ = "permission_groups"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    permissions = Column(JSONB, default=dict)

    def __repr__(self):
        return f"<PermissionGroup {self.name}>"


class OperationLog(Base, TimestampMixin):
    """操作日志 (成员管理操作审计: 编辑/重置密码/禁用/角色变更等)"""
    __tablename__ = "operation_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    operator_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))  # 操作人
    target_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))  # 被操作成员
    action = Column(String(50), nullable=False)  # edit/reset_password/disable/enable/role_change/invite/credits_allocate
    detail = Column(Text)  # 操作描述
    meta = Column(JSONB, default=dict)  # 变更前后等扩展信息

    def __repr__(self):
        return f"<OpLog {self.action} by {self.operator_id}>"


class TeamMaterialPermission(Base, TimestampMixin):
    """成员对企业素材库的权限矩阵 (M2 企业素材库权限标签)

    六项权限: view/upload/download/edit/delete/invoke(调用)
    级联规则(业务层实现):
      - 授予 upload/download/edit -> 自动授予 view
      - 授予 delete -> 自动授予 edit + view
      - 取消 view -> 取消其余全部
    """
    __tablename__ = "team_material_permissions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    can_view = Column(Boolean, default=True, nullable=False)
    can_upload = Column(Boolean, default=False, nullable=False)
    can_download = Column(Boolean, default=False, nullable=False)
    can_edit = Column(Boolean, default=False, nullable=False)
    can_delete = Column(Boolean, default=False, nullable=False)
    can_invoke = Column(Boolean, default=False, nullable=False)

    __table_args__ = (
        UniqueConstraint("org_id", "user_id", name="uq_material_perm_org_user"),
    )

    def __repr__(self):
        return f"<MaterialPerm {self.user_id}@{self.org_id}>"
