/**
 * API Service 层 - 封装所有后端接口调用
 *
 * 所有页面通过此模块调用 API，不直接使用 apiClient
 * 统一处理错误提示（通过 Arco Message）
 */
import { apiClient } from './client'

// ==================== 认证 ====================
export const authService = {
  login: (email: string, password: string) =>
    apiClient.post('/auth/login', { email, password }),
  register: (data: { email: string; nickname: string; password: string; phone: string; sms_code: string }) =>
    apiClient.post('/auth/register', data),
  /** 点选人机验证：获取挑战（SVG + 按序点击的目标字） */
  captchaChallenge: (purpose: 'register' | 'reset_password') =>
    apiClient.get('/auth/captcha/challenge', { params: { purpose } }),
  /** 点选人机验证：提交 3 个点击坐标，通过返回一次性 captcha_token */
  captchaVerify: (captchaId: string, points: Array<[number, number]>) =>
    apiClient.post('/auth/captcha/verify', { captcha_id: captchaId, points }),
  /** 发送短信验证码 purpose: register=注册 reset_password=忘记密码（需先过人机验证） */
  sendSmsCode: (phone: string, purpose: 'register' | 'reset_password', captchaToken: string) =>
    apiClient.post('/auth/sms/send-code', { phone, purpose, captcha_token: captchaToken }),
  /** 忘记密码：手机验证码重置 */
  resetPasswordBySms: (data: { phone: string; code: string; new_password: string }) =>
    apiClient.post('/auth/forgot-password/reset', data),
  me: () => apiClient.get('/auth/me'),
  /** 修改自己的资料：昵称 / 头像 URL */
  updateProfile: (data: { nickname?: string; avatar_url?: string }) =>
    apiClient.put('/auth/profile', data),
  /** 修改自己的登录密码（校验原密码） */
  changePassword: (data: { old_password: string; new_password: string }) =>
    apiClient.put('/auth/change-password', data),
  logout: () => apiClient.post('/auth/logout'),
  refresh: (refreshToken: string) =>
    apiClient.post('/auth/refresh', { refresh_token: refreshToken }),
  /** 获取站点公开配置（无需登录） */
  siteConfig: () => apiClient.get('/auth/site-config'),
}

// ==================== 联系我们（公开留言） ====================
export const contactService = {
  submit: (data: { name?: string; contact?: string; msg_type: string; content: string }) =>
    apiClient.post('/contact', data),
}

// ==================== 组织/团队 (M1) ====================
export const organizationService = {
  listMine: () => apiClient.get('/organizations/mine'),
  getCurrent: () => apiClient.get('/organizations/current'),
  create: (data: { name: string; avatar_url?: string }) =>
    apiClient.post('/organizations', data),
  get: (orgId: string) => apiClient.get(`/organizations/${orgId}`),
  update: (orgId: string, data: { name?: string; avatar_url?: string; storage_quota_mb?: number }) =>
    apiClient.put(`/organizations/${orgId}`, data),
  switch: (orgId: string) => apiClient.post(`/organizations/${orgId}/switch`),
  getCredits: (orgId: string) => apiClient.get(`/organizations/${orgId}/credits`),
}

// ==================== 积分 (M1) ====================
export const creditService = {
  getAccount: () => apiClient.get('/credits/account'),
  /** 返回 {items, total, page, page_size, summary:{trend_7d}} */
  listTransactions: (params?: { type?: string; project_id?: string; search?: string; page?: number; page_size?: number }) =>
    apiClient.get('/credits/transactions', { params }),
  listAllocations: () => apiClient.get('/credits/allocations'),
  allocate: (data: { user_id: string; amount: number; remark?: string }) =>
    apiClient.post('/credits/allocate', data),
}

// ==================== 文件上传 (M1) ====================
export const uploadService = {
  image: (file: File, onProgress?: (p: number) => void) =>
    apiClient.upload('/upload/image', file, onProgress),
  video: (file: File, onProgress?: (p: number) => void, params?: Record<string, any>) =>
    apiClient.upload('/upload/video', file, onProgress, params),
  audio: (file: File, onProgress?: (p: number) => void, params?: Record<string, any>) =>
    apiClient.upload('/upload/audio', file, onProgress, params),
}

// ==================== 企业素材库 (M3) ====================
export const materialLibraryService = (orgId: string) => ({
  // 素材
  list: (params?: { category?: string; class_type?: string; folder_id?: string; search?: string; sort?: string; order?: string; page?: number; page_size?: number }) =>
    apiClient.get(`/organizations/${orgId}/materials`, { params }),
  count: (params?: { category?: string; class_type?: string; search?: string }) =>
    apiClient.get(`/organizations/${orgId}/materials/count`, { params }),
  upload: (file: File, params: { category: string; class_type?: string; folder_id?: string; name?: string }, onProgress?: (p: number) => void) => {
    const formData = new FormData()
    formData.append('file', file)
    return apiClient.post(`/organizations/${orgId}/materials`, formData, {
      params,
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e: any) => { if (onProgress && e.total) onProgress(Math.round(e.loaded * 100 / e.total)) },
    })
  },
  get: (id: string) => apiClient.get(`/organizations/${orgId}/materials/${id}`),
  /** 素材库中所有素材的 url 集合（可按 class_type 过滤），用于前端去重标记 */
  listUrls: (classType?: string) =>
    apiClient.get(`/organizations/${orgId}/materials/urls`, { params: { class_type: classType } }),
  fromUrl: (data: { url: string; name: string; category?: string; class_type?: string; meta?: Record<string, any> }) =>
    apiClient.post(`/organizations/${orgId}/materials/from-url`, data),
  update: (id: string, data: { name?: string; class_type?: string; folder_id?: string; meta?: Record<string, any> }) =>
    apiClient.put(`/organizations/${orgId}/materials/${id}`, data),
  move: (id: string, folderId: string | null) =>
    apiClient.post(`/organizations/${orgId}/materials/${id}/move`, { folder_id: folderId }),
  delete: (id: string) => apiClient.delete(`/organizations/${orgId}/materials/${id}`),
  sync: (id: string, projectId: string, targetType: string) =>
    apiClient.post(`/organizations/${orgId}/materials/${id}/sync`, { project_id: projectId, target_type: targetType }),

  // 目录树
  folders: {
    list: (classType?: string) =>
      apiClient.get(`/organizations/${orgId}/materials/folders`, { params: { class_type: classType } }),
    create: (data: { name: string; class_type: string; parent_id?: string }) =>
      apiClient.post(`/organizations/${orgId}/materials/folders`, data),
    update: (id: string, name: string) =>
      apiClient.put(`/organizations/${orgId}/materials/folders/${id}`, { name, class_type: 'character' }),
    delete: (id: string) => apiClient.delete(`/organizations/${orgId}/materials/folders/${id}`),
  },

  // 存储
  storage: () => apiClient.get(`/organizations/${orgId}/materials/storage`),
})

// ==================== 团队管理 (M2) ====================
export const teamService = {
  // 数据看板
  dashboard: (orgId: string, days = 14) =>
    apiClient.get(`/organizations/${orgId}/dashboard/data`, { params: { days } }),
  creditStats: (orgId: string, params: { start_date?: string; end_date?: string; dimension?: string }) =>
    apiClient.get(`/organizations/${orgId}/dashboard/credits`, { params }),

  // 成员管理
  members: {
    list: (orgId: string, params?: { search?: string; project_id?: string }) =>
      apiClient.get(`/organizations/${orgId}/members`, { params }),
    invite: (orgId: string, data: { email: string; role: string; display_name?: string; password?: string }) =>
      apiClient.post(`/organizations/${orgId}/members/invite`, data),
    update: (orgId: string, userId: string, data: { role?: string; display_name?: string }) =>
      apiClient.put(`/organizations/${orgId}/members/${userId}`, data),
    resetPassword: (orgId: string, userId: string, newPassword: string) =>
      apiClient.post(`/organizations/${orgId}/members/${userId}/reset-password`, { new_password: newPassword }),
    toggleStatus: (orgId: string, userId: string) =>
      apiClient.post(`/organizations/${orgId}/members/${userId}/toggle-status`),
    logs: (orgId: string, userId: string) =>
      apiClient.get(`/organizations/${orgId}/members/${userId}/logs`),
    batchProjects: (orgId: string, data: { user_ids: string[]; project_ids: string[] }) =>
      apiClient.post(`/organizations/${orgId}/members/batch-projects`, data),
  },

  // 成员组
  memberGroups: (orgId: string) => ({
    list: () => apiClient.get(`/organizations/${orgId}/member-groups`),
    create: (data: { name: string; leader_id?: string; description?: string; member_ids?: string[] }) =>
      apiClient.post(`/organizations/${orgId}/member-groups`, data),
    update: (id: string, data: { name?: string; leader_id?: string; description?: string; member_ids?: string[] }) =>
      apiClient.put(`/organizations/${orgId}/member-groups/${id}`, data),
    delete: (id: string) => apiClient.delete(`/organizations/${orgId}/member-groups/${id}`),
  }),

  // 权限组
  permissionGroups: (orgId: string) => ({
    list: () => apiClient.get(`/organizations/${orgId}/permission-groups`),
    create: (data: { name: string; description?: string; permissions?: Record<string, boolean> }) =>
      apiClient.post(`/organizations/${orgId}/permission-groups`, data),
    update: (id: string, data: { name?: string; description?: string; permissions?: Record<string, boolean> }) =>
      apiClient.put(`/organizations/${orgId}/permission-groups/${id}`, data),
    delete: (id: string) => apiClient.delete(`/organizations/${orgId}/permission-groups/${id}`),
  }),

  // 企业素材库权限矩阵
  materialPermissions: (orgId: string) => ({
    list: () => apiClient.get(`/organizations/${orgId}/material-permissions`),
    set: (userId: string, perms: Record<string, boolean>) =>
      apiClient.put(`/organizations/${orgId}/material-permissions/${userId}`, perms),
    batch: (data: { user_ids: string[]; permissions: Record<string, boolean> }) =>
      apiClient.post(`/organizations/${orgId}/material-permissions/batch`, data),
  }),
}

// ==================== 项目 ====================
export const projectService = {
  /** 返回 {items, total, page, page_size, summary:{total,producing,completed,draft,archived}} */
  list: (params?: { page?: number; page_size?: number; org_id?: string; search?: string; status?: string; sort_by?: string; sort_order?: string }) =>
    apiClient.get('/projects', { params }),
  get: (id: string) => apiClient.get(`/projects/${id}`),
  create: (data: { name: string; description?: string; cover_image_url?: string }) =>
    apiClient.post('/projects', data),
  update: (id: string, data: { name?: string; description?: string; status?: string }) =>
    apiClient.put(`/projects/${id}`, data),
  delete: (id: string) => apiClient.delete(`/projects/${id}`),
  leave: (id: string) => apiClient.post(`/projects/${id}/leave`, {}),
  stats: (id: string) => apiClient.get(`/projects/${id}/stats`),
  // 邀请链接 / 访问密码
  generateInviteLink: (id: string) =>
    apiClient.post(`/projects/${id}/invite-link`, {}),
  setAccessPassword: (id: string, password: string) =>
    apiClient.put(`/projects/${id}/access-password`, { password }),
  joinByInvite: (token: string, password?: string, role?: string) =>
    apiClient.post('/projects/join', { token, password: password || '', role: role || 'editor' }),
  getJoinInfo: (token: string) =>
    apiClient.get('/projects/join', { params: { token } }),
}

// ==================== 剧本 ====================
export const scriptService = {
  list: (projectId: string) => apiClient.get(`/scripts/project/${projectId}`),
  get: (id: string) => apiClient.get(`/scripts/${id}`),
  /** 上传文档文件（.txt/.docx/.pdf），返回 {title, content, task_id}，AI处理异步 */
  upload: (file: File, projectId?: string) => {
    const formData = new FormData()
    formData.append('file', file)
    return apiClient.post('/scripts/upload', formData, {
      params: projectId ? { project_id: projectId } : undefined,
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  /** 轮询上传 AI 处理状态 */
  uploadStatus: (taskId: string) => apiClient.get(`/scripts/upload/status/${taskId}`),
  create: (projectId: string, data: { title?: string; content: string; format?: string }) =>
    apiClient.post(`/scripts/project/${projectId}`, data),
  /** 批量创建剧本（AI 分集导入：每集一个剧本） */
  batchCreate: (projectId: string, episodes: Array<{ title: string; content: string }>) =>
    apiClient.post(`/scripts/project/${projectId}/batch`, { episodes }),
  update: (id: string, data: { title?: string; content?: string }) =>
    apiClient.put(`/scripts/${id}`, data),
  delete: (id: string) => apiClient.delete(`/scripts/${id}`),
  parse: (id: string, options?: Record<string, any>) =>
    apiClient.post(`/scripts/${id}/parse`, { options: options || {} }),
  parseStatus: (id: string, taskId: string) =>
    apiClient.get(`/scripts/${id}/parse/status/${taskId}`),
  confirmParse: (id: string, data: Record<string, any>) =>
    apiClient.post(`/scripts/${id}/parse/confirm`, data),
  /** 获取剧本对应的集（用于跳转片段管理） */
  getEpisode: (id: string) => apiClient.get(`/scripts/${id}/episode`),
}

// ==================== 工作台 & 作品展示 (M6) ====================
export const workbenchService = {
  narration: (data: { script_content: string; title?: string; voice_id?: string }) =>
    apiClient.post('/workbench/narration', data),
  videoTransfer: (data: { video_url: string; style?: string; frame_count?: number }) =>
    apiClient.post('/workbench/video-transfer', data),
  myWorks: () => apiClient.get('/workbench/my-works'),
}

export const showcaseService = {
  public: (params?: { page?: number; page_size?: number; tag?: string; search?: string; sort?: string }) =>
    apiClient.get('/showcase/public', { params }),
  get: (id: string) => apiClient.get(`/showcase/${id}`),
  publish: (data: {
    title?: string; description?: string; video_url?: string; cover_url?: string;
    tags?: string[]; project_id?: string; episode_id?: string;
  }) => apiClient.post('/showcase/publish', data),
  update: (id: string, data: Record<string, any>) => apiClient.put(`/showcase/${id}`, data),
  delete: (id: string) => apiClient.delete(`/showcase/${id}`),
  // 点赞/取消点赞（需登录）：返回 { like_count, liked }
  like: (id: string) => apiClient.post(`/showcase/${id}/like`),
}

// ==================== AI 创作工作流 (M5) ====================
export const creationService = {
  /** 获取可用模型列表（所有登录用户可访问，不需要 admin 权限） */
  models: {
    list: (params?: { type?: string }) =>
      apiClient.get('/creation/models', { params }),
  },
  /** 获取可用提示词模板列表（所有登录用户可访问） */
  promptTemplates: {
    list: (params?: { category?: string; mode?: string }) =>
      apiClient.get('/creation/prompt-templates', { params }),
  },
  fusion: (data: Record<string, any>, projectId?: string, asyncSubmit?: boolean) =>
    apiClient.post('/creation/fusion', data, { params: { ...(projectId ? { project_id: projectId } : {}), ...(asyncSubmit ? { async_submit: true } : {}) } }),
  imageToVideo: (data: Record<string, any>, projectId?: string, episodeId?: string, asyncSubmit?: boolean) =>
    apiClient.post('/creation/image-to-video', data, { params: { project_id: projectId, episode_id: episodeId, ...(asyncSubmit ? { async_submit: true } : {}) } }),
  firstLastFrame: (data: Record<string, any>, projectId?: string, episodeId?: string, asyncSubmit?: boolean) =>
    apiClient.post('/creation/first-last-frame', data, { params: { project_id: projectId, episode_id: episodeId, ...(asyncSubmit ? { async_submit: true } : {}) } }),
  lipSync: (data: Record<string, any>, projectId?: string, asyncSubmit?: boolean) =>
    apiClient.post('/creation/lip-sync', data, { params: { project_id: projectId, ...(asyncSubmit ? { async_submit: true } : {}) } }),
  tts: (data: Record<string, any>, projectId?: string, asyncSubmit?: boolean) =>
    apiClient.post('/creation/tts', data, { params: { project_id: projectId, ...(asyncSubmit ? { async_submit: true } : {}) } }),
  imageEdit: (data: Record<string, any>, projectId?: string, asyncSubmit?: boolean) =>
    apiClient.post('/creation/image-edit', data, { params: { project_id: projectId, ...(asyncSubmit ? { async_submit: true } : {}) } }),
  /** 单个分镜生成（片段管理用）：指定分镜ID + 生成模式 + 模型 + 参数 */
  clipGenerate: (sceneId: string, data: Record<string, any>, mode: string = 'image_to_video') =>
    apiClient.post(`/creation/clip/${sceneId}/generate`, data, { params: { creation_mode: mode } }),
}

// ==================== 项目成员管理 ====================
export const projectMemberService = (projectId: string) => ({
  list: () => apiClient.get(`/projects/${projectId}/members`),
  add: (data: { email: string; role?: string }) => apiClient.post(`/projects/${projectId}/members`, data),
  updateRole: (userId: string, role: string) => apiClient.put(`/projects/${projectId}/members/${userId}`, { role }),
  remove: (userId: string) => apiClient.delete(`/projects/${projectId}/members/${userId}`),
})

// ==================== 集(Episode) 片段管理 (M4) ====================
export const episodeService = (projectId: string) => ({
  list: (params?: { status?: string; search?: string }) =>
    apiClient.get(`/projects/${projectId}/episodes`, { params }),
  get: (id: string) => apiClient.get(`/projects/${projectId}/episodes/${id}`),
  create: (data?: { number?: number; title?: string; script_id?: string }) =>
    apiClient.post(`/projects/${projectId}/episodes`, data || {}),
  update: (id: string, data: { title?: string; cover_image_url?: string }) =>
    apiClient.put(`/projects/${projectId}/episodes/${id}`, data),
  delete: (id: string) => apiClient.delete(`/projects/${projectId}/episodes/${id}`),
  reorder: (episodeIds: string[]) =>
    apiClient.post(`/projects/${projectId}/episodes/reorder`, { episode_ids: episodeIds }),
  setStatus: (id: string, status: string) =>
    apiClient.put(`/projects/${projectId}/episodes/${id}/status`, { status }),
  // 合并成片：所有分镜已完成时把分镜视频按序合并为完整视频（不扣积分）
  compose: (id: string) =>
    apiClient.post(`/projects/${projectId}/episodes/${id}/compose`),
  setStopAfter: (id: string, value: boolean) =>
    apiClient.put(`/projects/${projectId}/episodes/${id}/stop-after`, { value }),
  setSmartReview: (id: string, value: boolean) =>
    apiClient.put(`/projects/${projectId}/episodes/${id}/smart-review`, { value }),
  oneClickRender: (id: string) =>
    apiClient.post(`/projects/${projectId}/episodes/${id}/one-click-render`),
  // 集内分镜(片段)
  clips: (id: string) => apiClient.get(`/projects/${projectId}/episodes/${id}/clips`),
  createClip: (id: string, data: Record<string, any>) =>
    apiClient.post(`/projects/${projectId}/episodes/${id}/clips`, data),
  updateClip: (id: string, clipId: string, data: Record<string, any>) =>
    apiClient.put(`/projects/${projectId}/episodes/${id}/clips/${clipId}`, data),
  deleteClip: (id: string, clipId: string) =>
    apiClient.delete(`/projects/${projectId}/episodes/${id}/clips/${clipId}`),
  // 集内素材成果
  materials: (id: string, category?: string) =>
    apiClient.get(`/projects/${projectId}/episodes/${id}/materials`, { params: category ? { category } : {} }),
  // Agent 模式（对标巨日禄 Agent：自然语言目标 → 自动编排生成）
  agent: (id: string) => ({
    run: (goal: string, options?: Record<string, any>) =>
      apiClient.post(`/projects/${projectId}/episodes/${id}/agent`, { goal, options: options || {} }),
    status: (runId: string) =>
      apiClient.get(`/projects/${projectId}/episodes/${id}/agent/${runId}`),
  }),
  // Agent 向导模式（剧本驱动 4 阶段：输入剧本→资产详情→分镜管理→视频编辑）
  wizard: (id: string) => ({
    start: (scriptContent: string, mode: string, scriptId?: string) =>
      apiClient.post(`/projects/${projectId}/episodes/${id}/wizard/start`, { script_content: scriptContent, mode, script_id: scriptId }),
    /** 轮询剧本解析异步任务状态 */
    startStatus: (taskId: string) =>
      apiClient.get(`/projects/${projectId}/episodes/${id}/wizard/start/status/${taskId}`),
    get: () =>
      apiClient.get(`/projects/${projectId}/episodes/${id}/wizard`),
    setStage: (stage: string) =>
      apiClient.put(`/projects/${projectId}/episodes/${id}/wizard/stage`, { stage }),
    reparse: () =>
      apiClient.post(`/projects/${projectId}/episodes/${id}/wizard/parse`, {}),
    saveAssets: (assignments: Record<string, string>) =>
      apiClient.put(`/projects/${projectId}/episodes/${id}/wizard/assets`, { assignments }),
    splitScenes: (force?: boolean) =>
      apiClient.post(`/projects/${projectId}/episodes/${id}/wizard/split-scenes`, { force: !!force }),
    generate: (sceneIds?: string[], mode?: string, genParams?: Record<string, any>) =>
      apiClient.post(`/projects/${projectId}/episodes/${id}/wizard/generate`, { scene_ids: sceneIds, mode, gen_params: genParams }),
  }),
})

// ==================== 分镜 ====================
export const sceneService = {
  list: (scriptId: string) => apiClient.get(`/scenes/script/${scriptId}`),
  get: (id: string) => apiClient.get(`/scenes/${id}`),
  create: (scriptId: string, data: { prompt: string; sequence: number; duration?: number; scene_type?: string }) =>
    apiClient.post(`/scenes/script/${scriptId}`, data),
  update: (id: string, data: Record<string, any>) => apiClient.put(`/scenes/${id}`, data),
  delete: (id: string) => apiClient.delete(`/scenes/${id}`),
  updatePrompt: (id: string, prompt: string) =>
    apiClient.put(`/scenes/${id}/prompt`, { prompt }),
  previewPrompt: (id: string, prompt: string) =>
    apiClient.post(`/scenes/${id}/preview`, { prompt }),
  getAssets: (id: string) => apiClient.get(`/scenes/${id}/assets`),
  addAsset: (id: string, data: { resource_type: string; resource_id: string; position?: number }) =>
    apiClient.post(`/scenes/${id}/assets`, data),
  removeAsset: (sceneId: string, assetId: string) =>
    apiClient.delete(`/scenes/${sceneId}/assets/${assetId}`),
  batchUpdate: (items: Array<{ id: string; prompt?: string; duration?: number; status?: string }>) =>
    apiClient.put('/scenes/batch-update', items),
  reorder: (scriptId: string, sceneIds: string[]) =>
    apiClient.put(`/scenes/script/${scriptId}/reorder`, { scene_ids: sceneIds }),
  generateScenes: (scriptId: string, options?: Record<string, any>) =>
    apiClient.post(`/scenes/script/${scriptId}/generate-scenes`, { options: options || {} }),
}

// ==================== 资源管理 ====================
export const resourceService = {
  // 角色
  characters: {
    list: (projectId: string) => apiClient.get(`/resources/project/${projectId}/characters`),
    create: (projectId: string, data: { name: string; description?: string; appearance_prompt?: string }) =>
      apiClient.post(`/resources/project/${projectId}/characters`, data),
    update: (id: string, data: Record<string, any>) => apiClient.put(`/resources/character/${id}`, data),
    delete: (id: string) => apiClient.delete(`/resources/character/${id}`),
    generateImage: (id: string, options?: { size?: string; quality?: string; watermark_enabled?: boolean; model?: string }) =>
      apiClient.post(`/resources/character/${id}/generate-image`, options || {}),
  },
  // 场景背景
  sceneBg: {
    list: (projectId: string) => apiClient.get(`/resources/project/${projectId}/scenes-bg`),
    create: (projectId: string, data: { name: string; description?: string; prompt?: string }) =>
      apiClient.post(`/resources/project/${projectId}/scenes-bg`, data),
    update: (id: string, data: Record<string, any>) => apiClient.put(`/resources/scene-bg/${id}`, data),
    delete: (id: string) => apiClient.delete(`/resources/scene-bg/${id}`),
    generateImage: (id: string, options?: { size?: string; quality?: string; watermark_enabled?: boolean; model?: string }) =>
      apiClient.post(`/resources/scene-bg/${id}/generate-image`, options || {}),
  },
  // 道具
  props: {
    list: (projectId: string) => apiClient.get(`/resources/project/${projectId}/props`),
    create: (projectId: string, data: { name: string; description?: string; prompt?: string }) =>
      apiClient.post(`/resources/project/${projectId}/props`, data),
    update: (id: string, data: Record<string, any>) => apiClient.put(`/resources/prop/${id}`, data),
    delete: (id: string) => apiClient.delete(`/resources/prop/${id}`),
    generateImage: (id: string, options?: { size?: string; quality?: string; watermark_enabled?: boolean; model?: string }) =>
      apiClient.post(`/resources/prop/${id}/generate-image`, options || {}),
  },
  // 生图任务状态查询（轮询用）
  generateStatus: (taskId: string) =>
    apiClient.get(`/resources/generate-status/${taskId}`),
  // 音频
  audio: {
    list: (projectId: string) => apiClient.get(`/resources/project/${projectId}/audio`),
    create: (projectId: string, data: { name: string; type: string; url: string; content?: string; duration?: number }) =>
      apiClient.post(`/resources/project/${projectId}/audio`, data),
    update: (id: string, data: Record<string, any>) => apiClient.put(`/resources/audio/${id}`, data),
    delete: (id: string) => apiClient.delete(`/resources/audio/${id}`),
    generate: (projectId: string, data: { name: string; text: string; type?: string; voice?: string }) =>
      apiClient.post(`/resources/project/${projectId}/audio/generate`, data),
  },
  // 视频（参考视频资产）
  video: {
    list: (projectId: string) => apiClient.get(`/resources/project/${projectId}/videos`),
    create: (projectId: string, data: { name: string; type?: string; url: string; content?: string; thumbnail_url?: string; duration?: number }) =>
      apiClient.post(`/resources/project/${projectId}/videos`, data),
    update: (id: string, data: Record<string, any>) => apiClient.put(`/resources/video/${id}`, data),
    delete: (id: string) => apiClient.delete(`/resources/video/${id}`),
  },
}

// ==================== 任务 & 视频生成 ====================
export const taskService = {
  list: (params?: { project_id?: string; status?: string; type?: string }) => apiClient.get('/tasks', { params }),
  get: (id: string) => apiClient.get(`/tasks/${id}`),
  cancel: (id: string) => apiClient.post(`/tasks/${id}/cancel`),
  retry: (id: string) => apiClient.post(`/tasks/${id}/retry`),
  delete: (id: string) => apiClient.delete(`/tasks/${id}`),
  logs: (id: string) => apiClient.get(`/tasks/${id}/logs`),
  // 生成
  generateImage: (data: { prompt: string; model?: string; width?: number; height?: number; scene_id?: string }) =>
    apiClient.post('/tasks/generate/image', data),
  generateVideo: (data: { scene_id: string; model?: string; image_url?: string; duration?: number }) =>
    apiClient.post('/tasks/generate/video', data),
  batchGenerateVideo: (data: { project_id: string; scene_ids: string[]; model?: string }) =>
    apiClient.post('/tasks/generate/batch-video', data),
  fullAutoGenerate: (data: { project_id: string; options?: Record<string, any> }) =>
    apiClient.post('/tasks/generate/batch-full', data),
  generateSubtitle: (data: { video_id: string; action: string; language?: string }) =>
    apiClient.post('/tasks/generate/subtitle', data),
}

// ==================== 后台管理 ====================
export const adminService = {
  stats: () => apiClient.get('/admin/stats'),
  /** 联系我们留言：列表（分页/筛选/搜索） */
  contactMessages: (params?: { page?: number; page_size?: number; handled?: string; msg_type?: string; search?: string }) =>
    apiClient.get('/admin/contact-messages', { params }),
  /** 留言处理：标记已处理/备注 */
  updateContactMessage: (id: string, data: { is_handled?: boolean; admin_note?: string }) =>
    apiClient.put(`/admin/contact-messages/${id}`, data),
  deleteContactMessage: (id: string) => apiClient.delete(`/admin/contact-messages/${id}`),
  users: (params?: { page?: number; page_size?: number; search?: string; role?: string; status?: string; sort?: string; order?: string }) =>
    apiClient.get('/admin/users', { params }),
  /** 用户富详情（统计/团队/最近任务/积分流水） */
  userDetail: (userId: string) => apiClient.get(`/admin/users/${userId}/detail`),
  /** 批量启用/禁用用户 */
  batchUserStatus: (ids: string[], active: boolean) =>
    apiClient.post('/admin/users/batch-status', { ids, active }),
  updateRole: (userId: string, role: string) => apiClient.put(`/admin/users/${userId}/role`, { role }),
  toggleStatus: (userId: string) => apiClient.post(`/admin/users/${userId}/toggle-status`),
  projects: (params?: { page?: number; page_size?: number; user_id?: string; status?: string; search?: string; sort?: string; order?: string }) =>
    apiClient.get('/admin/projects', { params }),
  /** 项目富详情（内容规模/任务统计/成员/最近任务） */
  projectDetail: (id: string) => apiClient.get(`/admin/projects/${id}/detail`),
  deleteProject: (id: string) => apiClient.delete(`/admin/projects/${id}`),
  tasks: (params?: { page?: number; page_size?: number; type?: string; status?: string; model?: string; user_id?: string; search?: string }) =>
    apiClient.get('/admin/tasks', { params }),
  cancelAllPending: (userId?: string) => apiClient.post('/admin/tasks/cancel-all-pending', null, { params: { user_id: userId } }),
  batchDeleteTasks: (ids: string[]) => apiClient.post('/admin/tasks/batch-delete', { ids }),
  settings: {
    get: () => apiClient.get('/admin/settings'),
    update: (settings: Record<string, any>) => apiClient.put('/admin/settings', { settings }),
    // 文件服务器连通性测试（不传参则用已保存配置）
    testFileServer: (data?: { url?: string; api_key?: string }) =>
      apiClient.post('/admin/settings/file-server/test', data || {}),
  },
  // 系统操作日志（operation_logs 审计表）
  logs: (params?: { action?: string; start_time?: string; end_time?: string; limit?: number }) =>
    apiClient.get('/admin/logs', { params }),
  // 存储统计（本地 uploads + 文件服务器）
  storageStats: () => apiClient.get('/admin/storage/stats'),
  // 孤立文件扫描/清理（dry_run=true 只扫描不删除）
  storageCleanup: (dryRun: boolean) =>
    apiClient.post('/admin/storage/cleanup', null, { params: { dry_run: dryRun } }),
  // 用户 CRUD
  createUser: (data: { email: string; nickname?: string; password: string }) =>
    apiClient.post('/admin/users', data),
  deleteUser: (id: string) => apiClient.delete(`/admin/users/${id}`),
  getUserDetail: (id: string) => apiClient.get(`/admin/users/${id}`),
  updateUser: (id: string, data: { email?: string; nickname?: string; avatar_url?: string; role?: string }) =>
    apiClient.put(`/admin/users/${id}`, data),
  resetUserPassword: (id: string, newPassword: string) =>
    apiClient.post(`/admin/users/${id}/reset-password`, { new_password: newPassword }),
  // 模型配置 CRUD
  models: {
    list: (params?: { type?: string; provider?: string; enabled?: boolean }) =>
      apiClient.get('/admin/models', { params }),
    create: (data: Record<string, any>) => apiClient.post('/admin/models', data),
    update: (id: string, data: Record<string, any>) => apiClient.put(`/admin/models/${id}`, data),
    delete: (id: string) => apiClient.delete(`/admin/models/${id}`),
    test: (id: string) => apiClient.post(`/admin/models/${id}/test`, {}),
  },
  // 提示词模板 CRUD
  promptTemplates: {
    list: (params?: { category?: string; mode?: string; enabled?: boolean; search?: string }) =>
      apiClient.get('/admin/prompt-templates', { params }),
    create: (data: Record<string, any>) => apiClient.post('/admin/prompt-templates', data),
    update: (id: string, data: Record<string, any>) => apiClient.put(`/admin/prompt-templates/${id}`, data),
    delete: (id: string) => apiClient.delete(`/admin/prompt-templates/${id}`),
    /** 复制模板（副本默认禁用） */
    duplicate: (id: string) => apiClient.post(`/admin/prompt-templates/${id}/duplicate`),
  },
  // 积分计价规则 CRUD
  pricing: {
    list: (params?: { task_type?: string; ai_model_id?: string; enabled?: boolean }) =>
      apiClient.get('/admin/pricing', { params }),
    create: (data: Record<string, any>) => apiClient.post('/admin/pricing', data),
    update: (id: string, data: Record<string, any>) => apiClient.put(`/admin/pricing/${id}`, data),
    delete: (id: string) => apiClient.delete(`/admin/pricing/${id}`),
    /** 复制规则（副本默认禁用，改完再启用） */
    duplicate: (id: string) => apiClient.post(`/admin/pricing/${id}/duplicate`),
    /** 批量删除 */
    batchDelete: (ids: string[]) => apiClient.post('/admin/pricing/batch-delete', { ids }),
    /** 命中测试：模拟任务参数，返回命中的规则与积分数 */
    estimate: (data: { task_type: string; ai_model_id?: string; resolution?: string; size?: string; duration?: number }) =>
      apiClient.post('/admin/pricing/estimate', data),
  },
  /** ComfyUI 工作流库 */
  comfyWorkflows: {
    list: (params?: { search?: string; format?: string; enabled?: boolean }) =>
      apiClient.get('/admin/comfyui-workflows', { params }),
    get: (id: string) => apiClient.get(`/admin/comfyui-workflows/${id}`),
    create: (data: { name: string; description?: string; graph: Record<string, any> }) =>
      apiClient.post('/admin/comfyui-workflows', data),
    update: (id: string, data: { name?: string; description?: string; is_enabled?: boolean }) =>
      apiClient.put(`/admin/comfyui-workflows/${id}`, data),
    delete: (id: string) => apiClient.delete(`/admin/comfyui-workflows/${id}`),
    /** 导出下载地址（format=api|ui，可带占位符替换参数） */
    exportUrl: (id: string, format: 'api' | 'ui') =>
      `/api/v1/admin/comfyui-workflows/${id}/export?format=${format}`,
  },
  // 积分管理 (M1)
  credits: {
    listAccounts: (params?: { search?: string }) =>
      apiClient.get('/admin/credits/accounts', { params }),
    recharge: (orgId: string, data: { amount: number; remark?: string }) =>
      apiClient.post(`/admin/credits/${orgId}/recharge`, data),
    listTransactions: (params?: { org_id?: string; type?: string; search?: string; limit?: number }) =>
      apiClient.get('/admin/credits/transactions', { params }),
  },
  // 画廊作品管理
  works: {
    list: (params?: { page?: number; page_size?: number; search?: string; is_public?: boolean; sort?: string; order?: string }) =>
      apiClient.get('/admin/works', { params }),
    setVisibility: (id: string, isPublic: boolean) =>
      apiClient.put(`/admin/works/${id}/visibility`, { is_public: isPublic }),
    /** 批量上架/下架 */
    batchVisibility: (ids: string[], isPublic: boolean) =>
      apiClient.post('/admin/works/batch-visibility', { ids, is_public: isPublic }),
    /** 批量删除 */
    batchDelete: (ids: string[]) =>
      apiClient.post('/admin/works/batch-delete', { ids }),
    remove: (id: string) => apiClient.delete(`/admin/works/${id}`),
  },

  /** 生成媒体资源管理（生成任务输出 + 素材库上传 + 项目音视频资产，集中搜索/禁用/删除/重命名） */
  media: {
    list: (params?: { page?: number; page_size?: number; type?: string; status?: string; source?: string; search?: string }) =>
      apiClient.get('/admin/media', { params }),
    update: (data: { url: string; disabled?: boolean; name?: string }) =>
      apiClient.put('/admin/media', data),
    remove: (items: Array<{ source: string; ref_id: string; url: string }>) =>
      apiClient.post('/admin/media/delete', { items }),
  },
}

// ==================== 画布面板 (Canvas Panel) ====================
// 节点画布编辑器：用户在一个画布上拖入节点、连线建立数据流，纯手搓出完整视频。
// 挂在项目下，路由前缀 /projects/{projectId}/canvas
export interface CanvasData {
  id: string
  project_id: string
  org_id?: string | null
  user_id: string
  name: string
  graph_data: { nodes: any[]; edges: any[] }
  thumbnail_url?: string | null
  version: number
  meta?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export const canvasService = (projectId: string) => ({
  /** 画布列表（按更新时间倒序，不含 graph_data） */
  list: () => apiClient.get(`/projects/${projectId}/canvas`),
  /** 新建画布 */
  create: (data?: { name?: string; graph_data?: any }) =>
    apiClient.post(`/projects/${projectId}/canvas`, data || {}),
  /** 画布详情（含 graph_data） */
  get: (id: string) => apiClient.get(`/projects/${projectId}/canvas/${id}`),
  /** 保存画布（带乐观锁 version） */
  update: (id: string, data: { name?: string; graph_data?: any; thumbnail_url?: string; version?: number }) =>
    apiClient.put(`/projects/${projectId}/canvas/${id}`, data),
  /** 删除画布 */
  delete: (id: string) => apiClient.delete(`/projects/${projectId}/canvas/${id}`),
  /** 复制画布 */
  duplicate: (id: string) => apiClient.post(`/projects/${projectId}/canvas/${id}/duplicate`),
})
