/**
 * VideoOverviewPage - 作品展示总览
 *
 * 显示所有项目的视频生成任务
 */
import React, { useEffect, useState } from 'react'
import { Card, Spin, Empty, Typography, Grid } from '@arco-design/web-react'
import { useNavigate } from 'react-router-dom'
import { projectService, taskService } from '@/api/services'

const { Title, Text } = Typography
const { Row, Col } = Grid

const VideoOverviewPage: React.FC = () => {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [taskCount, setTaskCount] = useState(0)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    try {
      const projs: any = await projectService.list()
      const list = Array.isArray(projs) ? projs : []
      setProjects(list)

      const tasks: any = await taskService.list()
      setTaskCount(Array.isArray(tasks) ? tasks.length : 0)
    } catch { /* */ } finally {
      setLoading(false)
    }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} /></div>

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>作品展示</Title>

      {taskCount > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <Text>共有 <Text style={{ fontWeight: 600, color: 'rgb(var(--primary-6))' }}>{taskCount}</Text> 个生成任务</Text>
        </Card>
      )}

      {projects.length === 0 ? (
        <Card><Empty description="还没有项目" style={{ padding: 60 }} /></Card>
      ) : (
        <Card title="按项目查看视频">
          <Row gutter={[16, 16]}>
            {projects.map((p) => (
              <Col key={p.id} span={8}>
                <Card hoverable onClick={() => navigate(`/projects/${p.id}/videos`)}>
                  <Text style={{ fontSize: 16, fontWeight: 600 }}>{p.name}</Text>
                  <Text type="secondary" style={{ display: 'block', fontSize: 13, marginTop: 4 }}>
                    查看/管理该项目视频 →
                  </Text>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      )}
    </div>
  )
}

export default VideoOverviewPage
