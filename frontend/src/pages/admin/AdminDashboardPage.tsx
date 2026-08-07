/**
 * AdminDashboardPage - 后台管理
 *
 * 功能：平台统计、用户管理、任务监控
 */
import React, { useEffect, useState } from 'react'
import { Card, Spin, Typography, Grid, Statistic, Table, Tag, Space, Button, Message, Popconfirm, Tabs, Empty, Form, Input, Modal, Drawer, Descriptions, Select } from '@arco-design/web-react'
import { IconUser, IconUserGroup, IconFile, IconApps, IconVideoCamera, IconPlus, IconDelete, IconEdit, IconLock, IconEye, IconClose, IconStop, IconRefresh, IconImage, IconPlayCircle, IconSound, IconDownload } from '@arco-design/web-react/icon'
import { useLocation } from 'react-router-dom'
import { adminService, taskService } from '@/api/services'
import { PROJECT_STATUS, TASK_STATUS, statusColor, statusLabel } from '@/utils/statusLabels'
import { renderPromptText, truncatePromptText } from '@/utils/prompt'
import HighlightPrompt from '@/components/editor/HighlightPrompt'

const { Title, Text } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

/** 判断输出文件的媒体类型，用于在线预览。
 *  优先用任务 type（后端权威字段），再用扩展名兜底（兼容 stub / 远端 URL）。
 *  返回 null 表示无法内联预览（如 .srt 字幕），调用方应改为提供下载链接。
 */
function detectMediaKind(url: string, taskType?: string): 'image' | 'video' | 'audio' | null {
  const u = (url || '').toLowerCase()
  // 任务类型权威判定
  if (taskType === 'image') return 'image'
  if (taskType === 'video' || taskType === 'remove_subtitle') return 'video'
  if (taskType === 'audio') return 'audio'
  // 扩展名兜底
  if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/.test(u)) return 'image'
  if (/\.(mp4|webm|mov|m4v|avi)(\?|$)/.test(u)) return 'video'
  if (/\.(mp3|wav|m4a|aac|flac|ogg)(\?|$)/.test(u)) return 'audio'
  return null
}

const AdminDashboardPage: React.FC = () => {
  const location = useLocation()
  const [stats, setStats] = useState<any>(null)
  const [users, setUsers] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [projects, setProjects] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // 任务分页状态（后端分页）
  const [taskPage, setTaskPage] = useState(1)
  const [taskPageSize, setTaskPageSize] = useState(20)
  const [taskTotal, setTaskTotal] = useState(0)
  const [taskStatus, setTaskStatus] = useState<string | undefined>(undefined)

  // 根据 URL 决定 activeTab
  const pathTabMap: Record<string, string> = {
    '/admin': 'overview',
    '/admin/users': 'users',
    '/admin/projects': 'projects',
    '/admin/tasks': 'tasks',
  }
  const activeTab = pathTabMap[location.pathname] || 'overview'

  const loadData = async () => {
    setLoading(true)
    try {
      const [statsData, usersData, tasksData, projectsData]: any = await Promise.all([
        adminService.stats(),
        adminService.users(),
        adminService.tasks({ page: taskPage, page_size: taskPageSize, status: taskStatus }),
        adminService.projects(),
      ])
      setStats(statsData)
      setUsers(Array.isArray(usersData) ? usersData : [])
      // 任务接口现为分页结构 { items, total, page, page_size }
      setTasks(Array.isArray(tasksData?.items) ? tasksData.items : [])
      setTaskTotal(typeof tasksData?.total === 'number' ? tasksData.total : 0)
      setProjects(Array.isArray(projectsData) ? projectsData : [])
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }

  useEffect(() => { loadData() }, [])

  const handleToggleStatus = async (userId: string) => {
    await adminService.toggleStatus(userId)
    Message.success('状态已切换')
    loadData()
  }

  const handleRoleChange = async (userId: string, role: string) => {
    await adminService.updateRole(userId, role)
    Message.success('角色已更新')
    loadData()
  }

  // 新建用户
  const [createUserVisible, setCreateUserVisible] = useState(false)
  const [creatingUser, setCreatingUser] = useState(false)
  const [createUserForm] = Form.useForm()
  // 编辑用户 / 重置密码 / 详情
  const [editUserTarget, setEditUserTarget] = useState<any>(null)
  const [editUserForm] = Form.useForm()
  const [resetPwdTarget, setResetPwdTarget] = useState<any>(null)
  const [resetPwdForm] = Form.useForm()
  const [userDetail, setUserDetail] = useState<any>(null)
  const [userDetailVisible, setUserDetailVisible] = useState(false)

  const handleEditUser = async () => {
    try {
      const v = await editUserForm.validate()
      await adminService.updateUser(editUserTarget.id, v)
      Message.success('用户信息已更新')
      setEditUserTarget(null); loadData()
    } catch (e: any) { if (e?.errors) return }
  }

  const handleResetPwd = async () => {
    try {
      const v = await resetPwdForm.validate()
      await adminService.resetUserPassword(resetPwdTarget.id, v.new_password)
      Message.success('密码已重置')
      setResetPwdTarget(null); resetPwdForm.resetFields()
    } catch (e: any) { if (e?.errors) return }
  }

  const openUserDetail = async (row: any) => {
    try {
      const res: any = await adminService.getUserDetail(row.id)
      setUserDetail(res)
      setUserDetailVisible(true)
    } catch { setUserDetail(row); setUserDetailVisible(true) }
  }

  const handleAdminDeleteProject = async (id: string) => {
    try {
      await adminService.deleteProject(id)
      Message.success('项目已删除')
      loadData()
    } catch { Message.error('删除失败') }
  }

  const handleCancelTask = async (id: string) => {
    try {
      await taskService.cancel(id)
      Message.success('任务已取消')
      loadData()
    } catch { Message.error('取消失败') }
  }

  const handleCancelAllPending = async () => {
    try {
      await adminService.cancelAllPending()
      Message.success('已取消所有待处理任务')
      loadData()
    } catch { Message.error('操作失败') }
  }

  // 按条件重新加载项目
  const loadAdminProjects = async (search?: string) => {
    try {
      const data: any = await adminService.projects({ search })
      setProjects(Array.isArray(data) ? data : [])
    } catch { /* ignore */ }
  }

  // 按状态/页码重新加载任务（后端分页）
  const loadAdminTasks = async (opts?: { page?: number; pageSize?: number; status?: string }) => {
    try {
      const page = opts?.page ?? taskPage
      const pageSize = opts?.pageSize ?? taskPageSize
      const status = opts?.status ?? taskStatus
      const data: any = await adminService.tasks({ page, page_size: pageSize, status })
      setTasks(Array.isArray(data?.items) ? data.items : [])
      setTaskTotal(typeof data?.total === 'number' ? data.total : 0)
    } catch { /* ignore */ }
  }

  const [taskDetail, setTaskDetail] = useState<any>(null)
  const [taskDetailVisible, setTaskDetailVisible] = useState(false)
  const openTaskDetail = (row: any) => { setTaskDetail(row); setTaskDetailVisible(true) }
  // 任务输出文件在线预览（图片/视频/音频）；其它类型（如字幕 .srt）提供下载链接
  const [previewMedia, setPreviewMedia] = useState<{ url: string; kind: 'image' | 'video' | 'audio' } | null>(null)

  const handleCreateUser = async () => {
    try {
      const values = await createUserForm.validate()
      setCreatingUser(true)
      await adminService.createUser(values)
      Message.success('用户创建成功')
      setCreateUserVisible(false)
      createUserForm.resetFields()
      loadData()
    } catch (err: any) {
      if (err?.errors) return
      Message.error(err?.response?.data?.detail || '创建失败')
    } finally {
      setCreatingUser(false)
    }
  }

  const handleDeleteUser = async (userId: string) => {
    try {
      await adminService.deleteUser(userId)
      Message.success('用户已删除')
      loadData()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} tip="加载中..." /></div>

  const userColumns = [
    { title: '邮箱', dataIndex: 'email' },
    { title: '昵称', dataIndex: 'nickname', width: 120 },
    { title: '角色', dataIndex: 'role', width: 100, render: (v: string) => <Tag color={v === 'admin' ? 'red' : 'blue'}>{v === 'admin' ? '管理员' : '普通用户'}</Tag> },
    { title: '状态', dataIndex: 'is_active', width: 80, render: (v: boolean) => <Tag color={v ? 'green' : 'gray'}>{v ? '活跃' : '禁用'}</Tag> },
    { title: '注册时间', dataIndex: 'created_at', width: 180, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    { title: '操作', width: 340, render: (_: any, row: any) => (
      <Space size="small">
        <Button size="mini" icon={<IconEye />} onClick={() => openUserDetail(row)}>详情</Button>
        <Button size="mini" icon={<IconEdit />} onClick={() => {
          setEditUserTarget(row)
          editUserForm.setFieldsValue({ email: row.email, nickname: row.nickname, role: row.role })
        }}>编辑</Button>
        <Button size="mini" icon={<IconLock />} onClick={() => setResetPwdTarget(row)}>重置密码</Button>
        <Popconfirm title={`确认${row.is_active ? '禁用' : '启用'}？`} onOk={() => handleToggleStatus(row.id)}>
          <Button size="mini" status={row.is_active ? 'danger' : 'success'}>
            {row.is_active ? '禁用' : '启用'}
          </Button>
        </Popconfirm>
        <Popconfirm title="确认删除该用户？" onOk={() => handleDeleteUser(row.id)}>
          <Button size="mini" status="danger" icon={<IconDelete />} />
        </Popconfirm>
      </Space>
    )},
  ]

  const taskColumns = [
    { title: '类型', dataIndex: 'type', width: 90, render: (v: string) => {
      const map: Record<string, { label: string; color: string }> = {
        video: { label: '视频', color: 'green' },
        image: { label: '图片', color: 'arcoblue' },
        audio: { label: '音频', color: 'purple' },
        script_parse: { label: '剧本解析', color: 'magenta' },
        remove_subtitle: { label: '去字幕', color: 'orange' },
      }
      const m = map[v] || { label: v, color: 'gray' }
      return <Tag color={m.color}>{m.label}</Tag>
    } },
    { title: '项目', dataIndex: 'project_name', width: 120, ellipsis: true, render: (v: string) => <Text style={{ fontSize: 13 }}>{v || '-'}</Text> },
    { title: '模型', dataIndex: 'model', width: 130, render: (v: string) => <Tag size="small" color="arcoblue">{v || '-'}</Tag> },
    {
      title: '提示词', ellipsis: true, render: (_: any, row: any) => {
        const p = row.input_data?.prompt || row.input_data?.resource_name || ''
        return <Text style={{ fontSize: 12 }}>{p ? truncatePromptText(p, 40) : '-'}</Text>
      }
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={statusColor(v, TASK_STATUS)}>{statusLabel(v, TASK_STATUS)}</Tag> },
    { title: '进度', dataIndex: 'progress', width: 70, render: (v: number) => `${v || 0}%` },
    { title: '积分', dataIndex: 'credits_consumed', width: 60, render: (v: number) => v ? <Text type="warning">{v}</Text> : '-' },
    { title: '创建时间', dataIndex: 'created_at', width: 140, render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text> : '-' },
    { title: '操作', width: 140, render: (_: any, row: any) => (
      <Space size="small">
        <Button size="mini" icon={<IconEye />} onClick={() => openTaskDetail(row)}>详情</Button>
        {['pending', 'processing'].includes(row.status) && (
          <Popconfirm title="确认取消该任务？" onOk={() => handleCancelTask(row.id)}>
            <Button size="mini" status="warning" icon={<IconStop />}>取消</Button>
          </Popconfirm>
        )}
      </Space>
    )},
  ]

  const projectColumns = [
    { title: '项目名', dataIndex: 'name', fixed: 'left' as const, width: 220, render: (v: string, row: any) => (
      <Space direction="vertical" size={2}>
        <Text style={{ fontWeight: 600 }}>{v}</Text>
        {row.description && <Text type="secondary" style={{ fontSize: 12 }}>{row.description.length > 40 ? row.description.slice(0, 40) + '...' : row.description}</Text>}
      </Space>
    )},
    { title: '所有者', dataIndex: 'owner_email', width: 160, render: (v: string, row: any) => (
      <Text style={{ fontSize: 13 }}>{row.owner_nickname !== '-' ? row.owner_nickname : ''} {v && v !== '-' ? `(${v})` : ''}</Text>
    )},
    { title: '剧本', dataIndex: 'script_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="cyan">{v || 0}</Tag> },
    { title: '成员', dataIndex: 'member_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="purple">{v || 0}</Tag> },
    { title: '分镜', dataIndex: 'scene_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="blue">{v || 0}</Tag> },
    { title: '角色', dataIndex: 'character_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="magenta">{v || 0}</Tag> },
    { title: '物品', dataIndex: 'prop_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="orange">{v || 0}</Tag> },
    { title: '场景', dataIndex: 'scene_background_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="green">{v || 0}</Tag> },
    { title: '任务数', dataIndex: 'task_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="arcoblue">{v || 0}</Tag> },
    { title: '消耗积分', dataIndex: 'credits_used', width: 90, align: 'center' as const, render: (v: number) => v ? <Text type="warning">{v}</Text> : '-' },
    { title: '状态', dataIndex: 'status', width: 90, align: 'center' as const, render: (v: string) => (
      <Tag color={statusColor(v, PROJECT_STATUS)}>{statusLabel(v, PROJECT_STATUS)}</Tag>
    )},
    { title: '创建时间', dataIndex: 'created_at', width: 140, render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text> : '-' },
    { title: '操作', width: 80, fixed: 'right' as const, render: (_: any, row: any) => (
      <Popconfirm title="确认删除该项目？此操作不可恢复" onOk={() => handleAdminDeleteProject(row.id)}>
        <Button size="mini" status="danger" icon={<IconDelete />} />
      </Popconfirm>
    )},
  ]

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>后台管理</Title>
      <Tabs activeTab={activeTab}>
        {/* 概览 */}
        <TabPane key="overview" title="平台概览">
          <Row gutter={16} style={{ marginBottom: 20 }}>
            <Col span={6}><Card><Statistic title="总用户数" value={stats?.total_users ?? 0} prefix={<IconUserGroup />} /></Card></Col>
            <Col span={6}><Card><Statistic title="总项目数" value={stats?.total_projects ?? 0} prefix={<IconFile />} /></Card></Col>
            <Col span={6}><Card><Statistic title="总任务数" value={stats?.total_tasks ?? 0} prefix={<IconApps />} /></Card></Col>
            <Col span={6}><Card><Statistic title="存储使用(GB)" value={stats?.storage_used ?? 0} prefix={<IconVideoCamera />} /></Card></Col>
          </Row>
          {stats?.tasks_by_status && (
            <Card title="任务状态分布">
              <Space wrap>
                {Object.entries(stats.tasks_by_status).map(([k, v]) => (
                  <Tag key={k} color="arcoblue">{k}: {v as any}</Tag>
                ))}
              </Space>
            </Card>
          )}
        </TabPane>

        {/* 用户管理 */}
        <TabPane key="users" title="用户管理">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ color: 'var(--color-text-3)', fontSize: 13 }}>共 {users.length} 个用户</span>
            <Button type="primary" icon={<IconPlus />} onClick={() => setCreateUserVisible(true)}>新建用户</Button>
          </div>
          <Card>
            <Table columns={userColumns} data={users} rowKey="id" pagination={{ pageSize: 20 }} />
          </Card>
        </TabPane>

        {/* 项目监控 */}
        <TabPane key="projects" title="项目监控">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Space>
              <span style={{ color: 'var(--color-text-3)', fontSize: 13 }}>共 {projects.length} 个项目</span>
              <Input.Search
                placeholder="搜索项目名"
                style={{ width: 200 }}
                onSearch={(v) => { loadAdminProjects(v) }}
                allowClear
              />
            </Space>
            <Button icon={<IconRefresh />} onClick={() => loadData()}>刷新</Button>
          </div>
          <Card>
            <Table columns={projectColumns} data={projects} rowKey="id" pagination={{ pageSize: 20 }} size="small" scroll={{ x: 1500 }} />
          </Card>
        </TabPane>

        {/* 任务监控 */}
        <TabPane key="tasks" title="任务监控">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Space>
              <span style={{ color: 'var(--color-text-3)', fontSize: 13 }}>共 {taskTotal} 条任务</span>
              <Select
                placeholder="按状态筛选"
                style={{ width: 130 }}
                allowClear
                value={taskStatus}
                onChange={(v) => {
                  setTaskStatus(v)
                  setTaskPage(1)
                  loadAdminTasks({ status: v, page: 1 })
                }}
              >
                <Select.Option value="processing">处理中</Select.Option>
                <Select.Option value="completed">已完成</Select.Option>
                <Select.Option value="failed">失败</Select.Option>
                <Select.Option value="pending">等待中</Select.Option>
                <Select.Option value="cancelled">已取消</Select.Option>
              </Select>
            </Space>
            <Popconfirm title="确认取消所有待处理任务？" onOk={() => handleCancelAllPending()}>
              <Button status="warning" icon={<IconStop />}>取消所有待处理</Button>
            </Popconfirm>
          </div>
          <Card>
            <Table
              columns={taskColumns}
              data={tasks}
              rowKey="id"
              size="small"
              pagination={{
                current: taskPage,
                pageSize: taskPageSize,
                total: taskTotal,
                showTotal: true,
                showJumper: true,
                sizeOptions: [10, 20, 50, 100],
                onChange: (page, pageSize) => {
                  setTaskPage(page)
                  setTaskPageSize(pageSize)
                  loadAdminTasks({ page, pageSize })
                },
              }}
            />
          </Card>
        </TabPane>
      </Tabs>

      {/* 新建用户弹窗 */}
      <Modal
        title="新建用户"
        visible={createUserVisible}
        onCancel={() => setCreateUserVisible(false)}
        onOk={handleCreateUser}
        confirmLoading={creatingUser}
        okText="创建"
        cancelText="取消"
      >
        <Form form={createUserForm} layout="vertical">
          <Form.Item field="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
            <Input placeholder="user@example.com" />
          </Form.Item>
          <Form.Item field="nickname" label="昵称">
            <Input placeholder="用户昵称" />
          </Form.Item>
          <Form.Item field="password" label="初始密码" rules={[{ required: true, minLength: 8, message: '密码至少 8 位' }]}>
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑用户弹窗 */}
      <Modal
        title="编辑用户" visible={!!editUserTarget}
        onCancel={() => setEditUserTarget(null)} onOk={handleEditUser}
        okText="保存" cancelText="取消"
      >
        <Form form={editUserForm} layout="vertical">
          <Form.Item field="email" label="邮箱">
            <Input disabled placeholder="邮箱注册后不可修改" />
          </Form.Item>
          <Form.Item field="nickname" label="昵称">
            <Input />
          </Form.Item>
          <Form.Item field="role" label="角色">
            <Select placeholder="请选择角色">
              <Select.Option value="admin">管理员</Select.Option>
              <Select.Option value="user">普通用户</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码弹窗 */}
      <Modal
        title="重置密码" visible={!!resetPwdTarget}
        onCancel={() => { setResetPwdTarget(null); resetPwdForm.resetFields() }}
        onOk={handleResetPwd} okText="重置" cancelText="取消"
      >
        <p style={{ color: 'var(--color-text-3)' }}>将为 <b>{resetPwdTarget?.email}</b> 设置新密码</p>
        <Form form={resetPwdForm} layout="vertical">
          <Form.Item field="new_password" label="新密码" rules={[{ required: true, minLength: 8, message: '至少8位' }]}>
            <Input.Password placeholder="至少8位" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 用户详情抽屉 */}
      <Drawer
        title="用户详情" width={420}
        visible={userDetailVisible} onCancel={() => setUserDetailVisible(false)}
        footer={null}
      >
        {userDetail && (
          <Descriptions column={1} data={[
            { label: '用户ID', value: userDetail.id },
            { label: '邮箱', value: userDetail.email },
            { label: '昵称', value: userDetail.nickname || '-' },
            { label: '角色', value: <Tag color={userDetail.role === 'admin' ? 'red' : 'blue'}>{userDetail.role === 'admin' ? '管理员' : '普通用户'}</Tag> },
            { label: '状态', value: <Tag color={userDetail.is_active ? 'green' : 'gray'}>{userDetail.is_active ? '活跃' : '禁用'}</Tag> },
            { label: '注册时间', value: userDetail.created_at ? new Date(userDetail.created_at).toLocaleString('zh-CN') : '-' },
          ]} />
        )}
      </Drawer>

      {/* 任务详情抽屉 */}
      <Drawer
        title="任务详情" width={480}
        visible={taskDetailVisible} onCancel={() => setTaskDetailVisible(false)}
        footer={null}
      >
        {taskDetail && (
          <Descriptions column={1} data={[
            { label: '任务ID', value: taskDetail.id },
            { label: '类型', value: (() => {
              const map: Record<string, { label: string; color: string }> = {
                video: { label: '视频', color: 'green' }, image: { label: '图片', color: 'arcoblue' },
                audio: { label: '音频', color: 'purple' }, script_parse: { label: '剧本解析', color: 'magenta' },
                remove_subtitle: { label: '去字幕', color: 'orange' },
              }
              const m = map[taskDetail.type] || { label: taskDetail.type, color: 'gray' }
              return <Tag color={m.color}>{m.label}</Tag>
            })() },
            { label: '项目', value: taskDetail.project_name || '-' },
            { label: '模型', value: <Tag color="arcoblue">{taskDetail.model}</Tag> },
            { label: '状态', value: <Tag color={statusColor(taskDetail.status, TASK_STATUS)}>{statusLabel(taskDetail.status, TASK_STATUS)}</Tag> },
            { label: '进度', value: `${taskDetail.progress || 0}%` },
            { label: '消耗积分', value: taskDetail.credits_consumed ?? 0 },
            { label: '提示词', value: <div style={{ maxHeight: 100, overflow: 'auto', fontSize: 13 }}>{(() => { const p = (taskDetail.input_data || {}).prompt || (taskDetail.input_data || {}).resource_name; return p ? <HighlightPrompt prompt={p} fontSize={13} /> : '-' })()}</div> },
            { label: '输出文件', value: (taskDetail.output_urls || []).length > 0 ? (
              <Space wrap>
                {taskDetail.output_urls.map((url: string, i: number) => {
                  const kind = detectMediaKind(url, taskDetail.type)
                  if (kind) {
                    const icon = kind === 'image' ? <IconImage /> : kind === 'video' ? <IconPlayCircle /> : <IconSound />
                    return (
                      <Tag key={i} size="small" color="green" style={{ cursor: 'pointer' }}
                        onClick={() => setPreviewMedia({ url, kind })}>
                        {icon} 文件{i + 1}
                      </Tag>
                    )
                  }
                  // 无法内联预览（如字幕 .srt）→ 提供下载/打开链接
                  return (
                    <Tag key={i} size="small" color="arcoblue" style={{ cursor: 'pointer' }}>
                      <a href={url} target="_blank" rel="noreferrer"
                        style={{ color: 'inherit', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <IconDownload /> 文件{i + 1}
                      </a>
                    </Tag>
                  )
                })}
              </Space>
            ) : '-' },
            { label: '错误信息', value: taskDetail.error_message || '-' },
            { label: '创建时间', value: taskDetail.created_at ? new Date(taskDetail.created_at).toLocaleString('zh-CN') : '-' },
            { label: '开始时间', value: taskDetail.started_at ? new Date(taskDetail.started_at).toLocaleString('zh-CN') : '-' },
            { label: '完成时间', value: taskDetail.completed_at ? new Date(taskDetail.completed_at).toLocaleString('zh-CN') : '-' },
            { label: '完整参数', value: <pre style={{ maxHeight: 150, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(taskDetail.input_data, null, 2)}</pre> },
          ]} />
        )}
      </Drawer>

      {/* 任务输出文件在线预览（图片/视频/音频） */}
      <Modal
        title="输出预览"
        visible={!!previewMedia}
        onCancel={() => setPreviewMedia(null)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw' }}
      >
        {(() => {
          if (!previewMedia) return null
          const { kind, url } = previewMedia
          if (kind === 'image') {
            return <img src={url} alt="预览"
              style={{ maxWidth: '85vw', maxHeight: '78vh', display: 'block', margin: '0 auto', objectFit: 'contain' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          }
          if (kind === 'video') {
            return <video src={url} controls autoPlay
              style={{ maxWidth: '85vw', maxHeight: '78vh', display: 'block', margin: '0 auto' }} />
          }
          return (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <IconSound style={{ fontSize: 48, color: 'rgb(var(--primary-6))' }} />
              <audio src={url} controls autoPlay
                style={{ width: '100%', maxWidth: 480, display: 'block', margin: '16px auto 0' }} />
            </div>
          )
        })()}
      </Modal>
    </div>
  )
}

export default AdminDashboardPage
