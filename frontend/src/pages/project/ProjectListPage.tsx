/**
 * ProjectListPage - 项目列表
 *
 * 功能：项目卡片列表、创建项目、删除项目、进入项目详情
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Modal, Form, Input, Message, Grid, Empty, Spin, Typography, Tag, Select } from '@arco-design/web-react'
import { IconPlus, IconDelete, IconEdit, IconFile, IconVideoCamera, IconApps, IconStorage, IconUserGroup } from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { projectService } from '@/api/services'

const { Row, Col } = Grid
const { Title, Text } = Typography

const statusMap: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'gray' },
  producing: { label: '制作中', color: 'blue' },
  completed: { label: '已完成', color: 'green' },
  archived: { label: '已归档', color: 'orange' },
}

const ProjectListPage: React.FC = () => {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createVisible, setCreateVisible] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm()
  const [editVisible, setEditVisible] = useState(false)
  const [editTarget, setEditTarget] = useState<any>(null)
  const [editForm] = Form.useForm()

  const loadProjects = async () => {
    try {
      const data: any = await projectService.list()
      setProjects(Array.isArray(data) ? data : [])
    } catch {
      // 错误已由拦截器提示
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadProjects() }, [])

  const handleCreate = async () => {
    try {
      const values = await form.validate()
      setCreating(true)
      await projectService.create(values)
      Message.success('项目创建成功')
      setCreateVisible(false)
      form.resetFields()
      loadProjects()
    } catch (err: any) {
      if (err?.errors) return // 表单校验错误
    } finally {
      setCreating(false)
    }
  }

  const openEdit = (project: any, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditTarget(project)
    editForm.setFieldsValue({
      name: project.name, description: project.description,
      status: project.status || 'draft', cover_image_url: project.cover_image_url,
    })
    setEditVisible(true)
  }

  const handleSaveEdit = async () => {
    try {
      const values = await editForm.validate()
      await projectService.update(editTarget.id, values)
      Message.success('保存成功')
      setEditVisible(false)
      setEditTarget(null)
      loadProjects()
    } catch (err: any) {
      if (err?.errors) return
    }
  }

  const handleDelete = (id: string, name: string) => {
    Modal.confirm({
      title: '确认删除',
      content: `确定要删除项目「${name}」吗？此操作不可恢复。`,
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        await projectService.delete(id)
        Message.success('删除成功')
        loadProjects()
      },
    })
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} tip="加载中..." /></div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title heading={5} style={{ margin: 0 }}>项目管理</Title>
        <Button type="primary" icon={<IconPlus />} onClick={() => setCreateVisible(true)}>新建项目</Button>
      </div>

      {projects.length === 0 ? (
        <Card>
          <Empty
            description="还没有项目，点击右上角创建第一个项目"
            style={{ padding: 40 }}
          />
        </Card>
      ) : (
        <Row gutter={16}>
          {projects.map((p) => {
            const st = statusMap[p.status] || statusMap.draft
            return (
              <Col key={p.id} span={8} style={{ marginBottom: 16 }}>
                <Card
                  hoverable
                  onClick={() => navigate(`/projects/${p.id}`)}
                  actions={[
                    <span key="edit" onClick={(e) => openEdit(p, e)}>
                      <IconEdit /> 编辑
                    </span>,
                    <span key="enter" onClick={(e) => { e.stopPropagation(); navigate(`/projects/${p.id}`) }}>
                      <IconFile /> 进入
                    </span>,
                    <span key="del" style={{ color: 'var(--color-danger)' }} onClick={(e) => { e.stopPropagation(); handleDelete(p.id, p.name) }}>
                      <IconDelete /> 删除
                    </span>,
                  ]}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <IconFile style={{ fontSize: 20, color: 'rgb(var(--primary-6))' }} />
                    <Text style={{ fontSize: 16, fontWeight: 600 }}>{p.name}</Text>
                  </div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 12, minHeight: 20 }}>
                    {p.description || '暂无描述'}
                  </Text>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                    <span style={{ fontSize: 13, color: 'var(--color-text-3)' }}>
                      <IconApps /> {p.script_count ?? 0} 剧本
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--color-text-3)' }}>
                      <IconVideoCamera /> {p.scene_count ?? 0} 分镜
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--color-text-3)' }}>
                      <IconStorage /> {p.character_count ?? 0} 角色
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--color-text-3)' }}>
                      <IconUserGroup /> {p.member_count ?? 0} 成员
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Tag color={st.color} size="small">{st.label}</Tag>
                    {p.created_at && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        创建于 {new Date(p.created_at).toLocaleDateString('zh-CN')}
                      </Text>
                    )}
                  </div>
                </Card>
              </Col>
            )
          })}
        </Row>
      )}

      {/* 创建项目弹窗 */}
      <Modal
        title="新建项目"
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        onOk={handleCreate}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item field="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
            <Input placeholder="请输入项目名称" />
          </Form.Item>
          <Form.Item field="description" label="项目描述">
            <Input.TextArea placeholder="简要描述项目内容" rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑项目弹窗 */}
      <Modal
        title="编辑项目"
        visible={editVisible}
        onCancel={() => { setEditVisible(false); setEditTarget(null) }}
        onOk={handleSaveEdit}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item field="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
            <Input placeholder="请输入项目名称" />
          </Form.Item>
          <Form.Item field="description" label="项目描述">
            <Input.TextArea placeholder="简要描述项目内容" rows={3} />
          </Form.Item>
          <Form.Item field="status" label="项目状态">
            <Select placeholder="选择项目状态">
              <Select.Option value="draft">草稿</Select.Option>
              <Select.Option value="producing">制作中</Select.Option>
              <Select.Option value="completed">已完成</Select.Option>
              <Select.Option value="archived">已归档</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item field="cover_image_url" label="封面图URL">
            <Input placeholder="https://... (可选)" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ProjectListPage
