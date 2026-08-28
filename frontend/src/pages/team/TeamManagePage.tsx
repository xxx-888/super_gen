/**
 * TeamManagePage - 团队管理容器
 *
 * 侧边导航 + Outlet 渲染子页面（原 7 项菜单精简为 3 项）：
 * - 数据看板（含积分明细统计 Tab）
 * - 成员管理
 * - 权限管理（成员组/权限组/素材库权限三合一 Tab）
 * 企业素材库与主菜单「我的素材」重复，入口移除（路由保留可直达）。
 */
import React from 'react'
import { Outlet, useNavigate, useLocation, useParams } from 'react-router-dom'
import { Layout, Menu, Button } from '@arco-design/web-react'
import {
  IconDashboard, IconUser, IconSafe,
  IconBackward,
} from '@arco-design/web-react/icon'

const { Sider, Content } = Layout

const menuItems = [
  { key: 'dashboard', label: '数据看板', icon: <IconDashboard /> },
  { key: 'members', label: '成员管理', icon: <IconUser /> },
  { key: 'permissions', label: '权限管理', icon: <IconSafe /> },
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
      <Sider width={200} style={{ background: 'var(--color-bg-1)', borderRight: '1px solid var(--color-border)', position: 'relative' }}>
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
        {/* 返回仪表盘 */}
        <div style={{ position: 'absolute', bottom: 16, left: 12, right: 12 }}>
          <Button long icon={<IconBackward />} onClick={() => navigate('/dashboard')}>返回仪表盘</Button>
        </div>
      </Sider>
      <Content style={{ padding: 20, overflow: 'auto' }}>
        <Outlet />
      </Content>
    </Layout>
  )
}

export default TeamManagePage
