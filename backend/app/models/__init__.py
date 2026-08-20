"""
SQLAlchemy ORM Models - AI短剧生成平台
"""
from datetime import datetime
from uuid import uuid4
from typing import Optional, List
from sqlalchemy import (
    Column, String, Text, Boolean, Integer, Float, DateTime,
    ForeignKey, JSON, UniqueConstraint, Index
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import relationship, declarative_base
from sqlalchemy.sql import func

Base = declarative_base()


class TimestampMixin:
    """时间戳混入类"""
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ==================== 多租户 & 积分 (M1 地基) ====================
from app.models.organization import (
    Organization,
    Membership,
    MemberGroup,
    PermissionGroup,
    OperationLog,
    TeamMaterialPermission,
)
from app.models.credit import (
    CreditAccount,
    CreditTransaction,
    CreditAllocation,
    CreditPricing,
)
# ==================== 企业素材库 (M3) ====================
from app.models.team_material import (
    TeamFolder,
    TeamMaterial,
    MaterialSyncLog,
)
# ==================== 集(Episode) 片段管理 (M4) ====================
from app.models.episode import (
    Episode,
    EPISODE_STATUS_ASSET, EPISODE_STATUS_PENDING_SUBMIT,
    EPISODE_STATUS_VIDEO_EDITING, EPISODE_STATUS_COMPLETED, EPISODE_STATUSES,
    CREATION_MODE_IMAGE_TO_VIDEO, CREATION_MODE_FIRST_LAST_FRAME, CREATION_MODE_FUSION,
)
# ==================== 作品展示 (M6) ====================
from app.models.work import Work, WorkLike
# ==================== 项目成员管理 ====================
from app.models.project_member import ProjectMember
# ==================== 画布面板 ====================
from app.models.canvas import Canvas


class User(Base, TimestampMixin):
    """用户表"""
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=False)
    nickname = Column(String(100))
    avatar_url = Column(Text)
    role = Column(String(20), default="user")  # admin/user
    is_active = Column(Boolean, default=True)
    # 当前选中的团队(M1 默认 personal org); 登录后由前端切换器维护
    active_org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"))

    # 关系
    projects = relationship("Project", back_populates="owner", cascade="all, delete-orphan")
    memberships = relationship("Membership", back_populates="user", cascade="all, delete-orphan")
    active_org = relationship("Organization", foreign_keys=[active_org_id])

    def __repr__(self):
        return f"<User {self.email}>"


class Project(Base, TimestampMixin):
    """项目表"""
    __tablename__ = "projects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    # 多租户: 项目归属团队. nullable 以兼容存量数据(迁移时回填到 owner 的 personal org).
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    cover_image_url = Column(Text)
    status = Column(String(20), default="draft")  # draft/producing/completed/archived
    settings = Column(JSONB, default=dict)  # 项目设置

    # 关系
    owner = relationship("User", back_populates="projects")
    org = relationship("Organization", back_populates="projects", foreign_keys=[org_id])
    # passive_deletes=True：删项目时不再逐行 SELECT+DELETE 子表，交给 DB 的 ON DELETE CASCADE
    scripts = relationship("Script", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    characters = relationship("Character", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    scene_backgrounds = relationship("SceneBackground", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    props = relationship("Prop", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    audio_assets = relationship("AudioAsset", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    video_assets = relationship("VideoAsset", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    generation_tasks = relationship("GenerationTask", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    episodes = relationship("Episode", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    project_members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    canvases = relationship("Canvas", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)
    material_sync_logs = relationship("MaterialSyncLog", back_populates="project", cascade="all, delete-orphan", passive_deletes=True)

    def __repr__(self):
        return f"<Project {self.name}>"


class Script(Base, TimestampMixin):
    """剧本表"""
    __tablename__ = "scripts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(255))
    content = Column(Text, nullable=False)  # 原始剧本文本
    format = Column(String(20), default="plain")  # plain/fountain/finaldraft
    parsed_data = Column(JSONB)  # 解析后的结构化数据

    # 关系
    project = relationship("Project", back_populates="scripts")
    scenes = relationship("Scene", back_populates="script", cascade="all, delete-orphan", passive_deletes=True)

    def __repr__(self):
        return f"<Script {self.title or self.id}>"


class Scene(Base, TimestampMixin):
    """分镜表 - 核心实体"""
    __tablename__ = "scenes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    script_id = Column(UUID(as_uuid=True), ForeignKey("scripts.id", ondelete="CASCADE"), nullable=False)
    sequence = Column(Integer, nullable=False)  # 序号
    scene_type = Column(String(20), default="normal")  # normal/title/transition

    # M4: 归属集 (nullable 兼容存量; 新流程下片段挂在 Episode 下)
    episode_id = Column(UUID(as_uuid=True), ForeignKey("episodes.id", ondelete="CASCADE"), index=True)

    # 提示词相关
    prompt = Column(Text, nullable=False)  # 原始提示词(包含@引用)
    parsed_prompt = Column(JSONB)  # 解析后的提示词(展开@引用)

    # 镜头设置
    duration = Column(Float, default=5.0)  # 时长(秒)
    camera_angle = Column(String(50))  # 镜头角度: close_up/medium/wide/etc.
    camera_movement = Column(String(50))  # 镜头运动: static/pan/tilt/dolly/etc.
    mood = Column(String(50))  # 情绪氛围

    # M4: 创作模式与镜头类型
    shot_type = Column(String(50))  # 镜头类型: 对话场景/动作场景/风景/etc.
    creation_mode = Column(String(30))  # image_to_video/first_last_frame/fusion

    # 状态与输出
    status = Column(String(20), default="pending")  # pending/ready/generating/completed/failed
    generated_video_url = Column(Text)
    thumbnail_url = Column(Text)
    meta = Column(JSONB, default=dict)  # 视频资产列表、生成参数等

    # 关系
    script = relationship("Script", back_populates="scenes")
    episode = relationship("Episode", back_populates="scenes")
    assets = relationship("SceneAsset", back_populates="scene", cascade="all, delete-orphan", passive_deletes=True)

    __table_args__ = (
        Index('ix_script_sequence', 'script_id', 'sequence', unique=True),
    )

    def __repr__(self):
        return f"<Scene #{self.sequence}>"


class Character(Base, TimestampMixin):
    """角色表"""
    __tablename__ = "characters"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    appearance_prompt = Column(Text)  # 外观描述(用于文生图)
    image_url = Column(Text)  # 主图
    images = Column(JSONB, default=list)  # 多角度/多表情图片列表
    voice_id = Column(String(100))  # 关联的音色ID
    meta = Column(JSONB, default=dict)

    # 关系
    project = relationship("Project", back_populates="characters")

    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_character_project_name"),
    )

    def __repr__(self):
        return f"<Character {self.name}>"


class SceneBackground(Base, TimestampMixin):
    """场景背景表"""
    __tablename__ = "scene_backgrounds"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    prompt = Column(Text)  # 场景描述
    image_url = Column(Text)
    meta = Column(JSONB, default=dict)

    # 关系
    project = relationship("Project", back_populates="scene_backgrounds")

    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_scene_bg_project_name"),
    )

    def __repr__(self):
        return f"<SceneBG {self.name}>"


class Prop(Base, TimestampMixin):
    """道具表"""
    __tablename__ = "props"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    prompt = Column(Text)
    image_url = Column(Text)
    meta = Column(JSONB, default=dict)

    # 关系
    project = relationship("Project", back_populates="props")

    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_prop_project_name"),
    )

    def __repr__(self):
        return f"<Prop {self.name}>"


class AudioAsset(Base, TimestampMixin):
    """音频资产表"""
    __tablename__ = "audio_assets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    type = Column(String(20), nullable=False)  # dialogue/music/sfx/narration
    content = Column(Text)  # 台词文本或音乐描述
    url = Column(Text, nullable=False)
    duration = Column(Float)
    character_id = Column(UUID(as_uuid=True), ForeignKey("characters.id"))  # 如果是对白，关联角色
    meta = Column(JSONB, default=dict)

    # 关系
    project = relationship("Project", back_populates="audio_assets")
    character = relationship("Character")

    def __repr__(self):
        return f"<Audio {self.name} ({self.type})>"


class VideoAsset(Base, TimestampMixin):
    """视频资产表（参考视频素材，供 @视频引用 / reference_video 参考生成）"""
    __tablename__ = "video_assets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    type = Column(String(20), nullable=False, default="reference")  # reference/shot/b-roll
    content = Column(Text)  # 视频内容描述
    url = Column(Text, nullable=False)
    thumbnail_url = Column(Text)  # 封面帧（列表缩略图用，可空）
    duration = Column(Float)
    meta = Column(JSONB, default=dict)

    # 关系
    project = relationship("Project", back_populates="video_assets")

    def __repr__(self):
        return f"<Video {self.name} ({self.type})>"


class SceneAsset(Base, TimestampMixin):
    """分镜-资源关联表 (多对多关系)"""
    __tablename__ = "scene_assets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    scene_id = Column(UUID(as_uuid=True), ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False)
    resource_type = Column(String(20), nullable=False)  # character/scene_bg/prop/audio
    resource_id = Column(UUID(as_uuid=True), nullable=False)
    position = Column(Integer, default=0)  # 在提示词中的位置
    usage_context = Column(Text)  # 使用上下文描述

    # 关系
    scene = relationship("Scene", back_populates="assets")

    __table_args__ = (
        UniqueConstraint('scene_id', 'resource_type', 'resource_id',
                         name='uq_scene_resource'),
    )

    def __repr__(self):
        return f"<SceneAsset {self.resource_type}:{self.resource_id}>"


class GenerationTask(Base, TimestampMixin):
    """生成任务表"""
    __tablename__ = "generation_tasks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    episode_id = Column(UUID(as_uuid=True), ForeignKey("episodes.id"))  # M4: 关联集(一键成片)
    scene_id = Column(UUID(as_uuid=True), ForeignKey("scenes.id", ondelete="SET NULL"), index=True)  # 关联分镜（任务队列/视频预览按 剧本/集/分镜 追溯）
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True)  # 创建/触发任务的用户
    type = Column(String(20), nullable=False)  # image/video/audio/subtitle/remove_subtitle
    model = Column(String(50), nullable=False)  # 使用的模型标识
    input_data = Column(JSONB, nullable=False)  # 输入参数
    output_urls = Column(ARRAY(Text))  # 输出文件URL列表
    credits_consumed = Column(Integer, default=0)  # M4: 消耗积分(便于按集统计)

    # 状态跟踪
    status = Column(String(20), default="pending")  # pending/processing/completed/failed/cancelled
    progress = Column(Integer, default=0)  # 0-100
    error_message = Column(Text)
    meta = Column(JSONB, default=dict)  # 扩展元数据(celery_task_id、日志等)

    # 时间戳
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    # 软删除：用户侧（视频预览等）删除只做隐藏，后台任务队列仍可见（审计底账）
    deleted_at = Column(DateTime(timezone=True), index=True)

    # 关系
    project = relationship("Project", back_populates="generation_tasks")
    episode = relationship("Episode")  # 声明依赖：级联删除时 task 须先于 episode 删除
    scene = relationship("Scene")  # 关联分镜
    user = relationship("User")  # 创建/触发任务的用户

    def __repr__(self):
        return f"<Task {self.type}@{self.model} [{self.status}]>"


class MediaState(Base, TimestampMixin):
    """媒体状态表（后台「媒体资源」管理）

    按 URL 记录管理员设置的禁用状态与显示名，统一覆盖所有媒体来源
    （生成任务输出 / 素材库 team_materials / 项目音视频资产）。
    禁用的本地 /uploads 文件由 media_guard + GuardedStaticFiles 拦截（403）。
    """
    __tablename__ = "media_states"

    url = Column(String(512), primary_key=True)
    disabled = Column(Boolean, default=False, nullable=False, index=True)
    name = Column(String(255))  # 管理员重命名的显示名（空=用原始文件名）

    def __repr__(self):
        return f"<MediaState {'禁用' if self.disabled else '正常'} {self.url}>"


class ComfyUIWorkflow(Base, TimestampMixin):
    """ComfyUI工作流表"""
    __tablename__ = "comfyui_workflows"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    name = Column(String(255), nullable=False)
    description = Column(Text)
    workflow_json = Column(JSONB, nullable=False)  # ComfyUI API格式的工作流JSON
    is_public = Column(Boolean, default=False)  # 是否公开模板
    tags = Column(ARRAY(String))  # 标签分类
    usage_count = Column(Integer, default=0)  # 使用次数

    # 关系
    owner = relationship("User")

    def __repr__(self):
        return f"<ComfyWorkflow {self.name}>"


class SystemSettings(Base, TimestampMixin):
    """系统设置表 (单例模式)"""
    __tablename__ = "system_settings"

    key = Column(String(100), primary_key=True)
    value = Column(JSONB, nullable=False)
    description = Column(Text)

    def __repr__(self):
        return f"<Setting {self.key}>"


class AIModel(Base, TimestampMixin):
    """AI 模型配置表 (文生图/图生视频/TTS/ASR)"""
    __tablename__ = "ai_models"

    id = Column(String(64), primary_key=True, default=lambda: str(uuid4()))
    name = Column(String(255), nullable=False)
    type = Column(String(20), nullable=False)  # text_to_image/image_to_video/tts/asr
    provider = Column(String(20), default="cloud_api")  # local/cloud_api/comfyui
    endpoint = Column(Text)
    api_key = Column(Text)  # 敏感信息，建议加密存储
    config = Column(JSONB, default=dict)
    is_enabled = Column(Boolean, default=True)
    priority = Column(Integer, default=0)
    cost_per_request = Column(Float, default=0.0)
    description = Column(Text)

    def __repr__(self):
        return f"<AIModel {self.name} ({self.type})>"


class PromptTemplate(Base, TimestampMixin):
    """提示词模板表 —— 供剧本解析、分镜生成等 AI 任务复用的 system prompt。

    category 分类（可扩展）：
    - script_parse: 剧本解析（拆分镜/提角色场景道具）
    - shot_generate: 分镜画面提示词生成
    - character_generate: 角色外貌提示词生成
    - scene_generate: 场景画面提示词生成
    - 其他自定义

    content 即完整 system prompt 文本。mode 子类标识（如剧本解析的 fusion/image_to_video）。
    同一 category+mode 下，is_default=True 且 is_enabled=True 的会被自动选用。
    """
    __tablename__ = "prompt_templates"

    id = Column(String(64), primary_key=True, default=lambda: str(uuid4()))
    name = Column(String(255), nullable=False)
    category = Column(String(50), nullable=False)  # script_parse / shot_generate / ...
    mode = Column(String(50), default="default")   # 子模式，如剧本解析的 fusion/image_to_video
    content = Column(Text, nullable=False)          # 完整 system prompt
    description = Column(Text)
    variables = Column(JSONB, default=dict)         # 模板变量说明（可选，纯文档用途）
    is_enabled = Column(Boolean, default=True)
    is_default = Column(Boolean, default=False)     # 同 category+mode 下是否默认选用
    priority = Column(Integer, default=0)

    def __repr__(self):
        return f"<PromptTemplate {self.name} ({self.category}/{self.mode})>"
