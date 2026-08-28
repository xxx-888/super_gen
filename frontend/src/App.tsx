import React, { Suspense } from 'react'
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom'
import { Spin } from '@arco-design/web-react'

// 布局组件
import MainLayout from './components/layout/MainLayout'
import { authService } from './api/services'
import { useCurrentUser, saveUser } from './utils/auth'

// 页面组件(懒加载)
const LoginPage = React.lazy(() => import('./pages/auth/LoginPage'))
const RegisterPage = React.lazy(() => import('./pages/auth/RegisterPage'))
const DashboardPage = React.lazy(() => import('./pages/dashboard/DashboardPage'))
const ProjectListPage = React.lazy(() => import('./pages/project/ProjectListPage'))
const ProjectDetailPage = React.lazy(() => import('./pages/project/ProjectDetailPage'))
const ProjectMembersPage = React.lazy(() => import('./pages/project/ProjectMembersPage'))
const ProjectJoinPage = React.lazy(() => import('./pages/project/ProjectJoinPage'))
const ScriptListPage = React.lazy(() => import('./pages/script/ScriptListPage'))
const ScriptEditorPage = React.lazy(() => import('./pages/script/ScriptEditorPage'))
// SceneEditorPage 已废弃，旧路由由 LegacySceneRedirect 统一跳转到片段管理
// const SceneEditorPage = React.lazy(() => import('./pages/scene/SceneEditorPage'))
const ResourceManagePage = React.lazy(() => import('./pages/resource/ResourceManagePage'))
const ResourceOverviewPage = React.lazy(() => import('./pages/resource/ResourceOverviewPage'))
const VideoPreviewPage = React.lazy(() => import('./pages/video/VideoPreviewPage'))
const VideoOverviewPage = React.lazy(() => import('./pages/video/VideoOverviewPage'))
const AdminDashboardPage = React.lazy(() => import('./pages/admin/AdminDashboardPage'))
const AdminModelPage = React.lazy(() => import('./pages/admin/AdminModelPage'))
const AdminSettingsPage = React.lazy(() => import('./pages/admin/AdminSettingsPage'))
const AdminCreditsPage = React.lazy(() => import('./pages/admin/AdminCreditsPage'))
const AdminPromptTemplatePage = React.lazy(() => import('./pages/admin/AdminPromptTemplatePage'))
const AdminPricingPage = React.lazy(() => import('./pages/admin/AdminPricingPage'))
const AdminWorksPage = React.lazy(() => import('./pages/admin/AdminWorksPage'))
const AdminMediaPage = React.lazy(() => import('./pages/admin/AdminMediaPage'))
const AdminComfyWorkflowPage = React.lazy(() => import('./pages/admin/AdminComfyWorkflowPage'))
// 我的积分（普通用户可见）
const MyCreditsPage = React.lazy(() => import('./pages/credits/MyCreditsPage'))
// 团队管理 (M2)
const TeamManagePage = React.lazy(() => import('./pages/team/TeamManagePage'))
const TeamDashboardPage = React.lazy(() => import('./pages/team/TeamDashboardPage'))
const TeamCreditsPage = React.lazy(() => import('./pages/team/TeamCreditsPage'))
const TeamMembersPage = React.lazy(() => import('./pages/team/TeamMembersPage'))
const TeamMemberGroupsPage = React.lazy(() => import('./pages/team/TeamMemberGroupsPage'))
const TeamPermissionGroupsPage = React.lazy(() => import('./pages/team/TeamPermissionGroupsPage'))
const TeamMaterialPermissionsPage = React.lazy(() => import('./pages/team/TeamMaterialPermissionsPage'))
const TeamPermissionsPage = React.lazy(() => import('./pages/team/TeamPermissionsPage'))
const MaterialLibraryPage = React.lazy(() => import('./pages/material/MaterialLibraryPage'))
const EpisodeListPage = React.lazy(() => import('./pages/episode/EpisodeListPage'))
const EpisodeDetailPage = React.lazy(() => import('./pages/episode/EpisodeDetailPage'))
const EpisodeEditorPage = React.lazy(() => import('./pages/episode/EpisodeEditorPage'))
// 创作面板(CreationPanelPage) 和工作台(WorkbenchPage) 已合并为画布面板(CanvasPage)
// 旧路由 /creation 和 /workbench 通过 Navigate 重定向到 /canvas
const ShowcasePage = React.lazy(() => import('./pages/showcase/ShowcasePage'))
// 画布面板（节点画布编辑器，替代旧的工作台+创作面板）
const CanvasPage = React.lazy(() => import('./pages/canvas/CanvasPage'))

// 加载中组件
const LoadingFallback: React.FC = () => (
  <div style={{
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
  }}>
    <Spin size={40} tip="加载中..." />
  </div>
)

// 路由守卫
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isAuthenticated = !!localStorage.getItem('access_token')
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

// 旧版分镜编辑页(/scripts/:id/scenes/list)已废弃，统一跳转到片段管理。
// 先查该剧本对应的 episode，找到就进详情页，否则进列表页。
const LegacySceneRedirect: React.FC = () => {
  const { projectId, scriptId } = useParams<{ projectId: string; scriptId: string }>()
  const navigate = useNavigate()
  const [pending, setPending] = React.useState(true)
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      let target = `/projects/${projectId}/episodes`
      if (scriptId) {
        try {
          const { apiClient } = await import('./api/client')
          const res: any = await apiClient.get(`/scripts/${scriptId}/episode`)
          const eid = res?.episode_id || res?.data?.episode_id
          if (eid) target = `/projects/${projectId}/episodes/${eid}`
        } catch { /* 走列表页兜底 */ }
      }
      if (!cancelled) navigate(target, { replace: true })
    })()
    return () => { cancelled = true }
  }, [projectId, scriptId, navigate])
  if (pending) return <div style={{ textAlign: 'center', padding: 80 }}>跳转中...</div>
  return null
}

// 管理员路由守卫
const AdminRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const user = useCurrentUser()
  // 首次加载可能尚未从 /auth/me 取回最新角色：在确认前先等待，避免用旧缓存误重定向
  const [resolved, setResolved] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    // 读取最新角色后再判定（管理员可能在本次会话外修改了该用户角色）
    authService.me()
      .then((u: any) => {
        if (cancelled) return
        if (u && u.id) saveUser(u?.data ?? u)
      })
      .catch(() => { /* token 失效由拦截器统一处理 */ })
      .finally(() => { if (!cancelled) setResolved(true) })
    return () => { cancelled = true }
  }, [])

  if (!resolved) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size={40} tip="加载中..." />
      </div>
    )
  }
  if (user?.role !== 'admin') {
    return <Navigate to="/dashboard" replace />
  }
  return <>{children}</>
}

const App: React.FC = () => {
  const navigate = useNavigate()
  // 监听会话失效事件（由 api/client.ts 在 token 失效时派发），
  // 用 React Router 软跳转，避免 window.location 硬刷新整页。
  React.useEffect(() => {
    const handler = () => navigate('/login', { replace: true })
    window.addEventListener('auth:logout', handler)
    return () => window.removeEventListener('auth:logout', handler)
  }, [navigate])

  return (
    <Suspense fallback={<LoadingFallback />}>
      <Routes>
        {/* 公开路由 */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        {/* 邀请加入页（独立，不显示主布局侧边栏） */}
        <Route path="/projects/join" element={<ProjectJoinPage />} />

        {/* 受保护路由 */}
        <Route path="/" element={
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        }>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />

          {/* 项目管理 */}
          <Route path="projects" element={<ProjectListPage />} />
          <Route path="projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="projects/:projectId/members" element={<ProjectMembersPage />} />
          <Route path="projects/:projectId/episodes" element={<EpisodeListPage />} />
          <Route path="projects/:projectId/episodes/:episodeId" element={<EpisodeDetailPage />} />
        <Route path="projects/:projectId/episodes/:episodeId/editor" element={<EpisodeEditorPage />} />
          <Route path="projects/:projectId/scripts" element={<ScriptListPage />} />
          <Route path="projects/:projectId/scripts/:scriptId" element={<ScriptEditorPage />} />
          <Route path="projects/:projectId/scripts/:scriptId/scenes/list" element={<LegacySceneRedirect />} />
          <Route path="projects/:projectId/scripts/:scriptId/scenes/:sceneId" element={<LegacySceneRedirect />} />
          <Route path="projects/:projectId/resources" element={<ResourceManagePage />} />
          <Route path="projects/:projectId/videos" element={<VideoPreviewPage />} />

          {/* 素材库（顶级） */}
          <Route path="resources" element={<ResourceOverviewPage />} />

          {/* AI 创作面板 (M5) - 已升级为画布面板 */}
          <Route path="creation" element={<Navigate to="/canvas" replace />} />

          {/* 我的积分明细（普通用户可见） */}
          <Route path="credits" element={<MyCreditsPage />} />

          {/* 工作台 (M6) - 已合并进画布面板 */}
          <Route path="workbench" element={<Navigate to="/canvas" replace />} />

          {/* 画布面板（节点画布编辑器，统一创作入口） */}
          <Route path="canvas" element={<CanvasPage />} />

          {/* 作品展示 - 覆盖原有 videos 路由 (M6) */}
          <Route path="videos" element={<ShowcasePage />} />

          {/* 团队管理（7 项精简为 3 项：看板含积分明细、成员、权限三合一） */}
          <Route path="team/:orgId" element={<TeamManagePage />}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<TeamDashboardPage />} />
            <Route path="members" element={<TeamMembersPage />} />
            <Route path="permissions" element={<TeamPermissionsPage />} />
            {/* 旧路径重定向到合并后的新位置 */}
            <Route path="credits" element={<Navigate to="dashboard" replace />} />
            <Route path="member-groups" element={<Navigate to="permissions" replace />} />
            <Route path="permission-groups" element={<Navigate to="permissions" replace />} />
            <Route path="material-permissions" element={<Navigate to="permissions" replace />} />
            {/* 企业素材库：菜单入口已移除（与「我的素材」重复），路由保留可直达 */}
            <Route path="materials" element={<MaterialLibraryPage />} />
          </Route>
        </Route>

        {/* 管理后台 */}
        <Route path="/admin" element={
          <AdminRoute>
            <MainLayout />
          </AdminRoute>
        }>
          <Route index element={<AdminDashboardPage />} />
          <Route path="users" element={<AdminDashboardPage />} />
          <Route path="projects" element={<AdminDashboardPage />} />
          <Route path="tasks" element={<AdminDashboardPage />} />
          <Route path="works" element={<AdminWorksPage />} />
          <Route path="media" element={<AdminMediaPage />} />
          <Route path="models" element={<AdminModelPage />} />
          <Route path="comfyui-workflows" element={<AdminComfyWorkflowPage />} />
          <Route path="prompt-templates" element={<AdminPromptTemplatePage />} />
          <Route path="pricing" element={<AdminPricingPage />} />
          <Route path="credits" element={<AdminCreditsPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
        </Route>

        {/* 404 */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  )
}

export default App
