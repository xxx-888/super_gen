/**
 * TeamPermissionsPage - 权限管理（合并页）
 *
 * 原「成员组管理 / 权限组管理 / 企业素材库权限」三个低频子页合并为一个
 * 页面的三个 Tab，功能不变、菜单更简洁。
 */
import React from 'react'
import { Card, Tabs, Typography } from '@arco-design/web-react'
import { IconUserGroup, IconSafe, IconStorage } from '@arco-design/web-react/icon'
import TeamMemberGroupsPage from './TeamMemberGroupsPage'
import TeamPermissionGroupsPage from './TeamPermissionGroupsPage'
import TeamMaterialPermissionsPage from './TeamMaterialPermissionsPage'

const { Title, Text } = Typography

const TeamPermissionsPage: React.FC = () => {
  return (
    <div>
      <Title heading={5} style={{ marginBottom: 4 }}>权限管理</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        成员组把成员分组，权限组控制各功能的操作权限，素材库权限决定哪些组能访问企业素材库
      </Text>
      <Card>
        <Tabs defaultActiveTab="groups">
          <Tabs.TabPane key="groups" title={<span><IconUserGroup /> 成员组</span>}>
            <TeamMemberGroupsPage />
          </Tabs.TabPane>
          <Tabs.TabPane key="perms" title={<span><IconSafe /> 权限组</span>}>
            <TeamPermissionGroupsPage />
          </Tabs.TabPane>
          <Tabs.TabPane key="material" title={<span><IconStorage /> 素材库权限</span>}>
            <TeamMaterialPermissionsPage />
          </Tabs.TabPane>
        </Tabs>
      </Card>
    </div>
  )
}

export default TeamPermissionsPage
