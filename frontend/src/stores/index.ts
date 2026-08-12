/**
 * Global Store - 全局状态管理 (Zustand)
 *
 * 使用Zustand进行轻量级状态管理
 */
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import { organizationService, creditService, canvasService, CanvasData } from '../api/services'

// ==================== 用户状态 ====================
interface UserState {
  user: any | null
  isAuthenticated: boolean
  setUser: (user: any) => void
  clearUser: () => void
}

export const useUserStore = create<UserState>()(
  devtools(
    persist(
      (set) => ({
        user: null,
        isAuthenticated: false,
        setUser: (user) =>
          set({ user, isAuthenticated: true }, false, 'setUser'),
        clearUser: () =>
          set({ user: null, isAuthenticated: false }, false, 'clearUser'),
      }),
      { name: 'scenegen-user' }
    ),
    { name: 'UserStore' }
  )
)

// ==================== 项目状态 ====================
interface ProjectState {
  currentProject: any | null
  projects: any[]
  loading: boolean
  setCurrentProject: (project: any) => void
  setProjects: (projects: any[]) => void
  addProject: (project: any) => void
  updateProject: (id: string, data: Partial<any>) => void
  removeProject: (id: string) => void
  setLoading: (loading: boolean) => void
}

export const useProjectStore = create<ProjectState>()(
  devtools(
    (set) => ({
      currentProject: null,
      projects: [],
      loading: false,

      setCurrentProject: (project) =>
        set({ currentProject: project }, false, 'setCurrentProject'),

      setProjects: (projects) =>
        set({ projects }, false, 'setProjects'),

      addProject: (project) =>
        set(
          (state) => ({ projects: [project, ...state.projects] }),
          false,
          'addProject'
        ),

      updateProject: (id, data) =>
        set(
          (state) => ({
            projects: state.projects.map((p) =>
              p.id === id ? { ...p, ...data } : p
            ),
            currentProject:
              state.currentProject?.id === id
                ? { ...state.currentProject, ...data }
                : state.currentProject,
          }),
          false,
          'updateProject'
        ),

      removeProject: (id) =>
        set(
          (state) => ({
            projects: state.projects.filter((p) => p.id !== id),
            currentProject:
              state.currentProject?.id === id ? null : state.currentProject,
          }),
          false,
          'removeProject'
        ),

      setLoading: (loading) => set({ loading }, false, 'setLoading'),
    }),
    { name: 'ProjectStore' }
  )
)

// ==================== 编辑器状态 ====================
interface EditorState {
  // 当前编辑的分镜
  currentSceneId: string | null

  // 原始提示词(包含@引用)
  originalPrompt: string

  // 解析后的@引用列表
  mentions: MentionItem[]

  // 编辑器是否脏(有未保存的修改)
  isDirty: boolean

  // 验证状态
  isValid: boolean
  validationErrors: string[]

  // 预览数据
  previewData: PromptPreview | null

  // Actions
  setCurrentSceneId: (id: string | null) => void
  setOriginalPrompt: (prompt: string) => void
  setMentions: (mentions: MentionItem[]) => void
  setIsDirty: (dirty: boolean) => void
  setValidation: (isValid: boolean, errors?: string[]) => void
  setPreviewData: (data: PromptPreview | null) => void
  resetEditor: () => void
}

export interface MentionItem {
  type: 'character' | 'scene_bg' | 'prop' | 'audio'
  id: string
  name: string
  displayText: string
  imageUrl?: string | null
}

export interface PromptPreview {
  original_prompt: string
  expanded_prompt: string
  referenced_resources: Array<{
    type: string
    id: string
    name: string
    preview_url?: string
  }>
  token_count: number
  estimated_quality: 'good' | 'acceptable' | 'too_long' | 'too_short'
}

const initialEditorState = {
  currentSceneId: null,
  originalPrompt: '',
  mentions: [],
  isDirty: false,
  isValid: true,
  validationErrors: [],
  previewData: null,
}

export const useEditorStore = create<EditorState>()(
  devtools(
    (set) => ({
      ...initialEditorState,

      setCurrentSceneId: (id) =>
        set({ currentSceneId: id }, false, 'setCurrentSceneId'),

      setOriginalPrompt: (prompt) =>
        set({ originalPrompt: prompt, isDirty: true }, false, 'setOriginalPrompt'),

      setMentions: (mentions) =>
        set({ mentions }, false, 'setMentions'),

      setIsDirty: (isDirty) =>
        set({ isDirty }, false, 'setIsDirty'),

      setValidation: (isValid, validationErrors = []) =>
        set({ isValid, validationErrors }, false, 'setValidation'),

      setPreviewData: (previewData) =>
        set({ previewData }, false, 'setPreviewData'),

      resetEditor: () => set(initialEditorState, false, 'resetEditor'),
    }),
    { name: 'EditorStore' }
  )
)

// ==================== 资源面板状态 ====================
interface ResourcePanelState {
  activeTab: ResourceType | 'all'
  searchQuery: string
  characters: any[]
  sceneBackgrounds: any[]
  props: any[]
  audioAssets: any[]

  setActiveTab: (tab: ResourceType | 'all') => void
  setSearchQuery: (query: string) => void
  setCharacters: (characters: any[]) => void
  setSceneBackgrounds: (backgrounds: any[]) => void
  setProps: (props: any[]) => void
  setAudioAssets: (assets: any[]) => void
}

export type ResourceType = 'character' | 'scene_bg' | 'prop' | 'audio'

export const useResourcePanelStore = create<ResourcePanelState>()(
  devtools(
    (set) => ({
      activeTab: 'all',
      searchQuery: '',
      characters: [],
      sceneBackgrounds: [],
      props: [],
      audioAssets: [],

      setActiveTab: (activeTab) => set({ activeTab }, false, 'setActiveTab'),
      setSearchQuery: (searchQuery) => set({ searchQuery }, false, 'setSearchQuery'),
      setCharacters: (characters) => set({ characters }, false, 'setCharacters'),
      setSceneBackgrounds: (sceneBackgrounds) =>
        set({ sceneBackgrounds }, false, 'setSceneBackgrounds'),
      setProps: (props) => set({ props }, false, 'setProps'),
      setAudioAssets: (assets) =>
        set({ audioAssets }, false, 'setAudioAssets'),
    }),
    { name: 'ResourcePanelStore' }
  )
)

// ==================== 团队/组织状态 (M1) ====================
interface TeamState {
  orgs: any[]              // 用户加入的所有团队
  currentOrg: any | null   // 当前选中的团队
  loading: boolean
  setOrgs: (orgs: any[]) => void
  setCurrentOrg: (org: any) => void
  setLoading: (loading: boolean) => void
  loadOrgs: () => Promise<void>          // 拉取团队列表
  loadCurrent: () => Promise<void>       // 拉取当前团队
  switchOrg: (orgId: string) => Promise<void>
}

export const useTeamStore = create<TeamState>()(
  devtools(
    (set, get) => ({
      orgs: [],
      currentOrg: null,
      loading: false,
      setOrgs: (orgs) => set({ orgs }, false, 'setOrgs'),
      setCurrentOrg: (currentOrg) => set({ currentOrg }, false, 'setCurrentOrg'),
      setLoading: (loading) => set({ loading }, false, 'setLoading'),

      loadOrgs: async () => {
        try {
          const res: any = await organizationService.listMine()
          const list = Array.isArray(res) ? res : (res?.data ?? [])
          set({ orgs: list }, false, 'loadOrgs')
          // 若无 currentOrg, 默认取第一个
          if (!get().currentOrg && list.length > 0) {
            set({ currentOrg: list[0] }, false, 'loadOrgs/default')
          }
        } catch (e) {
          // 静默失败(未登录等)
        }
      },

      loadCurrent: async () => {
        try {
          const res: any = await organizationService.getCurrent()
          const org = res?.data ?? res
          if (org) set({ currentOrg: org }, false, 'loadCurrent')
        } catch (e) {
          // 静默
        }
      },

      switchOrg: async (orgId: string) => {
        const res: any = await organizationService.switch(orgId)
        const org = res?.data ?? res
        set({ currentOrg: org }, false, 'switchOrg')
        // 同步刷新积分
        const { loadBalance } = useCreditStore.getState()
        await loadBalance()
      },
    }),
    { name: 'TeamStore' }
  )
)

// ==================== 积分状态 (M1) ====================
interface CreditState {
  account: any | null       // 当前团队积分账户
  balance: number           // 可用余额(快捷访问)
  loading: boolean
  setAccount: (account: any) => void
  loadBalance: () => Promise<void>
}

export const useCreditStore = create<CreditState>()(
  devtools(
    (set) => ({
      account: null,
      balance: 0,
      loading: false,
      setAccount: (account) =>
        set({ account, balance: account?.balance ?? 0 }, false, 'setAccount'),

      loadBalance: async () => {
        try {
          set({ loading: true }, false, 'loadBalance/start')
          const res: any = await creditService.getAccount()
          const acc = res?.data ?? res
          set(
            { account: acc, balance: acc?.balance ?? 0, loading: false },
            false,
            'loadBalance'
          )
        } catch (e) {
          set({ loading: false }, false, 'loadBalance/fail')
        }
      },
    }),
    { name: 'CreditStore' }
  )
)

// ==================== 画布状态 (Canvas Panel) ====================
interface CanvasState {
  canvases: CanvasData[]           // 项目下的画布列表
  currentCanvas: CanvasData | null // 当前打开的画布
  projectId: string | null         // 当前项目上下文
  loading: boolean
  dirty: boolean                   // 有未保存的改动
  saving: boolean
  lastSavedAt: number | null       // 上次保存时间戳(ms)

  setProjectId: (projectId: string | null) => void
  loadCanvases: (projectId: string) => Promise<void>
  openCanvas: (canvas: CanvasData) => Promise<void>
  closeCanvas: () => void
  setCurrentCanvas: (canvas: CanvasData) => void
  setDirty: (dirty: boolean) => void
  createCanvas: (projectId: string, name?: string) => Promise<CanvasData | null>
  saveCanvas: (graphData: { nodes: any[]; edges: any[] }) => Promise<boolean>
  deleteCanvas: (canvasId: string) => Promise<boolean>
  duplicateCanvas: (canvasId: string) => Promise<CanvasData | null>
}

export const useCanvasStore = create<CanvasState>()(
  devtools(
    (set, get) => ({
      canvases: [],
      currentCanvas: null,
      projectId: null,
      loading: false,
      dirty: false,
      saving: false,
      lastSavedAt: null,

      setProjectId: (projectId) =>
        set({ projectId }, false, 'setProjectId'),

      loadCanvases: async (projectId) => {
        try {
          set({ loading: true }, false, 'loadCanvases/start')
          const res: any = await canvasService(projectId).list()
          const list = (res?.data ?? res) as CanvasData[]
          set({ canvases: Array.isArray(list) ? list : [], projectId, loading: false }, false, 'loadCanvases')
        } catch {
          set({ canvases: [], loading: false }, false, 'loadCanvases/fail')
        }
      },

      openCanvas: async (canvas) => {
        // 列表 item 不含 graph_data，需要先 get 完整数据
        const pid = get().projectId
        let full = canvas
        if (pid && !canvas.graph_data) {
          try {
            const res: any = await canvasService(pid).get(canvas.id)
            full = (res?.data ?? res) as CanvasData
          } catch { /* 用列表 item 兜底 */ }
        }
        set({ currentCanvas: full, dirty: false }, false, 'openCanvas')
      },

      closeCanvas: () =>
        set({ currentCanvas: null, dirty: false }, false, 'closeCanvas'),

      setCurrentCanvas: (canvas) =>
        set({ currentCanvas: canvas }, false, 'setCurrentCanvas'),

      setDirty: (dirty) =>
        set({ dirty }, false, 'setDirty'),

      createCanvas: async (projectId, name) => {
        try {
          const res: any = await canvasService(projectId).create({ name })
          const canvas = (res?.data ?? res) as CanvasData
          if (canvas?.id) {
            const cur = get().canvases
            set({ canvases: [canvas, ...cur] }, false, 'createCanvas')
            return canvas
          }
          return null
        } catch { return null }
      },

      saveCanvas: async (graphData) => {
        const { currentCanvas, projectId } = get()
        if (!currentCanvas || !projectId) return false
        try {
          set({ saving: true }, false, 'saveCanvas/start')
          const res: any = await canvasService(projectId).update(currentCanvas.id, {
            graph_data: graphData,
            version: currentCanvas.version,
          })
          const updated = (res?.data ?? res) as CanvasData
          set({
            currentCanvas: updated,
            dirty: false,
            saving: false,
            lastSavedAt: Date.now(),
          }, false, 'saveCanvas')
          return true
        } catch {
          set({ saving: false }, false, 'saveCanvas/fail')
          return false
        }
      },

      deleteCanvas: async (canvasId) => {
        const { projectId } = get()
        if (!projectId) return false
        try {
          await canvasService(projectId).delete(canvasId)
          const cur = get().canvases.filter((c) => c.id !== canvasId)
          set({ canvases: cur, currentCanvas: null }, false, 'deleteCanvas')
          return true
        } catch { return false }
      },

      duplicateCanvas: async (canvasId) => {
        const { projectId } = get()
        if (!projectId) return null
        try {
          const res: any = await canvasService(projectId).duplicate(canvasId)
          const canvas = (res?.data ?? res) as CanvasData
          if (canvas?.id) {
            const cur = get().canvases
            set({ canvases: [canvas, ...cur] }, false, 'duplicateCanvas')
            return canvas
          }
          return null
        } catch { return null }
      },
    }),
    { name: 'CanvasStore' }
  )
)
