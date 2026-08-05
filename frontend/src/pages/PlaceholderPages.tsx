/**
 * PlaceholderPage - 占位页面
 *
 * 用于尚未实现的功能模块
 */
import React from 'react'
import { Result, Button } from '@arco-design/web-react'
import { useNavigate } from 'react-router-dom'

interface PlaceholderPageProps {
  title: string
  description?: string
  backUrl?: string
}

export const PlaceholderPage: React.FC<PlaceholderPageProps> = ({
  title,
  description = '该功能正在开发中，敬请期待...',
  backUrl = '/dashboard',
}) => {
  const navigate = useNavigate()

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
    }}>
      <Result
        status="info"
        title={title}
        subTitle={description}
        extra={
          <Button type="primary" onClick={() => navigate(backUrl)}>
            返回工作台
          </Button>
        }
      />
    </div>
  )
}

// 导出各个页面的占位组件
export const ProjectListPage = () => (
  <PlaceholderPage title="项目管理" description="项目列表功能开发中..." backUrl="/projects" />
)

export const ProjectDetailPage = () => (
  <PlaceholderPage title="项目详情" description="项目详情页面开发中..." />
)

export const ScriptEditorPage = () => (
  <PlaceholderPage title="剧本编辑器" description="剧本编辑功能开发中..." />
)

export const SceneEditorPage = () => (
  <PlaceholderPage title="分镜编辑器" description="分镜编辑核心功能开发中..." />
)

export const ResourceManagePage = () => (
  <PlaceholderPage title="资源管理" description="资源管理功能开发中..." />
)

export const VideoPreviewPage = () => (
  <PlaceholderPage title="视频预览" description="视频预览与导出功能开发中..." />
)

export const RegisterPage = () => (
  <PlaceholderPage title="注册" description="用户注册功能开发中..." backUrl="/login" />
)

export const AdminDashboardPage = () => (
  <PlaceholderPage title="管理后台" description="后台管理系统开发中..." backUrl="/admin" />
)
