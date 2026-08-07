/**
 * DashboardPage - 工作台/仪表盘
 */
import React, { useEffect, useState } from 'react'
import { Card, Grid, Statistic, Typography, Space, Button, Empty } from '@arco-design/web-react'
import {
  IconFile,
  IconVideoCamera,
  IconStorage,
  IconApps,
  IconPlus,
  IconFolder,
  IconClockCircle,
} from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { apiClient } from '@/api/client'
import { useTeamStore } from '@/stores'

const { Title, Text } = Typography
const { Row, Col } = Grid

interface DashboardStats {
  totalProjects: number
  totalScenes: number
  totalVideos: number
  storageUsed: string
  recentTasks: any[]
}

const DashboardPage: React.FC = () => {
  const navigate = useNavigate()
  const [recentProjects, setRecentProjects] = useState<any[]>([])
  const [stats, setStats] = useState<DashboardStats>({
    totalProjects: 0,
    totalScenes: 0,
    totalVideos: 0,
    storageUsed: '0 MB',
    recentTasks: [],
  })
  const [loading, setLoading] = useState(true)

  const { currentOrg } = useTeamStore()

  useEffect(() => {
    loadDashboardData()
  }, [currentOrg?.id])

  const loadDashboardData = async () => {
    try {
      // 获取真实项目列表（按当前团队筛选）
      const projects: any = await apiClient.get('/projects', { params: { page: 1, page_size: 5, org_id: currentOrg?.id } })
      const projectList = Array.isArray(projects) ? projects : []
      // 获取任务列表
      let taskCount = 0
      try {
        const tasks: any = await apiClient.get('/tasks')
        taskCount = Array.isArray(tasks) ? tasks.length : 0
      } catch { /* */ }

      setStats({
        totalProjects: projectList.length,
        totalScenes: projectList.reduce((sum: number, p: any) => sum + (p.scene_count ?? 0), 0),
        totalVideos: taskCount,
        storageUsed: '0 MB',
        recentTasks: [],
      })
      setRecentProjects(projectList)
    } catch (error) {
      console.error('Failed to load dashboard:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-container">
      {/* 页面头部 */}
      <div className="page-header" style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <Title heading={5} style={{ margin: 0 }}>
            工作台
          </Title>
          <Text type="secondary">欢迎回来，开始创作你的AI短剧</Text>
        </div>
        <Button type="primary" icon={<IconPlus />} onClick={() => navigate('/projects')}>
          新建项目
        </Button>
      </div>

      {/* 统计卡片 */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="项目总数"
              value={stats.totalProjects}
              prefix={<IconFile />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="分镜数量"
              value={stats.totalScenes}
              prefix={<IconApps />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="已生成视频"
              value={stats.totalVideos}
              prefix={<IconVideoCamera />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="存储使用"
              value={stats.storageUsed}
              prefix={<IconStorage />}
            />
          </Card>
        </Col>
      </Row>

      {/* 快捷操作和最近项目 */}
      <Row gutter={16}>
        <Col span={16}>
          <Card title="最近项目">
            {recentProjects.length === 0 ? (
              <Empty description="暂无项目" />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {recentProjects.map((p) => (
                  <div key={p.id} onClick={() => navigate(`/projects/${p.id}`)} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 12px', background: '#F7F8FA', borderRadius: 6, cursor: 'pointer',
                  }}>
                    <Space>
                      <IconFile style={{ color: 'rgb(var(--primary-6))' }} />
                      <Text style={{ fontWeight: 500 }}>{p.name}</Text>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>{p.status}</Text>
                  </div>
                ))}
              </Space>
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card title="快捷导航">
            <Space direction="vertical" style={{ width: '100%' }} size="medium">
              <Button long type="primary" icon={<IconFolder />} onClick={() => navigate('/projects')}>
                我的项目
              </Button>
              <Button long type="outline" icon={<IconStorage />} onClick={() => navigate('/resources')}>
                我的企业素材库
              </Button>
              <Button long icon={<IconPlus />} onClick={() => navigate('/projects')}>
                创建新项目
              </Button>
              <Button long onClick={() => navigate('/creation')}>
                创作面板
              </Button>
            </Space>
          </Card>

          <Card title="进行中的任务" style={{ marginTop: 16 }}>
            {stats.recentTasks.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {stats.recentTasks.map((task) => (
                  <div key={task.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: '#F7F8FA',
                    borderRadius: 6,
                  }}>
                    <Space>
                      <IconClockCircle />
                      <Text>{task.name}</Text>
                    </Space>
                    <Text type="secondary">{task.progress}%</Text>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty description="暂无进行中的任务" />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default DashboardPage
