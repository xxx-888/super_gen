/**
 * ProjectListPage - 项目列表
 *
 * 功能：项目卡片列表、创建项目、删除项目、进入项目详情
 */
import React, { useEffect, useState, useCallback } from 'react'
import { Card, Button, Modal, Form, Input, Message, Grid, Empty, Spin, Typography, Tag, Select, Space, Pagination } from '@arco-design/web-react'
import { IconPlus, IconDelete, IconEdit, IconFile, IconVideoCamera, IconApps, IconStorage, IconUserGroup, IconExport, IconSearch, IconRefresh, IconThunderbolt, IconCheckCircle } from '@arco-design/web-react/icon'
import { useNavigate, useLocation } from 'react-router-dom'
import { projectService } from '@/api/services'
import { useTeamStore } from '@/stores'
import { useCurrentUser } from '@/utils/auth'

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
  const location = useLocation()
  const [projects, setProjects] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createVisible, setCreateVisible] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm()
  const [editVisible, setEditVisible] = useState(false)
  const [editTarget, setEditTarget] = useState<any>(null)
  const [editForm] = Form.useForm()
  // 筛选/排序/分页
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
  const [sortBy, setSortBy] = useState('updated_at')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(60)
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<any>(null)

  const { currentOrg } = useTeamStore()
  const currentUser = useCurrentUser()

  // 拉取项目列表（自己的 + 加入的）。仅在 currentOrg 变化时重建，避免闭包过期。
  const loadProjects = useCallback(async () => {
    try {
      const data: any = await projectService.list({
        org_id: currentOrg?.id,
        page, page_size: pageSize,
        search: search || undefined,
        status: statusFilter,
        sort_by: sortBy, sort_order: 'desc',
      })
      const d = data?.items ? data : { items: Array.isArray(data) ? data : [], total: 0 }
      setProjects(d.items || [])
      setTotal(typeof d.total === 'number' ? d.total : (d.items || []).length)
      setSummary(d.summary ?? null)
    } catch {
      // 错误已由拦截器提示
    } finally {
      setLoading(false)
    }
  }, [currentOrg?.id, search, statusFilter, sortBy, page, pageSize])

  // 进入页面 / 切换团队 / 筛选变化 / 路由重新进入（location.key 变化）都刷新一次。
  // 首次由 loading 初值=true 显示骨架，后续为后台静默刷新，不闪烁。
  useEffect(() => {
    loadProjects()
  }, [loadProjects, location.key])

  // 切回浏览器标签页（窗口聚焦）时静默刷新，保证看到最新数据
  useEffect(() => {
    const onFocus = () => loadProjects()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadProjects])

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

  const handleLeave = (id: string, name: string) => {
    Modal.confirm({
      title: '退出项目',
      content: `确定要退出项目「${name}」吗？退出后该项目不再显示在你的列表里，项目本身及其所有者不受影响。`,
      okButtonProps: { status: 'danger' },
      okText: '退出',
      cancelText: '取消',
      onOk: async () => {
        await projectService.leave(id)
        Message.success('已退出项目')
        loadProjects()
      },
    })
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} tip="加载中..." /></div>
  }

  return (
    <div>
      {/* 统计卡（后端 summary 全量口径） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        {[
          { t: '项目总数', v: summary?.total ?? total, s: undefined, c: 'rgb(var(--arcoblue-6))', I: IconApps },
          { t: '制作中', v: summary?.producing ?? '-', s: undefined, c: 'rgb(var(--orange-6))', I: IconThunderbolt },
          { t: '已完成', v: summary?.completed ?? '-', s: undefined, c: 'rgb(var(--green-6))', I: IconCheckCircle },
          { t: '草稿 / 归档', v: `${summary?.draft ?? 0} / ${summary?.archived ?? 0}`, s: undefined, c: 'var(--color-text-3)', I: IconStorage },
        ].map(({ t, v, s, c, I }: any) => (
          <Col key={t} span={6}>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <I style={{ fontSize: 22, color: c }} />
                <Text type="secondary" style={{ fontSize: 13 }}>{t}</Text>
              </div>
              <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{v}</div>
              {s && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{s}</div>}
            </Card>
          </Col>
        ))}
      </Row>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Title heading={5} style={{ margin: 0 }}>项目管理</Title>
        <Space size={8} wrap>
          <Input
            placeholder="搜索项目名 / 描述"
            style={{ width: 200 }}
            value={search}
            onChange={setSearch}
            allowClear
            prefix={<IconSearch />}
            onPressEnter={() => { setPage(1); loadProjects() }}
            onClear={() => { setSearch(''); setPage(1); setTimeout(loadProjects, 0) }}
          />
          <Select
            placeholder="状态" style={{ width: 100 }} allowClear value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
          >
            <Select.Option value="draft">草稿</Select.Option>
            <Select.Option value="producing">制作中</Select.Option>
            <Select.Option value="completed">已完成</Select.Option>
            <Select.Option value="archived">已归档</Select.Option>
          </Select>
          <Select value={sortBy} style={{ width: 120 }} onChange={(v) => { setSortBy(v); setPage(1) }}>
            <Select.Option value="updated_at">按最近更新</Select.Option>
            <Select.Option value="created_at">按创建时间</Select.Option>
            <Select.Option value="name">按名称</Select.Option>
          </Select>
          <Button icon={<IconRefresh />} onClick={loadProjects}>刷新</Button>
          <Button type="primary" icon={<IconPlus />} onClick={() => setCreateVisible(true)}>新建项目</Button>
        </Space>
      </div>

      {projects.length === 0 ? (
        <Card>
          <Empty
            description={search || statusFilter ? '没有符合筛选条件的项目' : '还没有项目，点击右上角创建第一个项目'}
            style={{ padding: 40 }}
          />
        </Card>
      ) : (
        <Row gutter={16}>
          {projects.map((p) => {
            const st = statusMap[p.status] || statusMap.draft
            const isOwner = !!currentUser?.id && String(currentUser.id) === String(p.user_id)
            return (
              <Col key={p.id} span={8} style={{ marginBottom: 16 }}>
                <Card
                  hoverable
                  onClick={() => navigate(`/projects/${p.id}`)}
                  cover={p.cover_image_url ? (
                    <div style={{ height: 110, overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
                      <img src={p.cover_image_url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                  ) : undefined}
                  actions={isOwner ? [
                    <span key="edit" onClick={(e) => openEdit(p, e)}>
                      <IconEdit /> 编辑
                    </span>,
                    <span key="enter" onClick={(e) => { e.stopPropagation(); navigate(`/projects/${p.id}`) }}>
                      <IconFile /> 进入
                    </span>,
                    <span key="del" style={{ color: 'var(--color-danger)' }} onClick={(e) => { e.stopPropagation(); handleDelete(p.id, p.name) }}>
                      <IconDelete /> 删除
                    </span>,
                  ] : [
                    <span key="enter" onClick={(e) => { e.stopPropagation(); navigate(`/projects/${p.id}`) }}>
                      <IconFile /> 进入
                    </span>,
                    <span key="leave" style={{ color: 'var(--color-danger)' }} onClick={(e) => { e.stopPropagation(); handleLeave(p.id, p.name) }}>
                      <IconExport /> 退出项目
                    </span>,
                  ]}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    {p.cover_image_url ? null : <IconFile style={{ fontSize: 20, color: 'rgb(var(--primary-6))' }} />}
                    <Text style={{ fontSize: 16, fontWeight: 600 }} ellipsis>{p.name}</Text>
                  </div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 12, minHeight: 20 }}>
                    {p.description || '暂无描述'}
                  </Text>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
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
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      <Tag color={st.color} size="small">{st.label}</Tag>
                      {!isOwner && <Tag color="arcoblue" size="small">成员</Tag>}
                    </span>
                    {p.updated_at && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        更新 {new Date(p.updated_at).toLocaleDateString('zh-CN')}
                      </Text>
                    )}
                  </div>
                </Card>
              </Col>
            )
          })}
        </Row>
      )}
      {total > pageSize && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
          <Pagination current={page} pageSize={pageSize} total={total} showTotal onChange={setPage} />
        </div>
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
