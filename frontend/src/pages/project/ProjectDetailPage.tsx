/**
 * ProjectDetailPage - 项目详情（工作台布局）
 *
 * 头部（封面横幅/状态/操作）→ 统计卡 → 剧本内嵌列表 → 制作流程快捷入口网格。
 * 原版 13 个 Tab 全是"进入XX"跳转按钮，重构为单页工作台。
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Form, Input, Message, Modal, Spin, Typography, Grid, Statistic, Tag, Empty, Popconfirm, Select, Space } from '@arco-design/web-react'
import {
  IconEdit, IconFile, IconApps, IconVideoCamera, IconStorage, IconPlus,
  IconDelete, IconUserGroup, IconSound, IconImage, IconShareAlt, IconThunderbolt,
  IconFolder, IconRight,
} from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { projectService, scriptService } from '@/api/services'
import { PROJECT_STATUS } from '@/utils/statusLabels'

const { Title, Text } = Typography
const { Row, Col } = Grid

/** 制作流程快捷入口（原 13 个跳转 Tab 的收纳重组） */
const WORKFLOW_ENTRIES = (projectId?: string) => [
  { key: 'episodes', icon: <IconVideoCamera style={{ fontSize: 26, color: 'rgb(var(--arcoblue-6))' }} />, title: '集(片段)管理', desc: '按集组织片段、一键成片、智能审片', to: `/projects/${projectId}/episodes` },
  { key: 'videos', icon: <IconShareAlt style={{ fontSize: 26, color: 'rgb(var(--green-6))' }} />, title: '视频生成与预览', desc: '单镜/批量生成视频，查看任务结果', to: `/projects/${projectId}/videos` },
  { key: 'canvas', icon: <IconThunderbolt style={{ fontSize: 26, color: 'rgb(var(--orange-6))' }} />, title: '画布创作', desc: '节点画布手搓视频：融合生图 / 图片改创', to: `/canvas?projectId=${projectId}` },
  { key: 'characters', icon: <IconStorage style={{ fontSize: 26, color: 'rgb(var(--purple-6))' }} />, title: '角色管理', desc: '角色卡与角色立绘生成', to: `/projects/${projectId}/resources?tab=characters` },
  { key: 'scenes', icon: <IconImage style={{ fontSize: 26, color: 'rgb(var(--cyan-6))' }} />, title: '场景管理', desc: '场景背景图生成与管理', to: `/projects/${projectId}/resources?tab=scenes-bg` },
  { key: 'props', icon: <IconApps style={{ fontSize: 26, color: 'rgb(var(--gold-6))' }} />, title: '物品管理', desc: '道具设定图生成与管理', to: `/projects/${projectId}/resources?tab=props` },
  { key: 'audio', icon: <IconSound style={{ fontSize: 26, color: 'rgb(var(--pink-6))' }} />, title: '音效 / 参考音频', desc: 'BGM 与音频参考素材管理', to: `/projects/${projectId}/resources?tab=audio` },
  { key: 'ref-video', icon: <IconFolder style={{ fontSize: 26, color: 'rgb(var(--teal-6))' }} />, title: '参考视频', desc: '视频参考素材管理', to: `/projects/${projectId}/resources?tab=videos` },
  { key: 'members', icon: <IconUserGroup style={{ fontSize: 26, color: 'rgb(var(--red-6))' }} />, title: '项目成员', desc: '成员邀请、项目内角色分配', to: `/projects/${projectId}/members` },
]

const ProjectDetailPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<any>(null)
  const [scripts, setScripts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editVisible, setEditVisible] = useState(false)
  const [saving, setSaving] = useState(false)
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

  const openEdit = () => {
    editForm.setFieldsValue({
      name: project?.name,
      description: project?.description,
      status: project?.status || 'draft',
      cover_image_url: project?.cover_image_url || '',
    })
    setEditVisible(true)
  }

  const handleSaveEdit = async () => {
    try {
      const values = await editForm.validate()
      setSaving(true)
      await projectService.update(projectId!, {
        ...values,
        cover_image_url: values.cover_image_url?.trim() || null,
      })
      Message.success('保存成功')
      setEditVisible(false)
      loadData()
    } catch (err: any) {
      if (err?.errors) return
    } finally {
      setSaving(false)
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

  const st = PROJECT_STATUS[project.status] || PROJECT_STATUS.draft

  return (
    <div>
      {/* 封面横幅（有封面时） */}
      {project.cover_image_url && (
        <div style={{ height: 160, borderRadius: 8, overflow: 'hidden', marginBottom: 16, position: 'relative' }}>
          <img src={project.cover_image_url} alt={project.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(transparent, rgba(0,0,0,.45))' }} />
        </div>
      )}

      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <Space size={10}>
            <Title heading={5} style={{ margin: 0 }}>{project.name}</Title>
            <Tag color={st.color}>{st.label}</Tag>
          </Space>
          {project.description && <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>{project.description}</Text>}
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-3)' }}>
            {project.created_at && <span>创建于 {new Date(project.created_at).toLocaleDateString('zh-CN')}</span>}
            {project.updated_at && <span style={{ marginLeft: 12 }}>更新于 {new Date(project.updated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        </div>
        <Space size={8}>
          <Button icon={<IconEdit />} onClick={openEdit}>项目设置</Button>
          <Button type="primary" icon={<IconVideoCamera />} onClick={() => navigate(`/projects/${projectId}/episodes`)}>
            进入集管理
          </Button>
        </Space>
      </div>

      {/* 统计卡 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card><Statistic title="剧本" value={scripts.length} prefix={<IconFile />} /></Card></Col>
        <Col span={6}><Card><Statistic title="分镜" value={project.scene_count ?? 0} prefix={<IconApps />} /></Card></Col>
        <Col span={6}><Card><Statistic title="角色" value={project.character_count ?? 0} prefix={<IconStorage />} /></Card></Col>
        <Col span={6}><Card><Statistic title="成员" value={project.member_count ?? 0} prefix={<IconUserGroup />} /></Card></Col>
      </Row>

      {/* 剧本区（内嵌，直接可用） */}
      <Card
        title={<Space size={8}><IconFile /> 剧本（{scripts.length}）</Space>}
        style={{ marginBottom: 16 }}
        extra={
          <Space size={8}>
            <Button size="small" icon={<IconPlus />} loading={creatingScript} onClick={handleCreateScript}>新建剧本</Button>
            <Button size="small" onClick={() => navigate(`/projects/${projectId}/scripts`)}>剧本管理<IconRight /></Button>
          </Space>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
          剧本用于 AI 解析生成分镜，支持 @引用角色/场景/道具
        </Text>
        {scripts.length === 0 ? (
          <Empty description="还没有剧本，点击「新建剧本」开始" style={{ padding: 24 }} />
        ) : (
          <Row gutter={[12, 12]}>
            {scripts.slice(0, 6).map((s) => (
              <Col key={s.id} span={8}>
                <Card size="small" hoverable onClick={() => navigate(`/projects/${projectId}/scripts/${s.id}`)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <Text style={{ fontWeight: 600 }} ellipsis>{s.title || '未命名剧本'}</Text>
                      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }} ellipsis>
                        {s.content ? s.content.substring(0, 50) : '空剧本'}
                      </Text>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      {s.parsed_data && <Tag color="green" size="small">已解析</Tag>}
                      <Popconfirm title="确认删除该剧本？" onOk={() => handleDeleteScript(s.id)}>
                        <Button size="mini" status="danger" type="text" icon={<IconDelete />} />
                      </Popconfirm>
                    </div>
                  </div>
                </Card>
              </Col>
            ))}
            {scripts.length > 6 && (
              <Col span={8}>
                <Card size="small" hoverable onClick={() => navigate(`/projects/${projectId}/scripts`)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 72, borderStyle: 'dashed' }}>
                  <Text type="secondary">查看全部 {scripts.length} 个剧本<IconRight /></Text>
                </Card>
              </Col>
            )}
          </Row>
        )}
      </Card>

      {/* 制作流程快捷入口 */}
      <Card title={<Space size={8}><IconThunderbolt /> 制作流程</Space>}>
        <Row gutter={[16, 16]}>
          {WORKFLOW_ENTRIES(projectId).map((e) => (
            <Col key={e.key} xs={12} sm={8} md={6}>
              <Card size="small" hoverable style={{ height: '100%', cursor: 'pointer' }} onClick={() => navigate(e.to)}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  {e.icon}
                  <div style={{ minWidth: 0 }}>
                    <Text style={{ fontWeight: 600, display: 'block' }}>{e.title}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{e.desc}</Text>
                  </div>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      {/* 项目设置弹窗（原右下角浮动卡片 → 标准 Modal） */}
      <Modal
        title="项目设置"
        visible={editVisible}
        onCancel={() => setEditVisible(false)}
        onOk={handleSaveEdit}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item field="name" label="项目名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item field="description" label="描述">
            <Input.TextArea rows={3} maxLength={500} />
          </Form.Item>
          <Form.Item field="status" label="状态">
            <Select placeholder="选择项目状态">
              <Select.Option value="draft">草稿</Select.Option>
              <Select.Option value="producing">制作中</Select.Option>
              <Select.Option value="completed">已完成</Select.Option>
              <Select.Option value="archived">已归档</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item field="cover_image_url" label="封面图 URL" extra="粘贴图片地址作为项目封面，项目列表和本页横幅会展示">
            <Input placeholder="https://..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ProjectDetailPage
