/**
 * ProjectDetailPage - 项目详情
 *
 * 功能：项目信息编辑、剧本列表、资源入口、统计信息
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Form, Input, Message, Spin, Typography, Grid, Statistic, Tag, Tabs, Empty, Popconfirm, Select } from '@arco-design/web-react'
import { IconEdit, IconFile, IconApps, IconVideoCamera, IconStorage, IconPlus, IconDelete, IconUserGroup } from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { projectService, scriptService } from '@/api/services'
import { PROJECT_STATUS } from '@/utils/statusLabels'

const { Title, Text } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

const ProjectDetailPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<any>(null)
  const [scripts, setScripts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [editForm] = Form.useForm()
  const [creatingScript, setCreatingScript] = useState(false)

  const loadData = async () => {
    if (!projectId) return
    try {
      const [proj, scrs]: any = await Promise.all([
        projectService.get(projectId),
        scriptService.list(projectId),
      ])
      setProject(proj)
      setScripts(Array.isArray(scrs) ? scrs : [])
    } catch {
      // 拦截器已提示
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [projectId])

  const handleSaveEdit = async () => {
    try {
      const values = await editForm.validate()
      await projectService.update(projectId!, values)
      Message.success('保存成功')
      setEditing(false)
      loadData()
    } catch (err: any) {
      if (err?.errors) return
    }
  }

  const handleCreateScript = async () => {
    setCreatingScript(true)
    try {
      const res: any = await scriptService.create(projectId!, { title: '新剧本', content: '' })
      Message.success('剧本已创建')
      navigate(`/projects/${projectId}/scripts/${res.id}`)
    } catch {
      // 拦截器已提示
    } finally {
      setCreatingScript(false)
    }
  }

  const handleDeleteScript = async (id: string) => {
    try {
      await scriptService.delete(id)
      Message.success('剧本已删除')
      loadData()
    } catch {
      // 拦截器已提示
    }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} tip="加载中..." /></div>
  if (!project) return <Empty description="项目不存在" />

  return (
    <div>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <Title heading={5} style={{ margin: 0 }}>{project.name}</Title>
          <Text type="secondary">{project.description || '暂无描述'}</Text>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-3)' }}>
            {project.created_at && <span>创建于 {new Date(project.created_at).toLocaleString('zh-CN')}</span>}
            {project.updated_at && <span style={{ marginLeft: 12 }}>更新于 {new Date(project.updated_at).toLocaleString('zh-CN')}</span>}
          </div>
        </div>
        <Button icon={<IconEdit />} onClick={() => { editForm.setFieldsValue(project); setEditing(true) }}>编辑</Button>
      </div>

      {/* 统计卡片 */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        <Col span={6}><Card><Statistic title="剧本数" value={scripts.length} prefix={<IconFile />} /></Card></Col>
        <Col span={6}><Card><Statistic title="分镜数" value={project.scene_count ?? 0} prefix={<IconApps />} /></Card></Col>
        <Col span={6}><Card><Statistic title="角色数" value={project.character_count ?? 0} prefix={<IconStorage />} /></Card></Col>
        <Col span={6}><Card><Statistic title="状态" value={PROJECT_STATUS[project.status]?.label || project.status || '草稿'} prefix={<IconVideoCamera />} /></Card></Col>
      </Row>

      <Tabs>
        {/* 集(片段)管理 Tab */}
        <TabPane key="episodes" title="集(片段)管理">
          <Card>
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                按集组织片段，支持状态流转、一键成片、智能审片
              </Text>
              <Button type="primary" icon={<IconVideoCamera />} onClick={() => navigate(`/projects/${projectId}/episodes`)}>
                进入集(片段)管理
              </Button>
            </div>
          </Card>
        </TabPane>

        {/* 剧本 Tab */}
        <TabPane key="scripts" title="剧本管理">
          <Card style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text type="secondary">剧本用于 AI 解析生成分镜，支持 @引用角色/场景/道具</Text>
              <Button type="primary" icon={<IconFile />} onClick={() => navigate(`/projects/${projectId}/scripts`)}>
                进入剧本管理
              </Button>
            </div>
          </Card>
          <div style={{ marginBottom: 12 }}>
            <Button type="primary" icon={<IconPlus />} loading={creatingScript} onClick={handleCreateScript}>新建剧本</Button>
          </div>
          {scripts.length === 0 ? (
            <Empty description="还没有剧本" />
          ) : (
            <Row gutter={16}>
              {scripts.map((s) => (
                <Col key={s.id} span={12} style={{ marginBottom: 12 }}>
                  <Card hoverable onClick={() => navigate(`/projects/${projectId}/scripts/${s.id}`)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <Text style={{ fontWeight: 600, fontSize: 15 }}>{s.title || '未命名剧本'}</Text>
                        <Text type="secondary" style={{ display: 'block', fontSize: 13, marginTop: 4 }}>
                          {s.content ? `${s.content.substring(0, 60)}...` : '空剧本'}
                        </Text>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                        {s.parsed_data && <Tag color="green" size="small">已解析</Tag>}
                        <Popconfirm title="确认删除该剧本？" onOk={() => handleDeleteScript(s.id)}>
                          <Button size="small" status="danger" icon={<IconDelete />} />
                        </Popconfirm>
                      </div>
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </TabPane>

        {/* 资源 Tab - 对标巨日禄拆分为独立Tab */}
        <TabPane key="characters" title="角色管理">
          <Button type="primary" icon={<IconStorage />} onClick={() => navigate(`/projects/${projectId}/resources?tab=characters`)}>
            进入角色管理
          </Button>
        </TabPane>
        <TabPane key="scenes" title="场景管理">
          <Button type="primary" icon={<IconStorage />} onClick={() => navigate(`/projects/${projectId}/resources?tab=scenes-bg`)}>
            进入场景管理
          </Button>
        </TabPane>
        <TabPane key="props" title="物品管理">
          <Button type="primary" icon={<IconStorage />} onClick={() => navigate(`/projects/${projectId}/resources?tab=props`)}>
            进入物品管理
          </Button>
        </TabPane>
        <TabPane key="audio" title="音效管理">
          <Button type="primary" icon={<IconStorage />} onClick={() => navigate(`/projects/${projectId}/resources?tab=audio`)}>
            进入音效管理
          </Button>
        </TabPane>
        <TabPane key="fusion" title="融合生图">
          <Button type="primary" icon={<IconVideoCamera />} onClick={() => navigate(`/creation?projectId=${projectId}`)}>
            进入融合生图
          </Button>
        </TabPane>
        <TabPane key="image-edit" title="图片改创">
          <Button type="primary" icon={<IconEdit />} onClick={() => navigate(`/creation?projectId=${projectId}&mode=image_edit`)}>
            进入图片改创
          </Button>
        </TabPane>
        <TabPane key="ref-video" title="参考视频">
          <Card><Empty description="上传参考视频(开发中)" /></Card>
        </TabPane>
        <TabPane key="ref-audio" title="参考音频">
          <Card><Empty description="上传参考音频(开发中)" /></Card>
        </TabPane>

        {/* 视频生成 Tab */}
        <TabPane key="video" title="视频生成">
          <Button type="primary" icon={<IconVideoCamera />} onClick={() => navigate(`/projects/${projectId}/videos`)}>
            进入视频生成
          </Button>
        </TabPane>

        {/* 项目成员 Tab */}
        <TabPane key="members" title="项目成员">
          <Card>
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                管理谁可以访问该项目，分配项目内角色（负责人/管理者/编辑/只读）
              </Text>
              <Button type="primary" icon={<IconUserGroup />} onClick={() => navigate(`/projects/${projectId}/members`)}>
                进入项目成员管理
              </Button>
            </div>
          </Card>
        </TabPane>

        {/* 团队管理快捷入口 Tab */}
        <TabPane key="team" title="团队管理">
          <Card>
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                团队级成员/成员组/权限组/数据看板/积分统计/素材库权限（管理整个团队，非单个项目）
              </Text>
              <Button type="primary" onClick={() => {
                const oid = (JSON.parse(localStorage.getItem('user') || '{}')).active_org_id
                if (oid) navigate(`/team/${oid}/members`)
                else navigate('/team')
              }}>
                进入团队管理
              </Button>
            </div>
          </Card>
        </TabPane>
      </Tabs>

      {/* 编辑弹窗 */}
      {editing && (
        <Card title="编辑项目" style={{ position: 'fixed', bottom: 20, right: 20, width: 400, zIndex: 1000, boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}>
          <Form form={editForm} layout="vertical">
            <Form.Item field="name" label="项目名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item field="description" label="描述">
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item field="status" label="状态">
              <Select placeholder="选择项目状态">
                <Select.Option value="draft">草稿</Select.Option>
                <Select.Option value="producing">制作中</Select.Option>
                <Select.Option value="completed">已完成</Select.Option>
                <Select.Option value="archived">已归档</Select.Option>
              </Select>
            </Form.Item>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button onClick={() => setEditing(false)}>取消</Button>
              <Button type="primary" onClick={handleSaveEdit}>保存</Button>
            </div>
          </Form>
        </Card>
      )}
    </div>
  )
}

export default ProjectDetailPage
