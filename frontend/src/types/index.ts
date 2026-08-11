/**
 * TypeScript Type Definitions - AI短剧生成平台前端
 *
 * 与后端 Pydantic Schemas 保持一致
 */

// ==================== 基础类型 ====================

export type UUID = string;
export type DateTime = string; // ISO 8601

export interface ApiResponse<T = any> {
  code: number;
  message: string;
  data: T;
}

export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface PaginationParams {
  page?: number;
  page_size?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

// ==================== 用户相关 ====================

export interface User {
  id: UUID;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
  role: 'admin' | 'user';
  is_active: boolean;
  created_at: DateTime;
}

export interface UserAdmin extends User {
  project_count: number;
  task_count: number;
  last_login: DateTime | null;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  nickname?: string;
}

export interface UpdateUserRequest {
  nickname?: string;
  avatar_url?: string;
}

// ==================== 认证相关 ====================

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest extends LoginRequest {
  nickname?: string;
}

// ==================== 项目相关 ====================

export type ProjectStatus = 'draft' | 'producing' | 'completed' | 'archived';

export interface ProjectSettings {
  default_image_model?: string;
  default_video_model?: string;
  default_audio_model?: string;
  video_resolution?: '720p' | '1080p' | '4k';
  video_fps?: number;
  output_format?: 'mp4' | 'webm';
  // ComfyUI 工作流设置
  comfyui_workflow_id?: UUID;
}

export interface Project {
  id: UUID;
  user_id: UUID;
  org_id?: UUID;
  name: string;
  description: string | null;
  cover_image_url: string | null;
  status: ProjectStatus;
  settings: ProjectSettings;
  created_at: DateTime;
  updated_at: DateTime;

  // 统计(可选)
  script_count?: number;
  scene_count?: number;
  character_count?: number;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  cover_image_url?: string;
  settings?: Partial<ProjectSettings>;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  cover_image_url?: string;
  status?: ProjectStatus;
  settings?: Partial<ProjectSettings>;
}

export interface ProjectStats {
  total_scenes: number;
  completed_scenes: number;
  pending_scenes: number;
  failed_scenes: number;
  total_duration: number; // 秒
  estimated_cost: number; // 积分
}

// ==================== 剧本相关 ====================

export type ScriptFormat = 'plain' | 'fountain' | 'finaldraft';

export interface ParsedSceneData {
  sequence: number;
  scene_heading?: string; // 场景标题 (INT./EXT.)
  action?: string; // 动作描述
  dialogue?: Array<{
    character: string;
    text: string;
    parenthetical?: string;
  }>;
  transition?: string; // 转场
  duration_estimate?: number;
  mood?: string;
  characters_involved: string[];
  location?: string;
}

export interface ScriptParseResult {
  // ===== 旧格式（正则解析）=====
  /** 旧格式：分镜列表（ParsedSceneData）；新格式：场景背景列表（{name,description,prompt}）。
   *  因新旧格式共用 scenes 键但结构不同，这里用 any[] 兼容。 */
  scenes?: any[];
  extracted_characters?: Array<{
    name: string;
    descriptions: string[];
  }>;
  extracted_locations?: Array<{
    name: string;
    descriptions: string[];
  }>;
  warnings?: string[];
  // ===== 新格式（LLM 解析）=====
  /** 分镜清单（LLM 解析）—— 旧格式里分镜存在 scenes 里，注意区分 */
  shots?: any[];
  /** 角色清单（LLM 解析） */
  characters?: any[];
  /** 道具清单（LLM 解析） */
  props?: any[];
  source?: string;       // "llm" | "fallback" | "error" | "empty"
  preview?: boolean;
  confirmed?: boolean;
  error?: string;
}

export interface Script {
  id: UUID;
  project_id: UUID;
  title: string | null;
  content: string;
  format: ScriptFormat;
  parsed_data: ScriptParseResult | null;
  created_at: DateTime;
  updated_at: DateTime;
  scene_count?: number;
}

export interface CreateScriptRequest {
  title?: string;
  content: string;
  format?: ScriptFormat;
}

export interface UpdateScriptRequest {
  title?: string;
  content?: string;
}

export interface ParseScriptOptions {
  auto_split?: boolean;
  min_scene_duration?: number;
  max_scene_duration?: number;
  extract_characters?: boolean;
  extract_locations?: boolean;
}

// ==================== 分镜相关 (核心) ====================

export type SceneType = 'normal' | 'title' | 'transition';
export type SceneStatus = 'pending' | 'ready' | 'generating' | 'completed' | 'failed';

export type CameraAngle =
  | 'extreme_close_up'
  | 'close_up'
  | 'medium_close_up'
  | 'medium'
  | 'medium_wide'
  | 'wide'
  | 'extreme_wide'
  | 'bird_eye'
  | 'low_angle'
  | 'high_angle'
  | 'dutch_angle'
  | 'over_shoulder'
  | 'point_of_view';

export type CameraMovement =
  | 'static'
  | 'pan_left'
  | 'pan_right'
  | 'tilt_up'
  | 'tilt_down'
  | 'zoom_in'
  | 'zoom_out'
  | 'dolly_in'
  | 'dolly_out'
  | 'tracking'
  | 'arc'
  | 'crane'
  | 'handheld'
  | 'steadicam';

export interface SceneMetadata {
  // 自定义元数据
  [key: string]: any;
}

export interface Scene {
  id: UUID;
  script_id: UUID;
  sequence: number;
  scene_type: SceneType;

  // 提示词
  prompt: string; // 原始提示词(包含@引用)
  parsed_prompt: ParsedPrompt | null; // 解析后的提示词

  // 镜头设置
  duration: number; // 秒
  camera_angle: CameraAngle | null;
  camera_movement: CameraMovement | null;
  mood: string | null;

  // 状态与输出
  status: SceneStatus;
  generated_video_url: string | null;
  thumbnail_url: string | null;
  meta: SceneMetadata;

  created_at: DateTime;
  updated_at: DateTime;

  // 关联资源
  assets?: SceneAsset[];
}

export interface CreateSceneRequest {
  sequence: number;
  prompt: string;
  duration?: number;
  scene_type?: SceneType;
  camera_angle?: CameraAngle;
  camera_movement?: CameraMovement;
  mood?: string;
}

export interface UpdateSceneRequest {
  prompt?: string;
  duration?: number;
  scene_type?: SceneType;
  camera_angle?: CameraAngle;
  camera_movement?: CameraMovement;
  mood?: string;
  status?: SceneStatus;
}

export interface BatchUpdateItem {
  id: UUID;
  prompt?: string;
  duration?: number;
  status?: SceneStatus;
}

/**
 * 解析后的提示词结构
 * 用于存储@引用展开后的完整信息
 */
export interface ParsedPrompt {
  /** 展开后的完整文本 */
  full_text: string;
  /** 引用的资源列表 */
  references: PromptReference[];
  /** Token数估算 */
  token_count: number;
}

export interface PromptReference {
  /** 资源类型 */
  type: 'character' | 'scene_bg' | 'prop' | 'audio';
  /** 资源ID */
  resource_id: UUID;
  /** 资源名称(显示用) */
  name: string;
  /** 在原始提示词中的位置 */
  position: { start: number; end: number };
  /** 展开的描述文本 */
  expanded_text: string;
  /** 原始引用文本(如 "@沈如姬") */
  raw_text: string;
}

export interface ScenePromptPreview {
  original_prompt: string;
  expanded_prompt: string;
  referenced_resources: Array<{
    type: string;
    id: UUID;
    name: string;
    preview_url?: string;
  }>;
  token_count: number;
  estimated_quality: 'good' | 'acceptable' | 'too_long' | 'too_short';
}

// ==================== 角色相关 ====================

export interface CharacterImages {
  url: string;
  type: 'main' | 'front' | 'side' | '3q' | 'expression';
  label?: string;
}

export interface CharacterMetadata {
  age?: string;
  gender?: string;
  personality?: string;
  clothing_style?: string;
  [key: string]: any;
}

export interface Character {
  id: UUID;
  project_id: UUID;
  name: string;
  description: string | null;
  appearance_prompt: string | null; // 外观描述
  image_url: string | null; // 主图
  images: CharacterImages[]; // 多角度图片
  voice_id: string | null; // 音色ID
  meta: CharacterMetadata;
  created_at: DateTime;
  updated_at: DateTime;
}

export interface CreateCharacterRequest {
  name: string;
  description?: string;
  appearance_prompt?: string;
  voice_id?: string;
  meta?: Partial<CharacterMetadata>;
}

export interface UpdateCharacterRequest {
  name?: string;
  description?: string;
  appearance_prompt?: string;
  voice_id?: string;
  meta?: Partial<CharacterMetadata>;
}

export interface GenerateCharacterImageRequest {
  model?: string;
  style?: 'anime' | 'realistic' | 'semi_realistic' | 'oil_painting';
  pose?: 'front' | 'side' | '3q' | 'back' | 'action';
  expression?: 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised';
  variations?: number; // 1-4
}

// ==================== 场景背景相关 ====================

export interface SceneBackground {
  id: UUID;
  project_id: UUID;
  name: string;
  description: string | null;
  prompt: string | null;
  image_url: string | null;
  meta: Record<string, any>;
  created_at: DateTime;
  updated_at: DateTime;
}

export interface CreateSceneBackgroundRequest {
  name: string;
  description?: string;
  prompt?: string;
}

export interface UpdateSceneBackgroundRequest {
  name?: string;
  description?: string;
  prompt?: string;
}

// ==================== 道具相关 ====================

export interface Prop {
  id: UUID;
  project_id: UUID;
  name: string;
  description: string | null;
  prompt: string | null;
  image_url: string | null;
  meta: Record<string, any>;
  created_at: DateTime;
  updated_at: DateTime;
}

export interface CreatePropRequest {
  name: string;
  description?: string;
  prompt?: string;
}

export interface UpdatePropRequest {
  name?: string;
  description?: string;
  prompt?: string;
}

// ==================== 音频资产相关 ====================

export type AudioType = 'dialogue' | 'music' | 'sfx' | 'narration';

export interface AudioAsset {
  id: UUID;
  project_id: UUID;
  name: string;
  type: AudioType;
  content: string | null; // 台词或描述
  url: string;
  duration: number | null;
  character_id: UUID | null;
  character_name?: string | null;
  meta: Record<string, any>;
  created_at: DateTime;
}

export interface CreateAudioAssetRequest {
  name: string;
  type: AudioType;
  content?: string;
  url: string;
  duration?: number;
  character_id?: UUID;
  meta?: Record<string, any>;
}

export interface UpdateAudioAssetRequest {
  name?: string;
  content?: string;
  meta?: Record<string, any>;
}

export interface TTSRequest {
  text: string;
  voice_id?: string;
  model?: string;
  speed?: number; // 0.5 - 2.0
  pitch?: number; // 0.5 - 2.0
}

// ==================== 分镜-资源关联 ====================

export type ResourceType = 'character' | 'scene_bg' | 'prop' | 'audio';

export interface SceneAsset {
  id: UUID;
  scene_id: UUID;
  resource_type: ResourceType;
  resource_id: UUID;
  position: number;
  usage_context: string | null;
  resource_detail?: Character | SceneBackground | Prop | AudioAsset;
}

export interface AddSceneAssetRequest {
  resource_type: ResourceType;
  resource_id: UUID;
  position?: number;
  usage_context?: string;
}

// ==================== 任务相关 ====================

export type TaskType = 'image' | 'video' | 'audio' | 'subtitle' | 'remove_subtitle';
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface GenerationTask {
  id: UUID;
  project_id: UUID | null;
  type: TaskType;
  model: string;
  input_data: Record<string, any>;
  output_urls: string[] | null;
  status: TaskStatus;
  progress: number; // 0-100
  error_message: string | null;
  started_at: DateTime | null;
  completed_at: DateTime | null;
  created_at: DateTime;
}

export interface CreateGenerationTaskRequest {
  type: TaskType;
  model: string;
  input_data: Record<string, any>;
  project_id: UUID;
}

export interface TaskProgressUpdate {
  task_id: UUID;
  progress: number;
  status?: TaskStatus;
  message?: string;
  current_step?: string;
  output_url?: string;
}

// ==================== 视频生成相关 ====================

export interface ImageGenerationRequest {
  prompt: string;
  model?: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg_scale?: number;
  seed?: number;
  batch_size?: number;
}

export interface VideoGenerationRequest {
  scene_id: UUID;
  model?: string;
  image_url?: string;
  duration?: number;
  fps?: number;
  aspect_ratio?: '16:9' | '9:16' | '1:1';
  cfg?: Record<string, any>;
}

export interface BatchVideoGenerationRequest {
  project_id: UUID;
  scene_ids: UUID[];
  model?: string;
  parallel?: number;
  order?: 'sequence' | 'reverse' | 'random';
}

export interface FullAutoGenerationOptions {
  generate_missing_images?: boolean;
  generate_videos?: boolean;
  add_subtitles?: boolean;
  model_preferences?: {
    image?: string;
    video?: string;
    audio?: string;
  };
}

export interface FullAutoGenerationRequest {
  project_id: UUID;
  options?: FullAutoGenerationOptions;
}

export interface SubtitleRequest {
  video_id: UUID;
  action: 'generate' | 'remove';
  language?: string;
  style?: Record<string, any>;
}

export interface VideoExportRequest {
  format?: 'mp4' | 'webm' | 'mov';
  quality?: '720p' | '1080p' | '4k';
  include_subtitles?: boolean;
  background_music_id?: UUID;
  transition_style?: 'fade' | 'dissolve' | 'wipe' | 'none';
}

// ==================== ComfyUI相关 ====================

export interface ComfyUIWorkflow {
  id: UUID;
  user_id: UUID | null;
  name: string;
  description: string | null;
  workflow_json: Record<string, any>; // ComfyUI API格式
  is_public: boolean;
  tags: string[];
  usage_count: number;
  created_at: DateTime;
  updated_at: DateTime;
}

export interface CreateComfyUIWorkflowRequest {
  name: string;
  description?: string;
  workflow_json: Record<string, any>;
  tags?: string[];
  is_public?: boolean;
}

export interface UpdateComfyUIWorkflowRequest {
  name?: string;
  description?: string;
  workflow_json?: Record<string, any>;
  tags?: string[];
  is_public?: boolean;
}

export interface ExecuteWorkflowRequest {
  workflow_id: UUID;
  inputs?: Record<string, any>;
}

export interface ComfyUIExecutionStatus {
  execution_id: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  progress: number;
  current_node?: string | null;
  outputs?: Record<string, any> | null;
  error?: string | null;
  started_at?: DateTime | null;
  completed_at?: DateTime | null;
}

// ==================== 文件上传相关 ====================

export interface FileUploadResponse {
  file_id: UUID;
  filename: string;
  url: string;
  size: number;
  mime_type: string;
  width?: number;
  height?: number;
  duration?: number;
}

// ==================== 后台管理相关 ====================

export interface AdminStats {
  total_users: number;
  active_users_today: number;
  total_projects: number;
  total_tasks: number;
  tasks_by_status: Record<TaskStatus, number>;
  storage_used: number; // GB
  popular_models: Array<{ model: string; count: number }>;
}

export interface ModelConfig {
  id: string;
  name: string;
  type: 'text_to_image' | 'image_to_video' | 'tts' | 'asr';
  provider: 'local' | 'cloud_api' | 'comfyui';
  endpoint?: string | null;
  api_key?: string | null; // 前端不显示
  config: Record<string, any>;
  is_enabled: boolean;
  priority: number;
  cost_per_request: number;
}

// ==================== 编辑器相关类型 ====================

/**
 * 提示词编辑器使用的内部数据结构
 */
export interface EditorMentionItem {
  type: ResourceType;
  id: UUID;
  name: string;
  displayText: string; // 显示文本，如 "沈如姬"
  imageUrl?: string | null; // 缩略图
  data: Character | SceneBackground | Prop | AudioAsset; // 完整数据
}

/**
 * 编辑器状态
 */
export interface EditorState {
  originalPrompt: string;
  mentions: EditorMentionItem[];
  isDirty: boolean;
  isValid: boolean;
  validationErrors: string[];
}

/**
 * 资源面板筛选条件
 */
export interface ResourceFilter {
  type?: ResourceType | 'all';
  search?: string;
  sortBy?: 'name' | 'created' | 'used';
}

// ==================== WebSocket事件类型 ====================

export type WSEventType =
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'comfyui.output'
  | 'comfyui.progress'
  | 'notification';

export interface WSEvent<T = any> {
  type: WSEventType;
  payload: T;
  timestamp: DateTime;
}

// ==================== 组织/团队 (M1) ====================

export interface Organization {
  id: string;
  name: string;
  avatar_url?: string | null;
  owner_id: string;
  is_personal: boolean;
  storage_quota_mb: number;
  storage_used_mb: number;
  role?: string | null;          // 当前用户在该团队的角色
  credit_balance?: number | null; // 当前积分余额
  created_at: DateTime;
}

export interface OrganizationCreate {
  name: string;
  avatar_url?: string;
}

// ==================== 积分系统 (M1) ====================

export interface CreditAccount {
  id: string;
  org_id: string;
  balance: number;
  allocated: number;
  total_recharged: number;
  total_consumed: number;
}

export type CreditTxType = 'recharge' | 'allocate' | 'consume' | 'refund' | 'adjust';

export interface CreditTransaction {
  id: string;
  org_id: string;
  user_id?: string | null;
  project_id?: string | null;
  task_id?: string | null;
  type: CreditTxType;
  amount: number;
  balance_after: number;
  model?: string | null;
  remark?: string | null;
  meta?: Record<string, any> | null;
  created_at: DateTime;
}

export interface CreditAllocation {
  id: string;
  org_id: string;
  user_id: string;
  quota: number;
  used: number;
}

// ==================== 团队管理 (M2) ====================

export interface TeamMember {
  user_id: string;
  email: string;
  nickname: string;
  avatar_url?: string | null;
  role: string;            // owner/admin/member
  is_active: boolean;
  joined_at?: string | null;
  credit_quota: number;
  credit_used: number;
  projects: string[];
}

export interface MemberGroup {
  id: string;
  name: string;
  leader_id?: string | null;
  leader_name?: string | null;
  description?: string | null;
  member_ids: string[];
  member_count: number;
  created_at?: string | null;
}

export interface PermissionGroup {
  id: string;
  org_id: string;
  name: string;
  description?: string | null;
  permissions: Record<string, boolean>;
  created_at: string;
}

export interface MaterialPermission {
  id: string;
  org_id: string;
  user_id: string;
  can_view: boolean;
  can_upload: boolean;
  can_download: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_invoke: boolean;
}

export interface DashboardData {
  overview: {
    project_count: number;
    clip_count: number;
    credit_balance: number;
    credit_allocated: number;
    credit_consumed: number;
  };
  credit_trend: Array<{ date: string; consumed: number }>;
  project_ranking: Array<{ project_id: string; name: string; status: string; consumed: number }>;
  member_ranking: Array<{ user_id: string | null; name: string; consumed: number }>;
}

export interface CreditStatsResult {
  dimension: 'project' | 'account';
  items: Array<Record<string, any>>;
}

export interface OperationLogItem {
  id: string;
  action: string;
  detail?: string | null;
  operator_id?: string | null;
  created_at?: string | null;
}

// ==================== 文件上传 (M1) ====================

export interface FileUploadResult {
  url: string;
  filename: string;
  size: number;
  mime_type: string;
  category: 'image' | 'video' | 'audio';
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

// ==================== 企业素材库 (M3) ====================

export interface TeamFolder {
  id: string;
  org_id: string;
  class_type: string;  // character/scene/prop/general
  name: string;
  parent_id?: string | null;
  item_count: number;
  created_at: string;
}

export interface TeamMaterial {
  id: string;
  org_id: string;
  category: 'image' | 'video' | 'audio';
  class_type?: string | null;
  folder_id?: string | null;
  name: string;
  url: string;
  thumbnail_url?: string | null;
  size_bytes: number;
  mime_type?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  meta?: Record<string, any> | null;
  uploaded_by?: string | null;
  created_at: string;
}

export interface StorageUsage {
  used_bytes: number;
  used_mb: number;
  quota_mb: number;
  usage_percent: number;
  by_category: Record<string, number>;
}

// ==================== 集(Episode) 片段管理 (M4) ====================

export type EpisodeStatus = 'asset' | 'pending_submit' | 'video_editing' | 'completed';

export interface Episode {
  id: string;
  project_id: string;
  number: number;
  title: string;
  status: EpisodeStatus;
  stop_after_step: boolean;
  smart_review: boolean;
  cover_image_url?: string | null;
  sort_order: number;
  scene_count: number;
  completed_count: number;
  created_at?: string;
  updated_at?: string;
}

export const EPISODE_STATUS_LABELS: Record<EpisodeStatus, string> = {
  asset: '资产',
  pending_submit: '待提交',
  video_editing: '视频编辑',
  completed: '已完成',
};

// ==================== AI 创作工作流 (M5) ====================

export interface GenElementInput {
  type: 'character' | 'scene' | 'prop' | 'pose' | 'effect';
  name: string;
  image_url?: string;
  /** 关联的项目资源 id（从素材库导入或新建后回填，用于后续去重和引用） */
  resource_id?: string;
  /** 关联的素材库原始素材 id（来自库选择时存在） */
  material_id?: string;
}

export interface CreationRequest {
  prompt?: string;
  elements?: GenElementInput[];
  size?: string;
  count?: number;
  image_url?: string;
  first_frame_url?: string;
  last_frame_url?: string;
  video_url?: string;
  audio_url?: string;
  text?: string;
  voice_id?: string;
  duration?: number;
}

export interface CreationResult {
  task_id: string;
  status: string;
  urls: string[];
  credits_consumed: number;
}

export type CreationMode = 'fusion' | 'image_to_video' | 'first_last_frame';

export const SHOT_TYPES = ['对话场景', '动作场景', '风景空镜', '特写镜头', '转场'];

// ==================== 工作台 & 作品展示 (M6) ====================

export interface Work {
  id: string;
  title: string;
  description?: string | null;
  cover_url?: string | null;
  video_url?: string | null;
  duration?: number | null;
  source_type: string;
  is_public: boolean;
  view_count: number;
  like_count: number;
  tags: string[];
  user_id: string;
  published_at?: string | null;
  created_at?: string;
}

export interface NarrationResult {
  title: string;
  segments: Array<{ segment: number; text: string; audio_url?: string; image_url?: string }>;
  video_url: string;
  total_credits: number;
  segment_count: number;
  message: string;
}

export interface VideoTransferResult {
  style: string;
  frames: Array<{ frame: number; image_url?: string }>;
  total_credits: number;
  message: string;
}

export const VIDEO_STYLES = [
  { key: 'anime', label: '动漫风' },
  { key: 'comic', label: '美漫风' },
  { key: 'realistic', label: '写实风' },
  { key: 'oil', label: '油画风' },
];

// ==================== 项目成员管理 ====================

export interface ProjectMember {
  id: string;
  user_id: string;
  email: string;
  nickname: string;
  avatar_url?: string | null;
  role: string;  // owner/manager/editor/viewer
  is_active: boolean;
  joined_at?: string;
}

export const PROJECT_ROLES = [
  { key: 'owner', label: '负责人' },
  { key: 'manager', label: '管理者' },
  { key: 'editor', label: '编辑' },
  { key: 'viewer', label: '只读' },
];

// ==================== 生成比例 ====================
// 图片/视频生成统一比例选项（全平台适配）。
// 注意：各模型支持范围不同——
//   - 智谱文生图（glm-image/cogview）：支持全部 8 种
//   - 官方 MiniMax（视频）：ratio 透传，官方支持全 8 种
//   - 智谱 CogVideoX（视频）：仅 16:9 / 9:16 / 1:1，其余降级
//   - 自部署 MiniMax NF4（视频）：固定 832x480(16:9)，其余静默降级
// 后端适配器负责降级，前端只负责提供选项。
export const ASPECT_RATIOS = [
  { value: '16:9', label: '16:9 横屏（视频/宽屏常用）' },
  { value: '9:16', label: '9:16 竖屏（手机/短视频）' },
  { value: '21:9', label: '21:9 超宽屏（电影/电脑显示器）' },
  { value: '4:3', label: '4:3 经典横屏' },
  { value: '3:4', label: '3:4 经典竖屏' },
  { value: '3:2', label: '3:2 横屏（单反比例）' },
  { value: '2:3', label: '2:3 竖屏（人像比例）' },
  { value: '1:1', label: '1:1 正方形（社交/头像）' },
] as const

// 资源管理页（角色/场景/道具文生图）常用比例，顺序贴近默认场景
export const IMAGE_RATIOS = [
  { value: '3:4', label: '3:4 竖屏（角色常用）' },
  { value: '1:1', label: '1:1 正方形（道具常用）' },
  { value: '16:9', label: '16:9 横屏（场景背景常用）' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '21:9', label: '21:9 超宽屏' },
  { value: '4:3', label: '4:3 横屏' },
  { value: '3:2', label: '3:2 横屏' },
  { value: '2:3', label: '2:3 竖屏' },
] as const

// ratio 字符串 → CSS aspect-ratio 值（如 '16:9' → '16/9'）
export function ratioToCss(ratio: string | undefined | null): string {
  if (!ratio) return '16/9'
  return ratio.replace(':', '/')
}

