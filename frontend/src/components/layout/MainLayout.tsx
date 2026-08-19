/**
 * MainLayout - 主布局
 *
 * 顶部一级导航(带图标) + 侧边栏子导航 + 用户区 + 主题切换
 * 注意：Arco Design 2.64 的 Menu 组件只支持 JSX children（<Menu.Item>），
 * 不支持 items 属性；水平菜单需配合 onClickMenuItem 响应点击。
 */
import React from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Avatar, Dropdown, Button, Space, Badge, Modal, Message } from '@arco-design/web-react'
import {
  IconDashboard, IconFolder, IconStorage, IconVideoCamera, IconSafe,
  IconUserGroup, IconHome, IconTool, IconApps, IconUser, IconSettings,
  IconNotification, IconPoweroff, IconPlus,
  IconSun, IconMoon, IconMenuFold, IconMenuUnfold,
  IconGift, IconDown, IconFile, IconMindMapping,
} from '@arco-design/web-react/icon'
import { useTeamStore, useCreditStore } from '../../stores'
import { useSiteConfig } from '../../hooks/useSiteConfig'
import { authService } from '../../api/services'
import { useCurrentUser, saveUser } from '../../utils/auth'
import type { Organization } from '../../types'

const { Sider, Header, Content, Footer } = Layout

interface NavItem {
  key: string
  label: string
  icon?: React.ReactNode
}

const MainLayout: React.FC = () => {
  const [collapsed, setCollapsed] = React.useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const siteConfig = useSiteConfig()

  // 订阅当前用户：管理员修改角色后，刷新页面会通过下面的 /auth/me 拉到最新值
  // 并触发重渲染，从而让「后台管理」入口按最新角色显示。
  const user = useCurrentUser() || {}

  // 团队 & 积分 (M1)
  const { orgs, currentOrg, loadOrgs, loadCurrent, switchOrg } = useTeamStore()
  const { balance, loadBalance } = useCreditStore()

  React.useEffect(() => {
    // 登录后才加载(有 token)
    if (!localStorage.getItem('access_token')) return
    // 刷新本地用户信息：拿到后端最新角色（如被管理员升/降级）后写回缓存并发布
    authService.me().then((u: any) => {
      if (u && u.id) saveUser(u?.data ?? u)
    }).catch(() => { /* 静默：token 失效由拦截器统一处理 */ })
    loadOrgs().then(() => loadCurrent()).then(() => loadBalance())
  }, [loadOrgs, loadCurrent, loadBalance])

  const handleSwitchOrg = async (orgId: string) => {
    try {
      await switchOrg(orgId)
      Message.success('已切换团队')
    } catch {
      Message.error('切换团队失败')
    }
  }

  // 主题：跟随 localStorage，默认浅色
  // 关键：Arco Design 2.64 的暗色 token 定义在 body[arco-theme='dark']，
  // 必须把 arco-theme="dark" 属性写到 document.body（不是 html）；
  // data-theme 用于自定义 CSS 变量。
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') || 'light'
  })
  React.useEffect(() => {
    const root = document.documentElement
    const body = document.body
    if (theme === 'dark') {
      body.setAttribute('arco-theme', 'dark')
      root.setAttribute('data-theme', 'dark')
    } else {
      body.removeAttribute('arco-theme')
      root.removeAttribute('data-theme')
    }
    localStorage.setItem('theme', theme)
  }, [theme])
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  // 一级导航（顶部 Tab 风格，全部带图标）
  const topNavItems: NavItem[] = [
    { key: '/dashboard', label: '概览', icon: <IconDashboard /> },
    { key: '/projects', label: '项目管理', icon: <IconFolder /> },
    { key: '/canvas', label: '我的画布', icon: <IconMindMapping /> },
    { key: '/resources', label: '我的素材', icon: <IconStorage /> },
    { key: '/videos', label: '作品展示', icon: <IconVideoCamera /> },
    { key: '/team', label: '团队管理', icon: <IconUserGroup /> },
    { key: '/admin', label: '后台管理', icon: <IconSafe /> },
  ]

  // 二级导航（侧边栏）- 根据一级切换显示不同子菜单
  const subMenusByTop: Record<string, NavItem[]> = {
    '/dashboard': [
      { key: '/dashboard', icon: <IconDashboard />, label: '概览' },
      { key: '/credits', icon: <IconGift />, label: '我的积分' },
    ],
    '/projects': [
      { key: '/projects', icon: <IconFolder />, label: '项目列表' },
    ],
    '/canvas': [
      { key: '/canvas', icon: <IconMindMapping />, label: '画布' },
    ],
    '/resources': [
      { key: '/resources', icon: <IconStorage />, label: '素材库总览' },
    ],
    '/videos': [
      { key: '/videos', icon: <IconVideoCamera />, label: '作品画廊' },
    ],
    '/admin': user.role === 'admin' ? [
      { key: '/admin', icon: <IconDashboard />, label: '平台概览' },
      { key: '/admin/users', icon: <IconUser />, label: '用户管理' },
      { key: '/admin/projects', icon: <IconFolder />, label: '项目监控' },
      { key: '/admin/tasks', icon: <IconApps />, label: '任务队列' },
      { key: '/admin/works', icon: <IconVideoCamera />, label: '作品管理' },
      { key: '/admin/models', icon: <IconStorage />, label: '配置模型' },
      { key: '/admin/pricing', icon: <IconGift />, label: '计价配置' },
      { key: '/admin/prompt-templates', icon: <IconFile />, label: '提示词模板' },
      { key: '/admin/credits', icon: <IconGift />, label: '积分管理' },
      { key: '/admin/settings', icon: <IconSettings />, label: '系统设置' },
    ] : [],
  }

  // 从 URL 提取 projectId (项目详情专属侧边栏)
  const currentProjectId = React.useMemo(() => {
    const m = location.pathname.match(/\/projects\/([^/]+)/)
    return m ? m[1] : null
  }, [location.pathname])

  // 根据当前路径确定一级
  const currentTop = React.useMemo(() => {
    const path = location.pathname
    // 项目详情页(/projects/:id) 单独处理, 显示项目子导航
    if (path.startsWith('/projects/') && currentProjectId) return '/project-detail'
    if (path.startsWith('/projects') || path.startsWith('/scripts') || path.startsWith('/scenes')) return '/projects'
    if (path.startsWith('/canvas')) return '/canvas'
    if (path.startsWith('/resources')) return '/resources'
    if (path.startsWith('/videos')) return '/videos'
    if (path.startsWith('/team')) return '/team'
    if (path.startsWith('/admin')) return '/admin'
    return '/dashboard'
  }, [location.pathname, currentProjectId])

  // 项目详情专属侧边栏(带 projectId)：项目子导航 + 返回项目列表入口
  const projectDetailMenu: NavItem[] = currentProjectId ? [
    { key: `/projects/${currentProjectId}`, icon: <IconDashboard />, label: '项目概览' },
    { key: `/projects/${currentProjectId}/scripts`, icon: <IconFile />, label: '① 剧本管理' },
    { key: `/projects/${currentProjectId}/resources`, icon: <IconStorage />, label: '② 资源管理' },
    { key: `/projects/${currentProjectId}/episodes`, icon: <IconVideoCamera />, label: '③ 片段管理' },
    { key: `/projects/${currentProjectId}/videos`, icon: <IconVideoCamera />, label: '④ 视频预览' },
    { key: `/projects/${currentProjectId}/members`, icon: <IconUserGroup />, label: '项目成员' },
    { key: '/projects', icon: <IconFolder />, label: '返回项目列表' },
  ] : []

  // 统一主侧边栏：始终显示完整导航，让用户在任何页面都能跳转到主要功能区，
  // 不会因为切换页面而「困住」（之前每个区只显示该区子菜单，跳走后没别的导航）。
  const unifiedMainMenu: NavItem[] = [
    { key: '/dashboard', icon: <IconDashboard />, label: '概览' },
    { key: '/credits', icon: <IconGift />, label: '我的积分' },
    { key: '/projects', icon: <IconFolder />, label: '我的项目' },
    { key: '/canvas', icon: <IconMindMapping />, label: '我的画布' },
    { key: '/resources', icon: <IconStorage />, label: '我的素材' },
    { key: '/videos', icon: <IconVideoCamera />, label: '作品画廊' },
    { key: '/team', icon: <IconUserGroup />, label: '团队管理' },
  ]

  // 侧边栏内容：
  // - 项目详情页：只显示项目子导航 + 返回项目列表（不混入完整主菜单，避免冗余）
  // - 管理后台：保留后台专属菜单（8 项）
  // - 其他所有页面：统一主菜单（完整导航）
  const sideMenuItems = currentTop === '/project-detail'
    ? projectDetailMenu
    : currentTop === '/admin'
      ? (subMenusByTop[currentTop] || [])
      : unifiedMainMenu
  // 团队管理页自带侧边栏, 隐藏主侧边栏
  const hideMainSider = currentTop === '/team'

  const handleTopNav = (key: string) => {
    if (key === '/admin' && user.role !== 'admin') {
      Message.warning('需要管理员权限')
      return
    }
    if (key === '/team') {
      // 跳转到当前团队的团队管理
      const targetOrg = currentOrg?.id || orgs[0]?.id
      if (targetOrg) { navigate(`/team/${targetOrg}/dashboard`); return }
      Message.warning('请先选择团队')
      return
    }
    navigate(key)
  }

  const handleSideNav = (key: string) => {
    // 团队管理跳转到当前团队
    if (key === '/team') {
      const targetOrg = currentOrg?.id || orgs[0]?.id
      if (targetOrg) { navigate(`/team/${targetOrg}/dashboard`); return }
      Message.warning('请先选择团队')
      return
    }
    // 其他都是绝对路径，直接导航
    if (key.startsWith('/')) navigate(key)
    else navigate(`${currentTop}/${key}`)
  }

  // 登出 - 用独立 Modal，避免 Menu.Dropdown 事件穿透
  const [logoutModalVisible, setLogoutModalVisible] = React.useState(false)

  const confirmLogout = () => {
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    localStorage.removeItem('user')
    Message.success('已退出登录')
    navigate('/login')
  }

  const handleLogout = () => setLogoutModalVisible(true)

  const userDropdownMenu = (
    <Menu>
      <Menu.Item key="profile"><Space><IconUser />个人设置</Space></Menu.Item>
      {user.role === 'admin' && (
        <Menu.Item key="admin" onClick={() => navigate('/admin')}><Space><IconDashboard />管理后台</Space></Menu.Item>
      )}
      <Menu.Item key="logout" onClick={handleLogout}>
        <Space><IconPoweroff style={{ color: 'rgb(var(--danger-6))' }} />退出登录</Space>
      </Menu.Item>
    </Menu>
  )

  // 侧边栏选中 key
  const selectedKeys = React.useMemo(() => {
    const path = location.pathname
    // 1. 精确匹配优先
    const exact = sideMenuItems.find((i) => i.key === path)
    if (exact) return [exact.key]
    // 2. 前缀匹配：按 key 长度降序（更具体的路径优先，避免 /projects/xxx 抢占 /projects/xxx/episodes）
    const candidates = sideMenuItems
      .filter((i) => i.key !== '/' && i.key !== '/projects' && path.startsWith(i.key))
      .sort((a, b) => b.key.length - a.key.length)
    if (candidates.length > 0) return [candidates[0].key]
    return [path]
  }, [location.pathname, sideMenuItems, currentTop])

  const displayName = user.nickname || user.email || '用户'
  const initial = (displayName || 'U').charAt(0).toUpperCase()

  return (
    <Layout className="layout-container" style={{ minHeight: '100vh' }}>
      {/* 顶部一级导航 */}
      <Header className="app-header">
        {/* Logo + 顶导 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <span className="app-logo" onClick={() => navigate('/dashboard')}>{siteConfig.site_name}</span>
          <Menu
            className="top-nav-menu"
            mode="horizontal"
            selectedKeys={[currentTop]}
            onClickMenuItem={(key) => handleTopNav(key)}
            style={{ background: 'transparent', borderBottom: 'none' }}
          >
            {topNavItems.map((item) => (
              <Menu.Item key={item.key}>
                {item.icon}
                <span>{item.label}</span>
              </Menu.Item>
            ))}
          </Menu>
        </div>
        {/* 右侧操作区 */}
        <Space size={12} style={{ alignItems: 'center' }}>
          {/* 团队切换器 (M1) */}
          {orgs.length > 0 && (
            <Dropdown
              droplist={
                <Menu onClickMenuItem={(key) => handleSwitchOrg(key)}>
                  {orgs.map((o: Organization) => (
                    <Menu.Item key={o.id}>
                      <Space>
                        <span>{o.name}</span>
                        {o.is_personal && <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>个人</span>}
                        {currentOrg?.id === o.id && <span style={{ color: 'var(--color-primary)' }}>✓</span>}
                      </Space>
                    </Menu.Item>
                  ))}
                </Menu>
              }
              position="br"
              trigger="click"
            >
              <div className="org-trigger" title="切换团队">
                <IconUserGroup />
                <span className="org-name">{currentOrg?.name || '团队'}</span>
                {currentOrg?.is_personal && <span style={{ fontSize: 11, color: 'var(--color-text-3)' }}>个人</span>}
                <IconDown style={{ fontSize: 10 }} />
              </div>
            </Dropdown>
          )}
          {/* 积分显示 (M1) - 点击跳转我的积分明细 */}
          <div
            className="credit-badge"
            title="可用积分（点击查看明细）"
            style={{ cursor: 'pointer' }}
            onClick={() => navigate('/credits')}
          >
            <IconGift style={{ color: 'rgb(var(--warning-6))' }} />
            <span>可用积分: {balance}</span>
          </div>
          <div
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </div>
          <Badge count={3} dot>
            <Button type="text" icon={<IconNotification />} className="header-icon-btn" />
          </Badge>
          <Dropdown droplist={userDropdownMenu} position="br" trigger="click">
            <div className="user-trigger">
              <Avatar size={32} style={{ backgroundColor: 'var(--color-primary)' }}>
                {initial}
              </Avatar>
              <span className="user-name">{displayName}</span>
              {user.role === 'admin' && <span className="role-badge">管理员</span>}
            </div>
          </Dropdown>
        </Space>
      </Header>

      <Layout style={{ minHeight: 'calc(100vh - var(--header-height))' }}>
        {/* 侧边栏二级导航 (团队管理页隐藏) —— 固定高度不滚动 */}
        {!hideMainSider && (
        <Sider
          className="app-sider"
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
          width={220}
          collapsedWidth={64}
          style={{
            background: 'var(--color-bg-1)', borderRight: '1px solid var(--color-border)',
            position: 'sticky', top: 0, height: 'calc(100vh - var(--header-height))', overflow: 'hidden',
          }}
        >
          <Menu
            selectedKeys={selectedKeys}
            onClickMenuItem={(key) => handleSideNav(key)}
          >
            {sideMenuItems.map((item) => (
              <Menu.Item key={item.key} title={item.label}>
                {item.icon}
                <span className="menu-label">{item.label}</span>
              </Menu.Item>
            ))}
          </Menu>
          {/* 侧边栏底部：新建按钮 + 折叠按钮（竖向排列，避免遮挡） */}
          <div className="sider-footer">
            {!collapsed && currentTop === '/projects' && (
              <Button
                type="primary"
                long
                icon={<IconPlus />}
                onClick={() => navigate('/projects')}
              >新建项目</Button>
            )}
            <Button
              long
              className="sider-collapse-btn"
              icon={collapsed ? <IconMenuUnfold /> : <IconMenuFold />}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? '' : '收起菜单'}
            </Button>
          </div>
        </Sider>
        )}

        {/* 主内容区 —— 独立滚动，侧边栏固定 */}
        <Layout style={{ background: 'var(--color-bg-2)', minWidth: 0, overflow: 'hidden' }}>
          <Content style={{ flex: 1, padding: hideMainSider ? 0 : 24, background: 'var(--color-bg-2)', overflow: 'auto' }}>
            <Outlet />
          </Content>
          <Footer style={{
            textAlign: 'center', color: 'var(--color-text-3)', fontSize: 12,
            padding: '12px 24px', background: 'var(--color-bg-1)', borderTop: '1px solid var(--color-border)',
          }}>
            {siteConfig.site_name} ©{new Date().getFullYear()} · {siteConfig.site_description}
          </Footer>
        </Layout>
      </Layout>

      {/* 登出确认弹窗 - 独立渲染避免 Menu.Dropdown 事件穿透 */}
      <Modal
        title="确认登出"
        visible={logoutModalVisible}
        onCancel={() => setLogoutModalVisible(false)}
        onOk={confirmLogout}
        okText="退出"
        cancelText="取消"
      >
        <p>确定要退出登录吗？</p>
      </Modal>
    </Layout>
  )
}

export default MainLayout
