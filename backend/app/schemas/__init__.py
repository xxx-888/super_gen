"""
Pydantic Schemas - API请求/响应模型
"""
from datetime import datetime
from typing import Optional, List, Any, Dict
from uuid import UUID
from pydantic import BaseModel, Field, EmailStr


# ==================== 通用响应模型 ====================

class ResponseModel(BaseModel):
    """通用API响应包装"""
    code: int = 200
    message: str = "success"
    data: Optional[Any] = None


class PaginatedResponse(BaseModel):
    """分页响应"""
    items: List[Any]
    total: int
    page: int
    page_size: int
    total_pages: int


# ==================== 用户相关 ====================

class UserBase(BaseModel):
    """用户基础信息"""
    email: EmailStr
    nickname: Optional[str] = None

class UserCreate(UserBase):
    """注册请求"""
    password: str = Field(..., min_length=8, max_length=128)

class UserUpdate(BaseModel):
    """更新用户信息"""
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None

# 兼容别名
UpdateUserRequest = UserUpdate

class UserResponse(UserBase):
    """用户响应"""
    id: UUID
    role: str
    is_active: bool
    created_at: datetime
    avatar_url: Optional[str] = None

    class Config:
        from_attributes = True

class UserAdminResponse(UserResponse):
    """管理员查看的用户详情"""
    project_count: int = 0
    task_count: int = 0
    last_login: Optional[datetime] = None


# ==================== 认证相关 ====================

class TokenResponse(BaseModel):
    """JWT令牌响应"""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # 秒

class TokenPayload(BaseModel):
    """Token载荷"""
    sub: UUID  # user_id
    exp: datetime
    type: str  # access/refresh

class LoginRequest(BaseModel):
    """登录请求"""
    email: EmailStr
    password: str

class RefreshTokenRequest(BaseModel):
    """刷新令牌请求"""
    refresh_token: str


# ==================== 项目相关 ====================

class ProjectBase(BaseModel):
    """项目基础信息"""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None

class ProjectCreate(ProjectBase):
    """创建项目"""
    cover_image_url: Optional[str] = None
    settings: Optional[Dict[str, Any]] = None

class ProjectUpdate(BaseModel):
    """更新项目"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    cover_image_url: Optional[str] = None
    status: Optional[str] = None  # draft/producing/completed/archived
    settings: Optional[Dict[str, Any]] = None

class ProjectResponse(ProjectBase):
    """项目响应"""
    id: UUID
    user_id: UUID
    org_id: Optional[UUID] = None
    status: str
    cover_image_url: Optional[str]
    settings: Dict[str, Any]
    created_at: datetime
    updated_at: Optional[datetime] = None

    # 统计信息(可选，需额外查询)
    script_count: Optional[int] = 0
    scene_count: Optional[int] = 0
    character_count: Optional[int] = 0
    member_count: Optional[int] = 0

    class Config:
        from_attributes = True

class ProjectDetail(ProjectResponse):
    """项目详情(含关联数据)"""
    scripts: Optional[List['ScriptResponse']] = None
    characters: Optional[List['CharacterResponse']] = None
    scene_backgrounds: Optional[List['SceneBackgroundResponse']] = None
    props: Optional[List['PropResponse']] = None
    audio_assets: Optional[List['AudioAssetResponse']] = None

class ProjectStats(BaseModel):
    """项目统计"""
    total_scenes: int
    completed_scenes: int
    pending_scenes: int
    failed_scenes: int
    total_duration: float  # 秒
    estimated_cost: float  # 预估费用(积分)


# ==================== 剧本相关 ====================

class ScriptBase(BaseModel):
    """剧本基础信息"""
    title: Optional[str] = None
    content: str

class ScriptCreate(ScriptBase):
    """创建剧本"""
    format: str = "plain"  # plain/fountain/finaldraft

class ScriptUpdate(BaseModel):
    """更新剧本"""
    title: Optional[str] = None
    content: Optional[str] = None

class ScriptResponse(ScriptBase):
    """剧本响应"""
    id: UUID
    project_id: UUID
    format: str
    parsed_data: Optional[Dict[str, Any]]
    created_at: datetime
    updated_at: Optional[datetime] = None
    scene_count: Optional[int] = 0

    class Config:
        from_attributes = True

class ScriptParseRequest(BaseModel):
    """解析剧本请求"""
    options: Optional[Dict[str, Any]] = {
        "auto_split": True,
        "min_scene_duration": 3,
        "max_scene_duration": 15,
        "extract_characters": True,
        "extract_locations": True,
    }

class ScriptParseResult(BaseModel):
    """解析结果"""
    scenes: List[Dict[str, Any]]
    extracted_characters: List[Dict[str, Any]]
    extracted_locations: List[Dict[str, Any]]
    warnings: List[str]

# 兼容别名
ParseScriptOptions = ScriptParseRequest


# ==================== 分镜相关 ====================

class SceneBase(BaseModel):
    """分镜基础信息"""
    prompt: str
    duration: float = Field(default=5.0, ge=1, le=60)

class SceneCreate(SceneBase):
    """创建分镜"""
    sequence: int
    scene_type: str = "normal"
    camera_angle: Optional[str] = None
    camera_movement: Optional[str] = None
    mood: Optional[str] = None

class SceneUpdate(BaseModel):
    """更新分镜"""
    prompt: Optional[str] = None
    duration: Optional[float] = Field(None, ge=1, le=60)
    scene_type: Optional[str] = None
    camera_angle: Optional[str] = None
    camera_movement: Optional[str] = None
    mood: Optional[str] = None
    status: Optional[str] = None

class SceneResponse(SceneBase):
    """分镜响应"""
    id: UUID
    script_id: UUID
    sequence: int
    scene_type: str
    parsed_prompt: Optional[Dict[str, Any]]
    camera_angle: Optional[str]
    camera_movement: Optional[str]
    mood: Optional[str]
    status: str
    generated_video_url: Optional[str]
    thumbnail_url: Optional[str]
    meta: Dict[str, Any]
    created_at: datetime
    updated_at: Optional[datetime] = None

    # 关联资源
    assets: Optional[List['SceneAssetResponse']] = None

    class Config:
        from_attributes = True

class SceneBatchUpdateItem(BaseModel):
    """批量更新项"""
    id: UUID
    prompt: Optional[str] = None
    duration: Optional[float] = None
    status: Optional[str] = None

class SceneReorderRequest(BaseModel):
    """分镜排序请求"""
    scene_ids: List[UUID]

class PromptReference(BaseModel):
    """@引用解析出的单个资源引用"""
    type: str  # character/scene_bg/prop/audio
    resource_id: UUID
    name: str
    position: Dict[str, Any]  # {"start": int, "end": int}
    expanded_text: str
    raw_text: str


class ParsedPrompt(BaseModel):
    """解析后的提示词(展开@引用后的结构化结果)"""
    original_prompt: str
    expanded_prompt: str
    references: List[PromptReference] = []
    token_count: int = 0
    estimated_quality: str = "acceptable"  # good/acceptable/too_long/too_short


class ScenePromptPreview(BaseModel):
    """提示词预览"""
    original_prompt: str
    expanded_prompt: str
    referenced_resources: List[Dict[str, Any]]
    token_count: int
    estimated_quality: str  # good/acceptable/too_long/too_short


# ==================== 角色相关 ====================

class CharacterBase(BaseModel):
    """角色基础信息"""
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    appearance_prompt: Optional[str] = None

class CharacterCreate(CharacterBase):
    """创建角色"""
    voice_id: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None

class CharacterUpdate(BaseModel):
    """更新角色"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    appearance_prompt: Optional[str] = None
    voice_id: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None

class CharacterResponse(CharacterBase):
    """角色响应"""
    id: UUID
    project_id: UUID
    image_url: Optional[str]
    images: List[Dict[str, Any]]
    voice_id: Optional[str]
    meta: Dict[str, Any]
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class CharacterGenerateImageRequest(BaseModel):
    """生成角色图请求"""
    model: str = "stable-diffusion-xl"
    style: Optional[str] = None  # anime/realistic/etc.
    pose: Optional[str] = None  # front/side/3q/etc.
    expression: Optional[str] = None  # neutral/happy/sad/etc.
    variations: int = Field(default=1, ge=1, le=4)

# 兼容别名
GenerateCharacterImageRequest = CharacterGenerateImageRequest


class GenerateImageOptions(BaseModel):
    """通用 AI 生图选项（角色/场景/道具共用）。
    前端生图时可传这些参数控制尺寸/质量/水印/模型。
    """
    size: Optional[str] = None  # 16:9 / 9:16 / 4:3 / 3:4 / 1:1（不传则按资源类型默认）
    quality: Optional[str] = "hd"  # hd（高质量约20秒）/ standard（快速约8秒）
    watermark_enabled: Optional[bool] = False  # 是否添加水印
    model: Optional[str] = None  # 指定模型名（如 glm-image / cogview-3-flash），不传则用后台配置


# ==================== 场景背景相关 ====================

class SceneBackgroundBase(BaseModel):
    """场景背景基础信息"""
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    prompt: Optional[str] = None

class SceneBackgroundCreate(SceneBackgroundBase):
    """创建场景"""

class SceneBackgroundUpdate(BaseModel):
    """更新场景"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    prompt: Optional[str] = None

class SceneBackgroundResponse(SceneBackgroundBase):
    """场景响应"""
    id: UUID
    project_id: UUID
    image_url: Optional[str]
    meta: Dict[str, Any]
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ==================== 道具相关 ====================

class PropBase(BaseModel):
    """道具基础信息"""
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    prompt: Optional[str] = None

class PropCreate(PropBase):
    """创建道具"""

class PropUpdate(BaseModel):
    """更新道具"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    prompt: Optional[str] = None

class PropResponse(PropBase):
    """道具响应"""
    id: UUID
    project_id: UUID
    image_url: Optional[str]
    meta: Dict[str, Any]
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ==================== 音频资产相关 ====================

class AudioAssetBase(BaseModel):
    """音频基础信息"""
    name: str = Field(..., min_length=1, max_length=100)
    type: str  # dialogue/music/sfx/narration
    content: Optional[str] = None
    url: str

class AudioAssetCreate(AudioAssetBase):
    """创建音频"""
    duration: Optional[float] = None
    character_id: Optional[UUID] = None
    meta: Optional[Dict[str, Any]] = None

class AudioAssetUpdate(BaseModel):
    """更新音频"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    content: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None

class AudioAssetResponse(AudioAssetBase):
    """音频响应"""
    id: UUID
    project_id: UUID
    duration: Optional[float]
    character_id: Optional[UUID]
    character_name: Optional[str] = None
    meta: Dict[str, Any]
    created_at: datetime

    class Config:
        from_attributes = True

class TTSRequest(BaseModel):
    """文字转语音请求"""
    text: str
    voice_id: Optional[str] = None
    model: str = "cosyvoice"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch: float = Field(default=1.0, ge=0.5, le=2.0)


# ==================== 分镜-资源关联 ====================

class SceneAssetCreate(BaseModel):
    """添加资源到分镜"""
    resource_type: str  # character/scene_bg/prop/audio
    resource_id: UUID
    position: Optional[int] = 0
    usage_context: Optional[str] = None

# 兼容别名
AddSceneAssetRequest = SceneAssetCreate

class SceneAssetResponse(BaseModel):
    """分镜资源关联响应"""
    id: UUID
    scene_id: UUID
    resource_type: str
    resource_id: UUID
    position: int
    usage_context: Optional[str]

    # 资源详情(展开)
    resource_detail: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


# ==================== 任务相关 ====================

class GenerationTaskBase(BaseModel):
    """任务基础信息"""
    type: str  # image/video/audio/subtitle/remove_subtitle
    model: str
    input_data: Dict[str, Any]

class GenerationTaskCreate(GenerationTaskBase):
    """创建任务"""
    project_id: UUID

class GenerationTaskResponse(GenerationTaskBase):
    """任务响应"""
    id: UUID
    project_id: Optional[UUID]
    episode_id: Optional[UUID] = None
    output_urls: Optional[List[str]]
    credits_consumed: int = 0
    status: str
    progress: int
    error_message: Optional[str]
    meta: Optional[Dict[str, Any]] = None
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    created_at: datetime
    updated_at: Optional[datetime] = None
    # 关联字段（由后端 join Scene/Episode/Script 填充，DB 列里没有）
    scene_sequence: Optional[int] = None
    episode_number: Optional[int] = None
    episode_title: Optional[str] = None
    script_title: Optional[str] = None
    prompt: Optional[str] = None

    class Config:
        from_attributes = True

class TaskProgressUpdate(BaseModel):
    """任务进度更新(WebSocket)"""
    task_id: UUID
    progress: int
    status: Optional[str] = None
    message: Optional[str] = None
    current_step: Optional[str] = None
    output_url: Optional[str] = None


# ==================== 视频生成相关 ====================

class ImageGenerationRequest(BaseModel):
    """图片生成请求"""
    prompt: str
    model: str = "stable-diffusion-xl"
    negative_prompt: Optional[str] = None
    width: int = Field(default=1024, ge=256, le=2048)
    height: int = Field(default=1024, ge=256, le=2048)
    steps: int = Field(default=30, ge=10, le=150)
    cfg_scale: float = Field(default=7.0, ge=1, le=30)
    seed: Optional[int] = None
    batch_size: int = Field(default=1, ge=1, le=4)

class VideoGenerationRequest(BaseModel):
    """视频生成请求"""
    scene_id: UUID
    model: str = "kling-v1"  # kling/runway/pika/sora/comfyui
    image_url: Optional[str] = None  # 首帧图片(图生视频模式)
    duration: float = Field(default=5.0, ge=2, le=60)
    fps: int = Field(default=24, ge=12, le=60)
    aspect_ratio: str = "16:9"  # 16:9/9:16/1:1
    cfg: Optional[Dict[str, Any]] = None  # 模型特定配置

class BatchVideoGenerationRequest(BaseModel):
    """批量视频生成请求"""
    project_id: UUID
    scene_ids: List[UUID]
    model: str = "kling-v1"
    parallel: int = Field(default=2, ge=1, le=5)  # 并发数
    order: str = "sequence"  # sequence/reverse/random

class FullAutoGenerationRequest(BaseModel):
    """一键全流程生成请求"""
    project_id: UUID
    options: Dict[str, Any] = {
        "generate_missing_images": True,
        "generate_videos": True,
        "add_subtitles": False,
        "model_preferences": {
            "image": "stable-diffusion-xl",
            "video": "kling-v1",
            "audio": "cosyvoice",
        }
    }

class SubtitleRequest(BaseModel):
    """字幕处理请求"""
    video_id: UUID
    action: str  # generate/remove
    language: str = "zh"
    style: Optional[Dict[str, Any]] = None  # 字幕样式

class VideoExportRequest(BaseModel):
    """视频导出请求"""
    format: str = "mp4"  # mp4/webm/mov
    quality: str = "1080p"  # 720p/1080p/4k
    include_subtitles: bool = True
    background_music_id: Optional[UUID] = None
    transition_style: str = "fade"  # fade/dissolve/wipe/none


# ==================== ComfyUI相关 ====================

class ComfyUIWorkflowBase(BaseModel):
    """ComfyUI工作流基础"""
    name: str
    description: Optional[str] = None
    workflow_json: Dict[str, Any]
    tags: Optional[List[str]] = None

class ComfyUIWorkflowCreate(ComfyUIWorkflowBase):
    """创建工作流"""
    is_public: bool = False

class ComfyUIWorkflowUpdate(BaseModel):
    """更新工作流"""
    name: Optional[str] = None
    description: Optional[str] = None
    workflow_json: Optional[Dict[str, Any]] = None
    tags: Optional[List[str]] = None
    is_public: Optional[bool] = None

class ComfyUIWorkflowResponse(ComfyUIWorkflowBase):
    """工作流响应"""
    id: UUID
    user_id: Optional[UUID]
    is_public: bool
    usage_count: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class ComfyUIExecuteRequest(BaseModel):
    """执行工作流请求"""
    workflow_id: UUID
    inputs: Optional[Dict[str, Any]] = None  # 覆盖默认输入

class ComfyUIExecutionStatus(BaseModel):
    """执行状态"""
    execution_id: str
    status: str  # queued/running/completed/error
    progress: float
    current_node: Optional[str] = None
    outputs: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


# ==================== 文件上传相关 ====================

class FileUploadResponse(BaseModel):
    """文件上传响应"""
    file_id: UUID
    filename: str
    url: str
    size: int
    mime_type: str
    width: Optional[int] = None  # 图片/视频宽
    height: Optional[int] = None  # 图片/视频高
    duration: Optional[float] = None  # 音频/视频时长


# ==================== 后台管理相关 ====================

class AdminStatsResponse(BaseModel):
    """平台统计"""
    total_users: int
    active_users_today: int
    total_projects: int
    total_tasks: int
    tasks_by_status: Dict[str, int]
    storage_used: float  # GB
    popular_models: List[Dict[str, int]]

# 兼容别名
AdminStats = AdminStatsResponse

class SystemSettingsUpdate(BaseModel):
    """系统设置更新"""
    settings: Dict[str, Any]

class ModelConfig(BaseModel):
    """模型配置"""
    id: str
    name: str
    type: str  # text_to_image/image_to_video/tts/asr
    provider: str  # local/cloud_api/comfyui
    endpoint: Optional[str] = None
    api_key: Optional[str] = None  # 加密存储
    config: Dict[str, Any] = {}
    is_enabled: bool = True
    priority: int = 0
    cost_per_request: float = 0.0
    description: Optional[str] = None

    class Config:
        from_attributes = True


class AIModelCreate(BaseModel):
    """创建模型配置"""
    name: str = Field(..., min_length=1, max_length=255)
    type: str  # text_to_image/image_to_video/tts/asr
    provider: str = "cloud_api"  # local/cloud_api/comfyui
    endpoint: Optional[str] = None
    api_key: Optional[str] = None
    config: Dict[str, Any] = {}
    is_enabled: bool = True
    priority: int = 0
    cost_per_request: float = 0.0
    description: Optional[str] = None


class AIModelUpdate(BaseModel):
    """更新模型配置"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    type: Optional[str] = None
    provider: Optional[str] = None
    endpoint: Optional[str] = None
    api_key: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    is_enabled: Optional[bool] = None
    priority: Optional[int] = None
    cost_per_request: Optional[float] = None
    description: Optional[str] = None


# ==================== 提示词模板 ====================

class PromptTemplateResponse(BaseModel):
    """提示词模板 (response)"""
    id: str
    name: str
    category: str  # script_parse / shot_generate / ...
    mode: str = "default"
    content: str
    description: Optional[str] = None
    variables: Dict[str, Any] = {}
    is_enabled: bool = True
    is_default: bool = False
    priority: int = 0

    class Config:
        from_attributes = True


class PromptTemplateCreate(BaseModel):
    """创建提示词模板"""
    name: str = Field(..., min_length=1, max_length=255)
    category: str = Field(..., min_length=1, max_length=50)
    mode: str = Field("default", max_length=50)
    content: str = Field(..., min_length=1)
    description: Optional[str] = None
    variables: Dict[str, Any] = {}
    is_enabled: bool = True
    is_default: bool = False
    priority: int = 0


class PromptTemplateUpdate(BaseModel):
    """更新提示词模板（部分更新）"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    category: Optional[str] = Field(None, min_length=1, max_length=50)
    mode: Optional[str] = Field(None, max_length=50)
    content: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = None
    variables: Optional[Dict[str, Any]] = None
    is_enabled: Optional[bool] = None
    is_default: Optional[bool] = None
    priority: Optional[int] = None


# ==================== 组织/团队 (M1 多租户) ====================

class OrganizationCreate(BaseModel):
    """创建团队"""
    name: str = Field(..., min_length=1, max_length=255)
    avatar_url: Optional[str] = None


class OrganizationUpdate(BaseModel):
    """更新团队"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    avatar_url: Optional[str] = None
    storage_quota_mb: Optional[int] = Field(None, ge=1)


class MembershipResponse(BaseModel):
    """成员关系响应"""
    id: UUID
    org_id: UUID
    user_id: UUID
    role: str
    display_name: Optional[str] = None
    is_active: bool

    class Config:
        from_attributes = True


class OrganizationResponse(BaseModel):
    """团队响应"""
    id: UUID
    name: str
    avatar_url: Optional[str] = None
    owner_id: UUID
    is_personal: bool
    storage_quota_mb: int
    storage_used_mb: int
    role: Optional[str] = None  # 当前用户在该团队的角色(由接口注入)
    credit_balance: Optional[int] = None  # 当前积分余额(由接口注入)
    created_at: datetime

    class Config:
        from_attributes = True


# ==================== 积分系统 (M1) ====================

class CreditAccountResponse(BaseModel):
    """积分账户响应"""
    id: UUID
    org_id: UUID
    balance: int
    allocated: int
    total_recharged: int
    total_consumed: int

    class Config:
        from_attributes = True


class CreditTransactionResponse(BaseModel):
    """积分流水响应"""
    id: UUID
    org_id: UUID
    user_id: Optional[UUID] = None
    project_id: Optional[UUID] = None
    task_id: Optional[UUID] = None
    type: str
    amount: int
    balance_after: int
    model: Optional[str] = None
    remark: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None
    created_at: datetime

    class Config:
        from_attributes = True


class CreditRechargeRequest(BaseModel):
    """充值请求(后台手动充值)"""
    amount: int = Field(..., gt=0, description="充值积分数量")
    remark: Optional[str] = None


class CreditAllocateRequest(BaseModel):
    """给成员分配积分"""
    user_id: UUID
    amount: int = Field(..., description="正数=增加配额, 负数=回收")
    remark: Optional[str] = None


class CreditAllocationResponse(BaseModel):
    """成员积分配额响应"""
    id: UUID
    org_id: UUID
    user_id: UUID
    quota: int
    used: int

    class Config:
        from_attributes = True


# ==================== 团队管理 (M2) ====================

class MemberInviteRequest(BaseModel):
    """邀请成员"""
    email: EmailStr
    role: str = Field("member", pattern="^(admin|member)$")
    display_name: Optional[str] = None
    password: Optional[str] = Field(None, min_length=8, description="新用户初始密码")


class MemberUpdateRequest(BaseModel):
    """编辑成员"""
    role: Optional[str] = Field(None, pattern="^(admin|member)$")
    display_name: Optional[str] = None


class ResetPasswordRequest(BaseModel):
    """重置密码"""
    new_password: str = Field(..., min_length=8)


class BatchUpdateProjectsRequest(BaseModel):
    """批量修改成员项目归属"""
    user_ids: List[UUID]
    project_ids: List[UUID]


class MemberGroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    leader_id: Optional[UUID] = None
    description: Optional[str] = None
    member_ids: Optional[List[UUID]] = None


class MemberGroupUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    leader_id: Optional[UUID] = None
    description: Optional[str] = None
    member_ids: Optional[List[UUID]] = None


class MemberGroupResponse(BaseModel):
    id: str
    name: str
    leader_id: Optional[str] = None
    leader_name: Optional[str] = None
    description: Optional[str] = None
    member_ids: List[str] = []
    member_count: int = 0
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PermissionGroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    permissions: Optional[Dict[str, Any]] = None


class PermissionGroupUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    permissions: Optional[Dict[str, Any]] = None


class PermissionGroupResponse(BaseModel):
    id: UUID
    org_id: UUID
    name: str
    description: Optional[str] = None
    permissions: Dict[str, Any] = {}
    created_at: datetime

    class Config:
        from_attributes = True


class MaterialPermissionRequest(BaseModel):
    """设置成员素材库权限"""
    can_view: Optional[bool] = None
    can_upload: Optional[bool] = None
    can_download: Optional[bool] = None
    can_edit: Optional[bool] = None
    can_delete: Optional[bool] = None
    can_invoke: Optional[bool] = None


class BatchMaterialPermissionRequest(BaseModel):
    """批量设置素材库权限"""
    user_ids: List[UUID]
    permissions: Dict[str, bool]


class MaterialPermissionResponse(BaseModel):
    id: UUID
    org_id: UUID
    user_id: UUID
    can_view: bool
    can_upload: bool
    can_download: bool
    can_edit: bool
    can_delete: bool
    can_invoke: bool

    class Config:
        from_attributes = True


# ==================== 企业素材库 (M3) ====================

class TeamFolderResponse(BaseModel):
    id: UUID
    org_id: UUID
    class_type: str
    name: str
    parent_id: Optional[UUID] = None
    item_count: int = 0
    created_at: datetime

    class Config:
        from_attributes = True


class TeamFolderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    class_type: str
    parent_id: Optional[UUID] = None


class TeamMaterialResponse(BaseModel):
    id: UUID
    org_id: UUID
    category: str
    class_type: Optional[str] = None
    folder_id: Optional[UUID] = None
    name: str
    url: str
    thumbnail_url: Optional[str] = None
    size_bytes: int = 0
    mime_type: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    duration: Optional[float] = None
    meta: Optional[Dict[str, Any]] = None
    uploaded_by: Optional[UUID] = None
    created_at: datetime

    class Config:
        from_attributes = True


class TeamMaterialUpdate(BaseModel):
    name: Optional[str] = None
    class_type: Optional[str] = None
    folder_id: Optional[UUID] = None
    meta: Optional[Dict[str, Any]] = None


class MoveMaterialRequest(BaseModel):
    folder_id: Optional[UUID] = None


class SyncToProjectRequest(BaseModel):
    project_id: UUID
    target_type: str  # character/scene_bg/prop/audio


class StorageUsageResponse(BaseModel):
    used_bytes: int
    used_mb: int
    quota_mb: int
    usage_percent: float
    by_category: Dict[str, int]


# ==================== 集(Episode) 片段管理 (M4) ====================

class EpisodeCreate(BaseModel):
    number: Optional[int] = Field(None, ge=1, description="集号(不传则自动递增)")
    title: Optional[str] = None
    script_id: Optional[UUID] = None


class EpisodeUpdate(BaseModel):
    title: Optional[str] = None
    cover_image_url: Optional[str] = None


class EpisodeStatusUpdate(BaseModel):
    status: str  # asset/pending_submit/video_editing/completed


class ReorderRequest(BaseModel):
    episode_ids: List[UUID]


class ToggleRequest(BaseModel):
    value: bool


# ==================== AI 创作工作流 (M5) ====================

class GenElementSchema(BaseModel):
    """生成元素"""
    type: str  # character/scene/prop/pose/effect
    name: str
    image_url: Optional[str] = None


class CreationRequest(BaseModel):
    """统一创作请求(融合生图/图生视频/首尾帧/对口型/TTS/图片改创)"""
    prompt: str = ""
    elements: Optional[List[GenElementSchema]] = None
    size: str = "16:9"
    count: int = Field(1, ge=1, le=5)
    image_url: Optional[str] = None
    first_frame_url: Optional[str] = None
    last_frame_url: Optional[str] = None
    video_url: Optional[str] = None
    audio_url: Optional[str] = None
    text: Optional[str] = None
    voice_id: Optional[str] = None
    duration: Optional[float] = None
    # 单镜生成用：指定模型（AIModel.id 或模型标识）与生成参数
    model: Optional[str] = None
    quality: Optional[str] = None          # hd / standard
    watermark_enabled: Optional[bool] = None
    resolution: Optional[str] = None       # 480p/720p/1080p/2k/4k


# ==================== 工作台 & 作品展示 (M6) ====================

class NarrationOneClickRequest(BaseModel):
    """解说剧一键成片"""
    script_content: str = Field(..., min_length=1)
    title: Optional[str] = None
    voice_id: Optional[str] = None


class VideoTransferRequest(BaseModel):
    """一键转绘"""
    video_url: str
    style: str = "anime"  # anime/comic/realistic/oil
    frame_count: int = Field(4, ge=1, le=6)


class PublishWorkRequest(BaseModel):
    """发布作品"""
    title: Optional[str] = None
    description: Optional[str] = None
    project_id: Optional[UUID] = None
    episode_id: Optional[UUID] = None
    video_url: Optional[str] = None
    cover_url: Optional[str] = None
    tags: Optional[List[str]] = None


class UpdateWorkRequest(BaseModel):
    """更新作品"""
    title: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    video_url: Optional[str] = None


# ==================== 画布面板 (Canvas Panel) ====================

class CanvasCreate(BaseModel):
    """新建画布"""
    name: Optional[str] = Field(None, max_length=255, description="画布名称(不传则自动命名)")
    graph_data: Optional[Dict[str, Any]] = Field(None, description="React Flow {nodes, edges} 结构")


class CanvasUpdate(BaseModel):
    """更新画布(保存)"""
    name: Optional[str] = Field(None, max_length=255)
    graph_data: Optional[Dict[str, Any]] = None
    thumbnail_url: Optional[str] = None
    # 乐观锁：客户端传入期望的版本号，不匹配则拒绝
    version: Optional[int] = Field(None, ge=1, description="乐观锁版本号")


class CanvasResponse(BaseModel):
    """画布详情响应"""
    id: UUID
    project_id: UUID
    org_id: Optional[UUID] = None
    user_id: UUID
    name: str
    graph_data: Optional[Dict[str, Any]] = None
    thumbnail_url: Optional[str] = None
    version: int
    meta: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class CanvasListItem(BaseModel):
    """画布列表项(精简)"""
    id: UUID
    project_id: UUID
    name: str
    thumbnail_url: Optional[str] = None
    version: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    tags: Optional[List[str]] = None
    is_public: Optional[bool] = None


# 更新前向引用
ProjectDetail.model_rebuild()
SceneResponse.model_rebuild()
