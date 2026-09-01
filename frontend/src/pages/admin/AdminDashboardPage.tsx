/**
 * AdminDashboardPage - 后台管理
 *
 * 功能：平台统计、用户管理、任务监控
 */
import React, { useEffect, useRef, useState } from 'react'
import { Card, Spin, Typography, Grid, Statistic, Table, Tag, Space, Button, Message, Popconfirm, Tabs, Empty, Form, Input, Modal, Drawer, Descriptions, Select, Collapse, Tooltip, Progress } from '@arco-design/web-react'
import { IconUser, IconUserGroup, IconFile, IconApps, IconVideoCamera, IconPlus, IconDelete, IconEdit, IconLock, IconEye, IconClose, IconStop, IconRefresh, IconImage, IconPlayCircle, IconSound, IconDownload, IconCheckCircle, IconGift, IconStorage, IconThunderbolt, IconFolder, IconClockCircle } from '@arco-design/web-react/icon'
import { useLocation, useNavigate } from 'react-router-dom'
import DailyBars from '@/components/charts/DailyBars'
import { adminService, taskService } from '@/api/services'
import { PROJECT_STATUS, TASK_STATUS, statusColor, statusLabel } from '@/utils/statusLabels'
import { renderPromptText } from '@/utils/prompt'
import HighlightPrompt from '@/components/editor/HighlightPrompt'

const { Title, Text } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

/** 任务类型 → 中文 */
const TASK_TYPE_LABEL: Record<string, string> = {
  video: '视频', image: '图片', audio: '音频', script_parse: '剧本解析',
  remove_subtitle: '去字幕', subtitle: '字幕', script_upload: '剧本导入', video_edit: '视频剪辑',
}

/** 任务状态 → 颜色/标签 */
const STATUS_META: Record<string, { label: string; color: string; bar: string }> = {
  completed: { label: '已完成', color: 'green', bar: 'rgb(var(--green-6))' },
  processing: { label: '处理中', color: 'arcoblue', bar: 'rgb(var(--arcoblue-6))' },
  pending: { label: '等待中', color: 'gray', bar: 'rgb(var(--gray-5))' },
  failed: { label: '失败', color: 'red', bar: 'rgb(var(--danger-6))' },
  cancelled: { label: '已取消', color: 'orange', bar: 'rgb(var(--orange-5))' },
}

/** 统计卡（支持底部次行说明，如"今日 +N"） */
const StatCard = ({ title, value, icon, sub, onClick }: {
  title: string; value: React.ReactNode; icon?: React.ReactNode; sub?: React.ReactNode; onClick?: () => void
}) => (
  <Card style={{ marginBottom: 16, cursor: onClick ? 'pointer' : 'default' }} onClick={onClick}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {icon}
      <Text type="secondary" style={{ fontSize: 13 }}>{title}</Text>
    </div>
    <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8, lineHeight: 1.2 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{sub}</div>}
  </Card>
)

/** 模型使用排行：横向条 */
const ModelBars = ({ models }: { models?: { model: string; count: number }[] }) => {
  const list = (models || []).filter((m) => m.count > 0)
  const max = Math.max(1, ...list.map((m) => m.count))
  if (!list.length) return <Empty description="暂无模型调用" />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {list.map((m) => (
        <div key={m.model} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Text style={{ width: 170, fontSize: 12, flexShrink: 0 }} ellipsis>{m.model}</Text>
          <div style={{ flex: 1, height: 12, background: 'var(--color-fill-2)', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ width: `${(m.count / max) * 100}%`, height: '100%', borderRadius: 6, background: 'linear-gradient(90deg, rgb(var(--arcoblue-5)), rgb(var(--arcoblue-6)))' }} />
          </div>
          <Text type="secondary" style={{ fontSize: 12, width: 44, textAlign: 'right', flexShrink: 0 }}>{m.count}</Text>
        </div>
      ))}
    </div>
  )
}

/** 任务状态分布：堆叠彩条 + 图例 */
const StatusStack = ({ byStatus }: { byStatus?: Record<string, number> }) => {
  const entries = Object.entries(byStatus || {}).filter(([k, v]) => v > 0 && STATUS_META[k])
  const total = entries.reduce((s, [, v]) => s + v, 0)
  if (!total) return <Empty description="暂无任务" />
  return (
    <div>
      <div style={{ display: 'flex', height: 18, borderRadius: 9, overflow: 'hidden', background: 'var(--color-fill-2)' }}>
        {entries.map(([k, v]) => (
          <Tooltip key={k} content={`${STATUS_META[k].label}：${v}（${((v / total) * 100).toFixed(1)}%）`}>
            <div style={{ width: `${(v / total) * 100}%`, height: '100%', background: STATUS_META[k].bar }} />
          </Tooltip>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
        {entries.map(([k, v]) => (
          <Space key={k} size={6}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: STATUS_META[k].bar, display: 'inline-block' }} />
            <Text style={{ fontSize: 12 }}>{STATUS_META[k].label}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{v}（{((v / total) * 100).toFixed(1)}%）</Text>
          </Space>
        ))}
      </div>
    </div>
  )
}

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
  const navigate = useNavigate()
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
  const [taskType, setTaskType] = useState<string | undefined>(undefined)
  const [taskSearch, setTaskSearch] = useState('')
  const [taskSummary, setTaskSummary] = useState<any>(null)
  const [selectedTaskKeys, setSelectedTaskKeys] = useState<string[]>([])
  // 用户管理：服务端分页 + 筛选/排序 + 汇总卡（后端 {items,total,summary}）
  const [userPage, setUserPage] = useState(1)
  const [userPageSize, setUserPageSize] = useState(20)
  const [userTotal, setUserTotal] = useState(0)
  const [userSummary, setUserSummary] = useState<any>(null)
  const [userSearch, setUserSearch] = useState('')
  const [userRole, setUserRole] = useState<string | undefined>(undefined)
  const [userStatus, setUserStatus] = useState<string | undefined>(undefined)
  const [userSort, setUserSort] = useState('created_at')
  const [selectedUserKeys, setSelectedUserKeys] = useState<string[]>([])
  // 项目管理：服务端分页 + 筛选/排序 + 汇总卡
  const [projPage, setProjPage] = useState(1)
  const [projPageSize, setProjPageSize] = useState(20)
  const [projTotal, setProjTotal] = useState(0)
  const [projSummary, setProjSummary] = useState<any>(null)
  const [projSearch, setProjSearch] = useState('')
  const [projStatus, setProjStatus] = useState<string | undefined>(undefined)
  const [projSort, setProjSort] = useState('updated_at')

  // 根据 URL 决定 activeTab（Tab ↔ 路由双向同步，可直接分享/收藏子页地址）
  const pathTabMap: Record<string, string> = {
    '/admin': 'overview',
    '/admin/users': 'users',
    '/admin/projects': 'projects',
    '/admin/tasks': 'tasks',
  }
  const tabPathMap: Record<string, string> = {
    overview: '/admin',
    users: '/admin/users',
    projects: '/admin/projects',
    tasks: '/admin/tasks',
  }
  const activeTab = pathTabMap[location.pathname] || 'overview'

  // ---- 分 Tab 懒加载：进入哪个 Tab 才拉哪类数据（此前一次性拉全量四类） ----
  const loadStats = async () => {
    try { setStats(await adminService.stats()) } catch { /* 拦截器提示 */ }
  }
  const loadUsers = async (opts?: { page?: number; pageSize?: number; search?: string; role?: string; status?: string; sort?: string }) => {
    try {
      const d: any = await adminService.users({
        page: opts?.page ?? userPage,
        page_size: opts?.pageSize ?? userPageSize,
        search: (opts?.search !== undefined ? opts.search : userSearch) || undefined,
        role: opts?.role !== undefined ? opts.role : userRole,
        status: opts?.status !== undefined ? opts.status : userStatus,
        sort: opts?.sort ?? userSort,
      })
      setUsers(Array.isArray(d?.items) ? d.items : [])
      setUserTotal(typeof d?.total === 'number' ? d.total : 0)
      setUserSummary(d?.summary ?? null)
    } catch { /* 拦截器提示 */ }
  }
  const loadedTabs = useRef<Set<string>>(new Set())
  useEffect(() => {
    const tab = activeTab
    if (loadedTabs.current.has(tab)) return
    loadedTabs.current.add(tab)
    if (tab === 'overview') {
      loadStats().finally(() => setLoading(false))
    } else {
      setLoading(false)  // 非 overview 直达时也要解除全页 spinner（否则永远转圈）
      if (tab === 'users') loadUsers()
      else if (tab === 'projects') loadAdminProjects()
      else loadAdminTasks({ page: 1 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  const handleToggleStatus = async (userId: string) => {
    await adminService.toggleStatus(userId)
    Message.success('状态已切换')
    loadUsers()
  }

  const handleRoleChange = async (userId: string, role: string) => {
    await adminService.updateRole(userId, role)
    Message.success('角色已更新')
    loadUsers()
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
      setEditUserTarget(null); loadUsers()
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
      const res: any = await adminService.userDetail(row.id)
      setUserDetail(res)
      setUserDetailVisible(true)
    } catch { setUserDetail(row); setUserDetailVisible(true) }
  }

  // 批量启用/禁用选中用户
  const handleBatchUserStatus = async (active: boolean) => {
    if (!selectedUserKeys.length) return
    try {
      const res: any = await adminService.batchUserStatus(selectedUserKeys, active)
      Message.success(res?.message || '操作成功')
      setSelectedUserKeys([])
      loadUsers()
    } catch { Message.error('批量操作失败') }
  }

  // 导出当前筛选下的用户 CSV（一次性拉 1000 条在浏览器侧生成）
  const handleExportUsers = async () => {
    try {
      const d: any = await adminService.users({
        page: 1, page_size: 1000,
        search: userSearch || undefined, role: userRole, status: userStatus, sort: userSort,
      })
      const rows: any[] = Array.isArray(d?.items) ? d.items : []
      if (!rows.length) { Message.warning('当前筛选无用户可导出'); return }
      const header = ['邮箱', '昵称', '角色', '状态', '项目数', '任务数', '积分消耗', '最近活跃', '注册时间']
      const lines = rows.map((u: any) => [
        u.email, u.nickname || '', u.role === 'admin' ? '管理员' : '普通用户',
        u.is_active ? '活跃' : '禁用',
        u.project_count ?? 0, u.task_count ?? 0, u.credits_consumed ?? 0,
        u.last_active ? new Date(u.last_active).toLocaleString('zh-CN') : '-',
        u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '-',
      ])
      // BOM 保证 Excel 中文不乱码
      const csv = '\uFEFF' + [header, ...lines].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `用户列表_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(a.href)
      Message.success(`已导出 ${rows.length} 个用户`)
    } catch { Message.error('导出失败') }
  }

  const handleAdminDeleteProject = async (id: string) => {
    try {
      await adminService.deleteProject(id)
      Message.success('项目已删除')
      if (projectDetail?.id === id) { setProjectDetailVisible(false); setProjectDetail(null) }
      loadAdminProjects()
    } catch { Message.error('删除失败') }
  }

  // 项目富详情抽屉（内容规模/任务统计/成员/最近任务）
  const [projectDetail, setProjectDetail] = useState<any>(null)
  const [projectDetailVisible, setProjectDetailVisible] = useState(false)
  const openProjectDetail = async (row: any) => {
    setProjectDetail(row)  // 先展示列表行数据占位
    setProjectDetailVisible(true)
    try {
      const res: any = await adminService.projectDetail(row.id)
      setProjectDetail(res)
    } catch { /* 占位数据兜底 */ }
  }

  const handleCancelTask = async (id: string) => {
    try {
      await taskService.cancel(id)
      Message.success('任务已取消')
      loadAdminTasks()
    } catch { Message.error('取消失败') }
  }

  // 删除任务记录（关联的积分流水会自动解除关联并保留，仅清掉任务本身）
  const handleDeleteTask = async (id: string) => {
    try {
      await taskService.delete(id)
      Message.success('删除成功')
      loadAdminTasks()
    } catch { Message.error('删除失败') }
  }

  // 批量删除勾选的任务
  const handleBatchDeleteTasks = async () => {
    if (!selectedTaskKeys.length) return
    try {
      const res: any = await adminService.batchDeleteTasks(selectedTaskKeys)
      const n = res?.deleted_count ?? selectedTaskKeys.length
      Message.success(`已删除 ${n} 条任务`)
      setSelectedTaskKeys([])
      loadAdminTasks()
    } catch { Message.error('批量删除失败') }
  }

  const handleCancelAllPending = async () => {
    try {
      await adminService.cancelAllPending()
      Message.success('已取消所有待处理任务')
      loadAdminTasks()
    } catch { Message.error('操作失败') }
  }

  // 按条件重新加载项目（服务端分页 + 筛选/排序）
  const loadAdminProjects = async (opts?: { page?: number; pageSize?: number; search?: string; status?: string; sort?: string }) => {
    try {
      const d: any = await adminService.projects({
        page: opts?.page ?? projPage,
        page_size: opts?.pageSize ?? projPageSize,
        search: (opts?.search !== undefined ? opts.search : projSearch) || undefined,
        status: opts?.status !== undefined ? opts.status : projStatus,
        sort: opts?.sort ?? projSort,
      })
      setProjects(Array.isArray(d?.items) ? d.items : [])
      setProjTotal(typeof d?.total === 'number' ? d.total : 0)
      setProjSummary(d?.summary ?? null)
    } catch { /* ignore */ }
  }

  // 按状态/类型/搜索/页码重新加载任务（后端分页）
  const loadAdminTasks = async (opts?: { page?: number; pageSize?: number; status?: string; type?: string; search?: string }) => {
    try {
      const page = opts?.page ?? taskPage
      const pageSize = opts?.pageSize ?? taskPageSize
      const status = opts?.status !== undefined ? opts.status : taskStatus
      const type = opts?.type !== undefined ? opts.type : taskType
      const search = (opts?.search !== undefined ? opts.search : taskSearch) || undefined
      const data: any = await adminService.tasks({ page, page_size: pageSize, status, type, search })
      setTasks(Array.isArray(data?.items) ? data.items : [])
      setTaskTotal(typeof data?.total === 'number' ? data.total : 0)
      setTaskSummary(data?.summary ?? null)
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
      loadUsers()
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
      loadUsers()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} tip="加载中..." /></div>

  const userColumns = [
    { title: '邮箱', dataIndex: 'email', width: 190, ellipsis: true },
    { title: '手机号', dataIndex: 'phone', width: 125, render: (v: string) => v ? <Text copyable={{ text: v }} style={{ fontSize: 13 }}>{v}</Text> : <Text type="secondary">-</Text> },
    { title: '昵称', dataIndex: 'nickname', width: 110, ellipsis: true },
    { title: '角色', dataIndex: 'role', width: 90, render: (v: string) => <Tag color={v === 'admin' ? 'red' : 'blue'}>{v === 'admin' ? '管理员' : '普通用户'}</Tag> },
    { title: '状态', dataIndex: 'is_active', width: 76, render: (v: boolean) => <Tag color={v ? 'green' : 'gray'}>{v ? '活跃' : '禁用'}</Tag> },
    { title: '项目', dataIndex: 'project_count', width: 70, sorter: false, render: (v: number) => <Text>{v ?? 0}</Text> },
    { title: '任务', dataIndex: 'task_count', width: 70, render: (v: number) => <Text>{v ?? 0}</Text> },
    { title: '积分消耗', dataIndex: 'credits_consumed', width: 90, render: (v: number) => <Text type={v ? 'warning' : undefined}>{v ?? 0}</Text> },
    {
      title: '最近活跃', dataIndex: 'last_active', width: 150,
      render: (v: string) => v ? <Text style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: '注册时间', dataIndex: 'created_at', width: 150,
      render: (v: string) => v ? <Text style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text> : '-',
    },
    { title: '操作', width: 330, fixed: 'right' as const, render: (_: any, row: any) => (
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
      const colorMap: Record<string, string> = {
        video: 'green', image: 'arcoblue', audio: 'purple', script_parse: 'magenta',
        remove_subtitle: 'orange', subtitle: 'blue', script_upload: 'gray', video_edit: 'cyan',
      }
      return <Tag color={colorMap[v] || 'gray'}>{TASK_TYPE_LABEL[v] || v}</Tag>
    } },
    { title: '项目', dataIndex: 'project_name', width: 120, ellipsis: true, render: (v: string) => <Text style={{ fontSize: 13 }}>{v || '-'}</Text> },
    { title: '创建人', dataIndex: 'user_name', width: 110, ellipsis: true, render: (v: string) => <Text style={{ fontSize: 13 }}>{v || '-'}</Text> },
    {
      title: '剧本/集/分镜', width: 170, ellipsis: true,
      render: (_: any, row: any) => {
        const parts = [
          row.script_title,
          row.episode_number != null ? `第${row.episode_number}集` : null,
          row.scene_sequence != null ? `#${row.scene_sequence}` : null,
        ].filter(Boolean)
        return parts.length ? <Text style={{ fontSize: 12 }}>{parts.join(' / ')}</Text> : <Text type="secondary">-</Text>
      },
    },
    {
      // 模型名可能很长（如 DiffSynth-Studio/MiniMax-H3），用 Tag 显示并支持悬停看全名
      title: '模型', dataIndex: 'model', width: 170, ellipsis: true,
      render: (v: string) => v
        ? <Tag size="small" color="arcoblue" style={{ maxWidth: '100%' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span></Tag>
        : '-',
    },
    {
      // 提示词：交给 Arco ellipsis 按列宽自适应截断（ellipsis:true 自带 Tooltip 悬停看全文），
      // 不再用 truncatePromptText 硬截断到 40 字 —— 列宽足够时能显示更多内容
      title: '提示词', dataIndex: 'prompt', ellipsis: true, render: (_: any, row: any) => {
        const p = row.input_data?.prompt || row.input_data?.resource_name || ''
        return p ? renderPromptText(p) : '-'
      },
    },
    { title: '状态', dataIndex: 'status', width: 110, render: (v: string, row: any) => (
      <Space size={4} wrap>
        <Tag color={statusColor(v, TASK_STATUS)}>{statusLabel(v, TASK_STATUS)}</Tag>
        {row.deleted_at && <Tag color="red">已删除</Tag>}
      </Space>
    ) },
    { title: '进度', dataIndex: 'progress', width: 70, render: (v: number) => `${v || 0}%` },
    { title: '积分', dataIndex: 'credits_consumed', width: 60, render: (v: number) => v ? <Text type="warning">{v}</Text> : '-' },
    { title: '创建时间', dataIndex: 'created_at', width: 140, render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text> : '-' },
    { title: '操作', width: 130, fixed: 'right' as const, render: (_: any, row: any) => (
      <Space size={4}>
        <Button size="mini" type="text" icon={<IconEye />} onClick={() => openTaskDetail(row)} title="查看详情" />
        {['pending', 'processing'].includes(row.status) && (
          <Popconfirm title="确认取消该任务？" onOk={() => handleCancelTask(row.id)}>
            <Button size="mini" type="text" status="warning" icon={<IconStop />} title="取消任务" />
          </Popconfirm>
        )}
        <Popconfirm title="确认删除该任务记录？删除后不可恢复（积分流水会保留，仅解除关联）" onOk={() => handleDeleteTask(row.id)}>
          <Button size="mini" type="text" status="danger" icon={<IconDelete />} title="删除记录" />
        </Popconfirm>
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
    { title: '画布', dataIndex: 'canvas_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="gray">{v || 0}</Tag> },
    { title: '任务数', dataIndex: 'task_count', width: 70, align: 'center' as const, render: (v: number) => <Tag color="arcoblue">{v || 0}</Tag> },
    { title: '成功率', dataIndex: 'success_rate', width: 80, align: 'center' as const, render: (v: number | null) => v != null ? <Text style={{ color: v >= 80 ? 'rgb(var(--green-6))' : v >= 50 ? 'rgb(var(--orange-6))' : 'rgb(var(--red-6))' }}>{v}%</Text> : <Text type="secondary">-</Text> },
    { title: '消耗积分', dataIndex: 'credits_used', width: 90, align: 'center' as const, render: (v: number) => v ? <Text type="warning">{v}</Text> : '-' },
    { title: '状态', dataIndex: 'status', width: 90, align: 'center' as const, render: (v: string) => (
      <Tag color={statusColor(v, PROJECT_STATUS)}>{statusLabel(v, PROJECT_STATUS)}</Tag>
    )},
    { title: '最近更新', dataIndex: 'updated_at', width: 140, render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text> : '-' },
    { title: '操作', width: 120, fixed: 'right' as const, render: (_: any, row: any) => (
      <Space size="small">
        <Button size="mini" icon={<IconEye />} onClick={() => openProjectDetail(row)}>详情</Button>
        <Popconfirm title="确认删除该项目？此操作不可恢复" onOk={() => handleAdminDeleteProject(row.id)}>
          <Button size="mini" status="danger" icon={<IconDelete />} />
        </Popconfirm>
      </Space>
    )},
  ]

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>后台管理</Title>
      <Tabs activeTab={activeTab} onChange={(k) => navigate(tabPathMap[k] || '/admin')}>
        {/* 概览 */}
        <TabPane key="overview" title="平台概览">
          {/* 第一排：核心总量 + 成功率 */}
          <Row gutter={16}>
            <Col span={6}>
              <StatCard title="总用户数" value={stats?.total_users ?? 0} sub={`今日新增 ${stats?.new_users_today ?? 0}`}
                icon={<IconUserGroup style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />}
                onClick={() => navigate('/admin/users')} />
            </Col>
            <Col span={6}>
              <StatCard title="总项目数" value={stats?.total_projects ?? 0} sub={`今日活跃用户 ${stats?.active_users_today ?? 0}`}
                icon={<IconFile style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />} />
            </Col>
            <Col span={6}>
              <StatCard title="总任务数" value={stats?.total_tasks ?? 0} sub={`今日新增 ${stats?.new_tasks_today ?? 0}`}
                icon={<IconApps style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />}
                onClick={() => navigate('/admin/tasks')} />
            </Col>
            <Col span={6}>
              <StatCard title="任务成功率" value={stats?.task_success_rate != null ? `${stats.task_success_rate}%` : '-'}
                sub={stats?.task_success_rate != null
                  ? `完成 ${stats.tasks_by_status?.completed ?? 0} / 失败 ${stats.tasks_by_status?.failed ?? 0}`
                  : '暂无已完成/失败样本'}
                icon={<IconCheckCircle style={{ fontSize: 22, color: 'rgb(var(--success-6))' }} />} />
            </Col>
          </Row>

          {/* 第二排：积分与存储 */}
          <Row gutter={16}>
            <Col span={6}>
              <StatCard title="积分余额合计" value={stats?.total_credits_balance ?? 0} sub="全部团队账户余额总和"
                icon={<IconGift style={{ fontSize: 22, color: 'rgb(var(--gold-6))' }} />}
                onClick={() => navigate('/admin/credits')} />
            </Col>
            <Col span={6}>
              <StatCard title="累计消耗积分" value={stats?.total_credits_consumed ?? 0} sub={`今日消耗 ${stats?.credits_consumed_today ?? 0}`}
                icon={<IconGift style={{ fontSize: 22, color: 'rgb(var(--purple-6))' }} />} />
            </Col>
            <Col span={6}>
              <StatCard title="本地存储占用" value={`${stats?.storage_used ?? 0} GB`} sub="生成产物落盘合计"
                icon={<IconVideoCamera style={{ fontSize: 22, color: 'rgb(var(--cyan-6))' }} />} />
            </Col>
            <Col span={6}>
              <StatCard title="运行模型数" value={(stats?.popular_models || []).length}
                sub="近 7 日有调用的模型见下方排行"
                icon={<IconStorage style={{ fontSize: 22, color: 'rgb(var(--teal-6))' }} />}
                onClick={() => navigate('/admin/models')} />
            </Col>
          </Row>

          {/* 第三排：近 7 日趋势 + 模型排行 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={14}>
              <Card title="近 7 日任务趋势" style={{ height: '100%' }}
                extra={<Space size={12}>
                  <Space size={4}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'rgb(var(--arcoblue-5))', display: 'inline-block' }} /><Text type="secondary" style={{ fontSize: 12 }}>总量</Text></Space>
                  <Space size={4}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'rgb(var(--danger-6))', display: 'inline-block' }} /><Text type="secondary" style={{ fontSize: 12 }}>失败</Text></Space>
                </Space>}>
                <DailyBars data={stats?.tasks_daily} />
              </Card>
            </Col>
            <Col span={10}>
              <Card title="模型使用排行 Top 6" style={{ height: '100%' }}>
                <ModelBars models={stats?.popular_models} />
              </Card>
            </Col>
          </Row>

          {/* 第四排：状态分布 + 类型分布 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={12}>
              <Card title="任务状态分布" style={{ height: '100%' }}>
                <StatusStack byStatus={stats?.tasks_by_status} />
              </Card>
            </Col>
            <Col span={12}>
              <Card title="任务类型分布" style={{ height: '100%' }}>
                {Object.keys(stats?.tasks_by_type || {}).length
                  ? (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {Object.entries(stats.tasks_by_type).sort((a: any, b: any) => b[1] - a[1]).map(([k, v]: any) => (
                        <Tooltip key={k} content={`${TASK_TYPE_LABEL[k] || k}：${v}`}>
                          <Tag color="arcoblue" size="large">{TASK_TYPE_LABEL[k] || k} {v}</Tag>
                        </Tooltip>
                      ))}
                    </div>
                  )
                  : <Empty description="暂无任务" />}
              </Card>
            </Col>
          </Row>

          {/* 第五排：最近失败任务 */}
          <Card
            title="最近失败任务"
            extra={<Button size="small" onClick={() => {
              setTaskStatus('failed')
              loadedTabs.current.add('tasks')
              loadAdminTasks({ status: 'failed', page: 1 })
              navigate('/admin/tasks')
            }}>查看全部失败任务</Button>}
          >
            {(stats?.recent_failed_tasks || []).length
              ? (
                <Table size="small" rowKey="id" pagination={false} data={stats.recent_failed_tasks} columns={[
                  {
                    title: '时间', dataIndex: 'created_at', width: 150,
                    render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v ? new Date(v).toLocaleString('zh-CN') : '-'}</Text>,
                  },
                  {
                    title: '类型', dataIndex: 'type', width: 100,
                    render: (v: string) => <Tag color="arcoblue">{TASK_TYPE_LABEL[v] || v}</Tag>,
                  },
                  {
                    title: '模型', dataIndex: 'model', width: 180, ellipsis: true,
                    render: (v: string) => v ? <Tag size="small">{v}</Tag> : '-',
                  },
                  {
                    title: '错误信息', dataIndex: 'error', ellipsis: true,
                    render: (v: string) => <Text type="error" style={{ fontSize: 12 }}>{v || '-'}</Text>,
                  },
                ]} />
              )
              : <Empty description="没有失败任务 🎉" />}
          </Card>
        </TabPane>

        {/* 用户管理 */}
        <TabPane key="users" title="用户管理">
          {/* 汇总统计卡（后端全量口径） */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}><StatCard title="总用户数" value={userSummary?.total ?? '-'} icon={<IconUserGroup style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />} /></Col>
            <Col span={6}><StatCard title="今日新增" value={userSummary?.today_new ?? '-'} icon={<IconPlus style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />} /></Col>
            <Col span={6}><StatCard title="7 日活跃" value={userSummary?.active_7d ?? '-'} icon={<IconThunderbolt style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />} sub="提交过任务的用户" /></Col>
            <Col span={6}><StatCard title="管理员" value={userSummary?.admin_count ?? '-'} icon={<IconUser style={{ fontSize: 22, color: 'rgb(var(--red-6))' }} />} /></Col>
          </Row>

          {/* 工具栏：搜索/筛选/排序 + 批量操作 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
            <Space size={8} wrap>
              <Input.Search
                placeholder="搜索邮箱 / 昵称"
                style={{ width: 200 }}
                value={userSearch}
                onChange={setUserSearch}
                allowClear
                onSearch={(v) => { setUserPage(1); loadUsers({ search: v, page: 1 }) }}
                onClear={() => { setUserSearch(''); setUserPage(1); loadUsers({ search: '', page: 1 }) }}
              />
              <Select
                placeholder="角色"
                style={{ width: 110 }}
                allowClear
                value={userRole}
                onChange={(v) => { setUserRole(v); setUserPage(1); loadUsers({ role: v, page: 1 }) }}
              >
                <Select.Option value="admin">管理员</Select.Option>
                <Select.Option value="user">普通用户</Select.Option>
              </Select>
              <Select
                placeholder="状态"
                style={{ width: 100 }}
                allowClear
                value={userStatus}
                onChange={(v) => { setUserStatus(v); setUserPage(1); loadUsers({ status: v, page: 1 }) }}
              >
                <Select.Option value="active">活跃</Select.Option>
                <Select.Option value="inactive">禁用</Select.Option>
              </Select>
              <Select
                placeholder="排序"
                style={{ width: 130 }}
                value={userSort}
                onChange={(v) => { setUserSort(v); setUserPage(1); loadUsers({ sort: v, page: 1 }) }}
              >
                <Select.Option value="created_at">按注册时间</Select.Option>
                <Select.Option value="task_count">按任务数</Select.Option>
                <Select.Option value="credits_consumed">按积分消耗</Select.Option>
                <Select.Option value="project_count">按项目数</Select.Option>
              </Select>
            </Space>
            <Space size={8}>
              <Popconfirm
                title={`确认批量禁用选中的 ${selectedUserKeys.length} 个用户？禁用后无法登录`}
                disabled={!selectedUserKeys.length}
                onOk={() => handleBatchUserStatus(false)}
              >
                <Button status="warning" disabled={!selectedUserKeys.length}>
                  批量禁用{selectedUserKeys.length ? `(${selectedUserKeys.length})` : ''}
                </Button>
              </Popconfirm>
              <Popconfirm
                title={`确认批量启用选中的 ${selectedUserKeys.length} 个用户？`}
                disabled={!selectedUserKeys.length}
                onOk={() => handleBatchUserStatus(true)}
              >
                <Button status="success" disabled={!selectedUserKeys.length}>
                  批量启用{selectedUserKeys.length ? `(${selectedUserKeys.length})` : ''}
                </Button>
              </Popconfirm>
              <Button icon={<IconDownload />} onClick={handleExportUsers}>导出 CSV</Button>
              <Button type="primary" icon={<IconPlus />} onClick={() => setCreateUserVisible(true)}>新建用户</Button>
            </Space>
          </div>
          <Card>
            <Table
              columns={userColumns}
              data={users}
              rowKey="id"
              scroll={{ x: 1350 }}
              rowSelection={{
                selectedRowKeys: selectedUserKeys,
                onChange: (keys: (string | number)[]) => setSelectedUserKeys(keys.map(String)),
              }}
              pagination={{
                current: userPage,
                pageSize: userPageSize,
                total: userTotal,
                showTotal: true,
                showJumper: true,
                sizeCanChange: true,
                sizeOptions: [10, 20, 50],
                onChange: (page: number, pageSize?: number) => {
                  setUserPage(page)
                  if (pageSize && pageSize !== userPageSize) setUserPageSize(pageSize)
                  loadUsers({ page, pageSize: pageSize || userPageSize })
                },
              }}
            />
          </Card>
        </TabPane>

        {/* 项目监控 */}
        <TabPane key="projects" title="项目监控">
          {/* 汇总统计卡（后端全量口径） */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}><StatCard title="总项目数" value={projSummary?.total ?? '-'} icon={<IconFolder style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />} /></Col>
            <Col span={6}><StatCard title="7 日活跃" value={projSummary?.active_7d ?? '-'} icon={<IconThunderbolt style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />} sub="近 7 天有更新" /></Col>
            <Col span={6}><StatCard title="制作中" value={projSummary?.producing ?? '-'} icon={<IconVideoCamera style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />} /></Col>
            <Col span={6}><StatCard title="已归档" value={projSummary?.archived ?? '-'} icon={<IconStorage style={{ fontSize: 22, color: 'var(--color-text-3)' }} />} /></Col>
          </Row>

          {/* 工具栏：搜索/状态/排序 + 刷新 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
            <Space size={8} wrap>
              <Input.Search
                placeholder="搜索项目名"
                style={{ width: 200 }}
                value={projSearch}
                onChange={setProjSearch}
                allowClear
                onSearch={(v) => { setProjPage(1); loadAdminProjects({ search: v, page: 1 }) }}
                onClear={() => { setProjSearch(''); setProjPage(1); loadAdminProjects({ search: '', page: 1 }) }}
              />
              <Select
                placeholder="按状态筛选"
                style={{ width: 120 }}
                allowClear
                value={projStatus}
                onChange={(v) => { setProjStatus(v); setProjPage(1); loadAdminProjects({ status: v, page: 1 }) }}
              >
                <Select.Option value="draft">草稿</Select.Option>
                <Select.Option value="producing">制作中</Select.Option>
                <Select.Option value="completed">已完成</Select.Option>
                <Select.Option value="archived">已归档</Select.Option>
              </Select>
              <Select
                placeholder="排序"
                style={{ width: 130 }}
                value={projSort}
                onChange={(v) => { setProjSort(v); setProjPage(1); loadAdminProjects({ sort: v, page: 1 }) }}
              >
                <Select.Option value="updated_at">按最近更新</Select.Option>
                <Select.Option value="created_at">按创建时间</Select.Option>
                <Select.Option value="task_count">按任务数</Select.Option>
                <Select.Option value="scene_count">按分镜数</Select.Option>
                <Select.Option value="credits_used">按积分消耗</Select.Option>
              </Select>
            </Space>
            <Button icon={<IconRefresh />} onClick={() => loadAdminProjects({ page: projPage })}>刷新</Button>
          </div>
          <Card>
            <Table
              columns={projectColumns}
              data={projects}
              rowKey="id"
              size="small"
              scroll={{ x: 1600 }}
              pagination={{
                current: projPage,
                pageSize: projPageSize,
                total: projTotal,
                showTotal: true,
                showJumper: true,
                sizeCanChange: true,
                sizeOptions: [10, 20, 50],
                onChange: (page: number, pageSize?: number) => {
                  setProjPage(page)
                  if (pageSize && pageSize !== projPageSize) setProjPageSize(pageSize)
                  loadAdminProjects({ page, pageSize: pageSize || projPageSize })
                },
              }}
            />
          </Card>
        </TabPane>

        {/* 任务监控 */}
        <TabPane key="tasks" title="任务监控">
          {/* 汇总统计卡（后端全量口径） */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}><StatCard title="总任务数" value={taskSummary?.total ?? '-'} icon={<IconApps style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />} /></Col>
            <Col span={6}><StatCard title="今日新增" value={taskSummary?.today_new ?? '-'} icon={<IconPlus style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />} /></Col>
            <Col span={6}><StatCard title="进行中" value={taskSummary?.running ?? '-'} icon={<IconClockCircle style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />} sub="等待 + 处理中" /></Col>
            <Col span={6}><StatCard title="今日失败" value={taskSummary?.today_failed ?? '-'} icon={<IconClose style={{ fontSize: 22, color: 'rgb(var(--red-6))' }} />} /></Col>
          </Row>

          {/* 工具栏：搜索/类型/状态筛选 + 危险操作 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
            <Space size={8} wrap>
              <Input.Search
                placeholder="搜索模型名 / 提示词"
                style={{ width: 220 }}
                value={taskSearch}
                onChange={setTaskSearch}
                allowClear
                onSearch={(v) => { setTaskPage(1); loadAdminTasks({ search: v, page: 1 }) }}
                onClear={() => { setTaskSearch(''); setTaskPage(1); loadAdminTasks({ search: '', page: 1 }) }}
              />
              <Select
                placeholder="按类型筛选"
                style={{ width: 120 }}
                allowClear
                value={taskType}
                onChange={(v) => { setTaskType(v); setTaskPage(1); loadAdminTasks({ type: v, page: 1 }) }}
              >
                <Select.Option value="video">视频</Select.Option>
                <Select.Option value="image">图片</Select.Option>
                <Select.Option value="audio">音频</Select.Option>
                <Select.Option value="script_parse">剧本解析</Select.Option>
                <Select.Option value="script_upload">剧本导入</Select.Option>
                <Select.Option value="video_edit">视频剪辑</Select.Option>
                <Select.Option value="remove_subtitle">去字幕</Select.Option>
                <Select.Option value="subtitle">字幕</Select.Option>
              </Select>
              <Select
                placeholder="按状态筛选"
                style={{ width: 120 }}
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
              <Button icon={<IconRefresh />} onClick={() => loadAdminTasks({ page: taskPage })}>刷新</Button>
            </Space>
            <Space size={8}>
              <Popconfirm title="确认取消所有未完成任务（待处理 + 进行中）？" onOk={() => handleCancelAllPending()}>
                <Button status="warning" icon={<IconStop />}>取消所有未完成</Button>
              </Popconfirm>
              <Popconfirm
                title={`确认批量删除选中的 ${selectedTaskKeys.length} 条任务？删除后不可恢复（积分流水会保留，仅解除关联）`}
                disabled={!selectedTaskKeys.length}
                onOk={() => handleBatchDeleteTasks()}
              >
                <Button status="danger" icon={<IconDelete />} disabled={!selectedTaskKeys.length}>
                  批量删除{selectedTaskKeys.length ? `(${selectedTaskKeys.length})` : ''}
                </Button>
              </Popconfirm>
            </Space>
          </div>
          <Card>
            <Table
              columns={taskColumns}
              data={tasks}
              rowKey="id"
              rowSelection={{
                type: 'checkbox',
                selectedRowKeys: selectedTaskKeys,
                onChange: (keys) => setSelectedTaskKeys(keys.map(String)),
              }}
              size="small"
              scroll={{ x: 1300 }}
              pagination={{
                current: taskPage,
                pageSize: taskPageSize,
                total: taskTotal,
                showTotal: true,
                showJumper: true,
                sizeCanChange: true,
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

      {/* 用户详情抽屉（富详情：统计/团队/最近任务/积分流水） */}
      <Drawer
        title={`用户详情 · ${userDetail?.nickname || userDetail?.email || ''}`} width={560}
        visible={userDetailVisible} onCancel={() => setUserDetailVisible(false)}
        footer={null}
      >
        {userDetail && (
          <>
            <Descriptions column={2} data={[
              { label: '邮箱', value: userDetail.email },
              { label: '手机号', value: userDetail.phone || '-' },
              { label: '昵称', value: userDetail.nickname || '-' },
              { label: '角色', value: <Tag color={userDetail.role === 'admin' ? 'red' : 'blue'}>{userDetail.role === 'admin' ? '管理员' : '普通用户'}</Tag> },
              { label: '状态', value: <Tag color={userDetail.is_active ? 'green' : 'gray'}>{userDetail.is_active ? '活跃' : '禁用'}</Tag> },
              { label: '注册时间', value: userDetail.created_at ? new Date(userDetail.created_at).toLocaleString('zh-CN') : '-', span: 2 },
            ]} />

            {userDetail.stats && (
              <>
                <Title heading={6} style={{ margin: '16px 0 8px' }}>使用统计</Title>
                <Row gutter={8}>
                  <Col span={6}><Statistic title="项目" value={userDetail.stats.project_count ?? 0} styleValue={{ fontSize: 20 }} /></Col>
                  <Col span={6}><Statistic title="分镜" value={userDetail.stats.scene_count ?? 0} styleValue={{ fontSize: 20 }} /></Col>
                  <Col span={6}><Statistic title="任务" value={userDetail.stats.task_total ?? 0} styleValue={{ fontSize: 20 }} /></Col>
                  <Col span={6}><Statistic title="积分消耗" value={userDetail.stats.credits_consumed ?? 0} styleValue={{ fontSize: 20 }} /></Col>
                </Row>
                <Space size={16} style={{ marginTop: 8 }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>成功率：
                    <Text style={{ color: (userDetail.stats.success_rate ?? 0) >= 80 ? 'rgb(var(--green-6))' : 'rgb(var(--orange-6))', fontSize: 13 }}>
                      {userDetail.stats.success_rate != null ? `${userDetail.stats.success_rate}%` : '暂无'}
                    </Text>
                  </Text>
                  <Text type="secondary" style={{ fontSize: 13 }}>失败任务：{userDetail.stats.task_failed ?? 0}</Text>
                </Space>
              </>
            )}

            {Array.isArray(userDetail.orgs) && userDetail.orgs.length > 0 && (
              <>
                <Title heading={6} style={{ margin: '16px 0 8px' }}>所属团队</Title>
                {userDetail.orgs.map((o: any) => (
                  <div key={o.org_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Space size={8}>
                      <Text style={{ fontSize: 13 }}>{o.org_name}</Text>
                      <Tag size="small">{o.is_personal ? '个人' : '团队'}</Tag>
                      <Tag size="small" color="arcoblue">{o.member_role}</Tag>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      余额 {o.balance ?? '-'}{o.quota != null ? ` · 配额 ${o.quota_used}/${o.quota}` : ''}
                    </Text>
                  </div>
                ))}
              </>
            )}

            {Array.isArray(userDetail.recent_tasks) && userDetail.recent_tasks.length > 0 && (
              <>
                <Title heading={6} style={{ margin: '16px 0 8px' }}>最近任务</Title>
                {userDetail.recent_tasks.map((t: any) => (
                  <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Space size={8}>
                      <Tag size="small" color={TASK_TYPE_LABEL[t.type] ? 'arcoblue' : 'gray'}>{TASK_TYPE_LABEL[t.type] || t.type}</Tag>
                      <Tag size="small" color={statusColor(t.status, TASK_STATUS)}>{statusLabel(t.status, TASK_STATUS)}</Tag>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t.credits_consumed ? `${t.credits_consumed}积分 · ` : ''}{t.created_at ? new Date(t.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                    </Text>
                  </div>
                ))}
              </>
            )}

            {Array.isArray(userDetail.recent_transactions) && userDetail.recent_transactions.length > 0 && (
              <>
                <Title heading={6} style={{ margin: '16px 0 8px' }}>积分流水（最近 5 笔）</Title>
                {userDetail.recent_transactions.map((t: any) => (
                  <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Space size={8}>
                      <Tag size="small" color={t.type === 'recharge' ? 'green' : t.type === 'consume' ? 'orange' : t.type === 'refund' ? 'arcoblue' : 'gray'}>
                        {({ recharge: '充值', consume: '消耗', refund: '退款', allocate: '分配', adjust: '调整' } as Record<string, string>)[t.type] || t.type}
                      </Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t.remark || '-'}</Text>
                    </Space>
                    <Text style={{ fontSize: 12, color: t.amount >= 0 ? 'rgb(var(--green-6))' : 'rgb(var(--red-6))' }}>
                      {t.amount >= 0 ? '+' : ''}{t.amount}
                    </Text>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </Drawer>

      {/* 项目富详情抽屉（内容规模/任务统计/成员/最近任务） */}
      <Drawer
        title={`项目详情 · ${projectDetail?.name || ''}`} width={600}
        visible={projectDetailVisible} onCancel={() => setProjectDetailVisible(false)}
        footer={null}
      >
        {projectDetail && (
          <>
            <Descriptions column={2} data={[
              { label: '状态', value: <Tag color={statusColor(projectDetail.status, PROJECT_STATUS)}>{statusLabel(projectDetail.status, PROJECT_STATUS)}</Tag> },
              { label: '所有者', value: projectDetail.owner ? `${projectDetail.owner.nickname || ''} (${projectDetail.owner.email || '-'})` : '-' },
              { label: '创建时间', value: projectDetail.created_at ? new Date(projectDetail.created_at).toLocaleString('zh-CN') : '-' },
              { label: '最近更新', value: projectDetail.updated_at ? new Date(projectDetail.updated_at).toLocaleString('zh-CN') : '-' },
              ...(projectDetail.description ? [{ label: '描述', value: projectDetail.description, span: 2 }] : []),
            ]} />

            {projectDetail.content && (
              <>
                <Title heading={6} style={{ margin: '16px 0 8px' }}>内容规模</Title>
                <Row gutter={8}>
                  <Col span={4}><Statistic title="剧本" value={projectDetail.content.script_count ?? 0} styleValue={{ fontSize: 18 }} /></Col>
                  <Col span={4}><Statistic title="集" value={projectDetail.content.episode_count ?? 0} styleValue={{ fontSize: 18 }} /></Col>
                  <Col span={4}><Statistic title="分镜" value={projectDetail.content.scene_count ?? 0} styleValue={{ fontSize: 18 }} /></Col>
                  <Col span={4}><Statistic title="角色" value={projectDetail.content.character_count ?? 0} styleValue={{ fontSize: 18 }} /></Col>
                  <Col span={4}><Statistic title="场景" value={projectDetail.content.scene_background_count ?? 0} styleValue={{ fontSize: 18 }} /></Col>
                  <Col span={4}><Statistic title="道具" value={projectDetail.content.prop_count ?? 0} styleValue={{ fontSize: 18 }} /></Col>
                </Row>
              </>
            )}

            {projectDetail.tasks && (
              <>
                <Title heading={6} style={{ margin: '16px 0 8px' }}>任务统计</Title>
                <Row gutter={8}>
                  <Col span={6}><Statistic title="总任务" value={projectDetail.tasks.total ?? 0} styleValue={{ fontSize: 18 }} /></Col>
                  <Col span={6}><Statistic title="成功率" value={projectDetail.tasks.success_rate != null ? `${projectDetail.tasks.success_rate}%` : '暂无'} styleValue={{ fontSize: 18 }} /></Col>
                  <Col span={6}><Statistic title="积分消耗" value={projectDetail.tasks.credits_used ?? 0} styleValue={{ fontSize: 18 }} /></Col>
                  <Col span={6}>
                    <Statistic title="进行中" value={(projectDetail.tasks.status_dist?.processing || 0) + (projectDetail.tasks.status_dist?.pending || 0)} styleValue={{ fontSize: 18 }} />
                  </Col>
                </Row>
                {projectDetail.tasks.status_dist && Object.keys(projectDetail.tasks.status_dist).length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <StatusStack byStatus={projectDetail.tasks.status_dist} />
                  </div>
                )}
                {projectDetail.tasks.type_dist && Object.keys(projectDetail.tasks.type_dist).length > 0 && (
                  <Space size={6} wrap style={{ marginTop: 8 }}>
                    {Object.entries(projectDetail.tasks.type_dist).map(([t, c]: any) => (
                      <Tag key={t} size="small">{TASK_TYPE_LABEL[t] || t}: {c}</Tag>
                    ))}
                  </Space>
                )}
              </>
            )}

            {Array.isArray(projectDetail.members) && projectDetail.members.length > 0 && (
              <>
                <Title heading={6} style={{ margin: '16px 0 8px' }}>项目成员</Title>
                {projectDetail.members.map((m: any) => (
                  <div key={m.user_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Text style={{ fontSize: 13 }}>{m.nickname || '-'} <Text type="secondary" style={{ fontSize: 12 }}>({m.email})</Text></Text>
                    <Tag size="small" color={m.role === 'owner' ? 'red' : 'arcoblue'}>{({ owner: '创建者', manager: '管理者', editor: '编辑者', viewer: '查看者' } as Record<string, string>)[m.role] || m.role}</Tag>
                  </div>
                ))}
              </>
            )}

            {Array.isArray(projectDetail.recent_tasks) && projectDetail.recent_tasks.length > 0 && (
              <>
                <Title heading={6} style={{ margin: '16px 0 8px' }}>最近任务</Title>
                {projectDetail.recent_tasks.map((t: any) => (
                  <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Space size={8} style={{ minWidth: 0, overflow: 'hidden' }}>
                      <Tag size="small" color="arcoblue">{TASK_TYPE_LABEL[t.type] || t.type}</Tag>
                      <Tag size="small" color={statusColor(t.status, TASK_STATUS)}>{statusLabel(t.status, TASK_STATUS)}</Tag>
                      {t.error_message && <Tooltip content={t.error_message}><Tag size="small" color="red">失败原因?</Tag></Tooltip>}
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                      {t.credits_consumed ? `${t.credits_consumed}积分 · ` : ''}{t.created_at ? new Date(t.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                    </Text>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </Drawer>

      {/* 任务详情抽屉（重排版：概览双列 + 分区块 + 折叠参数，避免内容挤在单列看不全） */}
      <Drawer
        title={
          <Space size={8}>
            <span>任务详情</span>
            {taskDetail && <Tag color={statusColor(taskDetail.status, TASK_STATUS)}>{statusLabel(taskDetail.status, TASK_STATUS)}</Tag>}
            {taskDetail?.deleted_at && <Tag color="red">已删除</Tag>}
          </Space>
        }
        width={680}
        visible={taskDetailVisible} onCancel={() => setTaskDetailVisible(false)}
        footer={null}
      >
        {taskDetail && (() => {
          const colorMap: Record<string, string> = {
            video: 'green', image: 'arcoblue', audio: 'purple', script_parse: 'magenta',
            remove_subtitle: 'orange', subtitle: 'blue', script_upload: 'gray', video_edit: 'cyan',
          }
          const dur = taskDetail.started_at && taskDetail.completed_at
            ? Math.max(0, Math.round((new Date(taskDetail.completed_at).getTime() - new Date(taskDetail.started_at).getTime()) / 1000))
            : null
          const fmtDur = (s: number) => s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
          const prompt = (taskDetail.input_data || {}).prompt || (taskDetail.input_data || {}).resource_name
          return (
            <>
              {/* 概览（双列紧凑） */}
              <Descriptions column={2} data={[
                { label: '类型', value: <Tag color={colorMap[taskDetail.type] || 'gray'}>{TASK_TYPE_LABEL[taskDetail.type] || taskDetail.type}</Tag> },
                { label: '模型', value: taskDetail.model ? <Tag size="small" color="arcoblue">{taskDetail.model}</Tag> : '-' },
                { label: '项目', value: taskDetail.project_name || '-' },
                { label: '创建人', value: taskDetail.user_name || '-' },
                { label: '剧本/集/分镜', value: [
                  taskDetail.script_title,
                  taskDetail.episode_number != null ? `第${taskDetail.episode_number}集` : null,
                  taskDetail.scene_sequence != null ? `#${taskDetail.scene_sequence}` : null,
                ].filter(Boolean).join(' / ') || '-' },
                { label: '消耗积分', value: <Text type="warning">{taskDetail.credits_consumed ?? 0}</Text> },
                { label: '任务ID', value: <Text copyable style={{ fontSize: 12 }}>{taskDetail.id}</Text>, span: 2 },
              ]} />

              {/* 进度 / 耗时 */}
              <Row gutter={16} style={{ marginTop: 4 }}>
                {['pending', 'processing'].includes(taskDetail.status) && (
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: 12 }}>进度 {taskDetail.progress || 0}%</Text>
                    <Progress percent={taskDetail.progress || 0} size="small" style={{ marginTop: 2 }} />
                  </Col>
                )}
                <Col span={12}>
                  <Text type="secondary" style={{ fontSize: 12 }}>耗时</Text>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{dur != null ? fmtDur(dur) : '-'}</div>
                </Col>
              </Row>

              {/* 提示词 */}
              {prompt && (
                <>
                  <Title heading={6} style={{ margin: '14px 0 6px' }}>提示词</Title>
                  <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 13, padding: '6px 10px', background: 'var(--color-fill-1)', borderRadius: 4 }}>
                    <HighlightPrompt prompt={prompt} fontSize={13} />
                  </div>
                </>
              )}

              {/* 输出文件 */}
              {((taskDetail.output_urls || []).length > 0) && (
                <>
                  <Title heading={6} style={{ margin: '14px 0 6px' }}>输出文件（{(taskDetail.output_urls || []).length}）</Title>
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
                </>
              )}

              {/* 错误信息（完整可读） */}
              {taskDetail.error_message && (
                <>
                  <Title heading={6} style={{ margin: '14px 0 6px' }}>错误信息</Title>
                  <div style={{ padding: '8px 10px', background: 'rgb(var(--danger-1))', border: '1px solid rgb(var(--danger-2))', borderRadius: 4, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'rgb(var(--danger-6))', maxHeight: 160, overflow: 'auto' }}>
                    {taskDetail.error_message}
                  </div>
                </>
              )}

              {/* 接口日志 */}
              <Title heading={6} style={{ margin: '14px 0 6px' }}>接口日志（{(taskDetail.meta?.logs || []).length} 条，最新在上）</Title>
              {(() => {
                const logs = (taskDetail.meta?.logs) || []
                if (!logs.length) return <Text type="secondary">暂无日志</Text>
                const levelColor: Record<string, string> = { info: 'arcoblue', warning: 'orange', error: 'red' }
                return (
                  <div style={{ maxHeight: 320, overflow: 'auto', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {[...logs].reverse().map((lg: any, i: number) => (
                      <div key={i} style={{ borderBottom: '1px solid var(--color-fill-2)', paddingBottom: 4 }}>
                        <Space size={6} style={{ marginBottom: 2 }}>
                          <Tag size="small" color={levelColor[lg.level] || 'gray'}>{lg.level}</Tag>
                          {lg.stage && <Tag size="small" color="gray">{lg.stage}</Tag>}
                          {lg.time && <Text type="secondary" style={{ fontSize: 11 }}>{new Date(lg.time).toLocaleString('zh-CN')}</Text>}
                        </Space>
                        <div style={{ color: lg.level === 'error' ? 'rgb(var(--danger-6))' : lg.level === 'warning' ? 'rgb(var(--warning-6))' : 'var(--color-text-2)' }}>{lg.message}</div>
                        {lg.data && (
                          <Collapse expandIconPosition="right" style={{ marginTop: 2 }}>
                            <Collapse.Item header="详细数据" name={`d${i}`} style={{ fontSize: 11 }}>
                              <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(lg.data, null, 2)}</pre>
                            </Collapse.Item>
                          </Collapse>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })()}

              {/* 时间与原始参数（默认折叠，避免长 JSON 挤占空间） */}
              <Collapse style={{ marginTop: 14 }}>
                <Collapse.Item header="时间信息与完整参数" name="raw">
                  <Descriptions column={2} data={[
                    { label: '创建时间', value: taskDetail.created_at ? new Date(taskDetail.created_at).toLocaleString('zh-CN') : '-' },
                    { label: '开始时间', value: taskDetail.started_at ? new Date(taskDetail.started_at).toLocaleString('zh-CN') : '-' },
                    { label: '完成时间', value: taskDetail.completed_at ? new Date(taskDetail.completed_at).toLocaleString('zh-CN') : '-' },
                    { label: '更新时间', value: taskDetail.updated_at ? new Date(taskDetail.updated_at).toLocaleString('zh-CN') : '-' },
                  ]} />
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '8px 0 4px' }}>完整输入参数</Text>
                  <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--color-fill-1)', padding: 8, borderRadius: 4 }}>
                    {JSON.stringify(taskDetail.input_data, null, 2)}
                  </pre>
                </Collapse.Item>
              </Collapse>
            </>
          )
        })()}
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
