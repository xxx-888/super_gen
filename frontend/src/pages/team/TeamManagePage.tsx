/**
 * TeamManagePage - 团队管理容器 (M2)
 *
 * 侧边 tab 导航 + Outlet 渲染子页面.
 * 子路由: dashboard / credits / members / member-groups / permission-groups / material-permissions
 */
import React from 'react'
import { Outlet, useNavigate, useLocation, useParams } from 'react-router-dom'
import { Layout, Menu } from '@arco-design/web-react'
import {
  IconDashboard, IconGift, IconUser, IconUserGroup, IconSafe, IconStorage,
} from '@arco-design/web-react/icon'
import { IconFileImage } from '@arco-design/web-react/icon'

const { Sider, Content } = Layout

const menuItems = [
  { key: 'dashboard', label: '数据看板', icon: <IconDashboard /> },
  { key: 'credits', label: '积分统计', icon: <IconGift /> },
  { key: 'members', label: '成员管理', icon: <IconUser /> },
  { key: 'member-groups', label: '成员组管理', icon: <IconUserGroup /> },
  { key: 'permission-groups', label: '权限组管理', icon: <IconSafe /> },
  { key: 'material-permissions', label: '企业素材库权限', icon: <IconStorage /> },
  { key: 'materials', label: '企业素材库', icon: <IconFileImage /> },
]

const TeamManagePage: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { orgId } = useParams()

  // 从 URL 推断当前 tab
  const pathSegs = location.pathname.split('/')
  const current = menuItems.find((m) => pathSegs.includes(m.key))?.key || 'dashboard'

  const handleNav = (key: string) => {
    navigate(`/team/${orgId}/${key}`)
  }

  return (
    <Layout style={{ minHeight: 'calc(100vh - 120px)', background: 'var(--color-bg-2)' }}>
      <Sider width={200} style={{ background: 'var(--color-bg-1)', borderRight: '1px solid var(--color-border)' }}>
        <div style={{ padding: '16px 20px', fontWeight: 600, fontSize: 15, borderBottom: '1px solid var(--color-border)' }}>
          团队管理
        </div>
        <Menu selectedKeys={[current]} onClickMenuItem={handleNav} style={{ borderRight: 'none' }}>
          {menuItems.map((item) => (
            <Menu.Item key={item.key}>
              {item.icon}
              <span>{item.label}</span>
            </Menu.Item>
          ))}
        </Menu>
      </Sider>
      <Content style={{ padding: 20, overflow: 'auto' }}>
        <Outlet />
      </Content>
    </Layout>
  )
}

export default TeamManagePage
