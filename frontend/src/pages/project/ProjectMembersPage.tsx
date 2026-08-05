/**
 * ProjectMembersPage - 项目成员管理
 *
 * 功能: 成员列表(角色/状态) + 邀请成员(邮箱+角色) + 改角色 + 移除成员
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Spin, Table, Typography, Button, Space, Tag, Modal, Form, Input, Select,
  Message, Popconfirm, Empty,
} from '@arco-design/web-react'
import { IconPlus, IconRefresh, IconDelete, IconUserGroup, IconLink, IconLock, IconCopy } from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { projectMemberService, projectService } from '@/api/services'
import { ProjectMember, PROJECT_ROLES } from '@/types'

const { Title, Text } = Typography

const ROLE_COLORS: Record<string, string> = {
  owner: 'red', manager: 'arcoblue', editor: 'green', viewer: 'gray',
}

const ProjectMembersPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [loading, setLoading] = useState(false)
  const [addVisible, setAddVisible] = useState(false)
  const [addForm] = Form.useForm()

  const svc = React.useMemo(() => (projectId ? projectMemberService(projectId) : null), [projectId])

  // 当前用户在项目里的角色（从成员列表找）
  const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
  const myMember = members.find((m: any) => m.user_id === currentUser.id)
  const myRole = myMember?.role || (currentUser.role === 'admin' ? 'owner' : 'viewer')
  const canManage = myRole === 'owner' || myRole === 'manager' || currentUser.role === 'admin'

  const load = useCallback(async () => {
    if (!svc) return
    setLoading(true)
    try {
      const res: any = await svc.list()
      setMembers(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [svc])

  useEffect(() => { load() }, [load])

  // 加载项目设置（回显邀请链接/密码状态）
  useEffect(() => {
    if (!projectId) return
    ;(async () => {
      try {
        const res: any = await projectService.get(projectId)
        const proj = res?.data ?? res
        const settings = proj?.settings || {}
        if (settings.invite_token) {
          setInviteUrl(`${window.location.origin}/projects/join?token=${settings.invite_token}`)
        }
        if (settings.access_password) {
          setHasPwd(true)
        }
      } catch { /* ignore */ }
    })()
  }, [projectId])

  const handleAdd = async () => {
    try {
      const v = await addForm.validate()
      await svc!.add(v)
      Message.success('成员已添加')
      setAddVisible(false); addForm.resetFields(); load()
    } catch (e: any) { if (e?.errorFields) return }
  }

  const handleRoleChange = async (userId: string, role: string) => {
    try {
      await svc!.updateRole(userId, role)
      Message.success('角色已更新')
      load()
    } catch { Message.error('更新失败') }
  }

  const handleRemove = async (userId: string) => {
    try {
      await svc!.remove(userId)
      Message.success('成员已移除')
      load()
    } catch { Message.error('移除失败') }
  }

  // 邀请链接 / 访问密码
  const [inviteUrl, setInviteUrl] = useState('')
  const [pwdInput, setPwdInput] = useState('')
  const [hasPwd, setHasPwd] = useState(false)
  const [genLoading, setGenLoading] = useState(false)

  const handleGenInvite = async () => {
    if (!projectId) return
    setGenLoading(true)
    try {
      const res: any = await projectService.generateInviteLink(projectId)
      const r = res?.data ?? res
      const fullUrl = `${window.location.origin}${r.invite_url}`
      setInviteUrl(fullUrl)
      Message.success('邀请链接已生成')
    } catch (e: any) { Message.error(e?.response?.data?.detail || '生成失败') }
    finally { setGenLoading(false) }
  }

  const handleCopyLink = () => {
    if (!inviteUrl) return
    navigator.clipboard.writeText(inviteUrl).then(
      () => Message.success('链接已复制到剪贴板'),
      () => Message.error('复制失败，请手动复制'),
    )
  }

  const handleSavePwd = async () => {
    if (!projectId) return
    try {
      await projectService.setAccessPassword(projectId, pwdInput)
      setHasPwd(!!pwdInput)
      Message.success(pwdInput ? '访问密码已设置' : '访问密码已清除')
      setPwdInput('')
    } catch (e: any) { Message.error(e?.response?.data?.detail || '设置失败') }
  }

  const columns = [
    {
      title: '成员', dataIndex: 'email', key: 'email',
      render: (v: string, r: ProjectMember) => (
        <div>
          <Text bold>{r.nickname || v}</Text>
          <div style={{ fontSize: 12, color: 'var(--color-text-3)' }}>{v}</div>
        </div>
      ),
    },
    {
      title: '角色', dataIndex: 'role', key: 'role', width: 160,
      render: (v: string, r: ProjectMember) => {
        const roleLabel = PROJECT_ROLES.find(rr => rr.key === v)?.label || v
        if (r.role === 'owner') return <Tag color={ROLE_COLORS[v]}>负责人</Tag>
        if (!canManage) return <Tag color={ROLE_COLORS[v]}>{roleLabel}</Tag>
        return (
          <Select size="small" value={v} style={{ width: 120 }} onChange={(nr) => handleRoleChange(r.user_id, nr)}>
            {PROJECT_ROLES.filter(rr => rr.key !== 'owner').map(rr => (
              <Select.Option key={rr.key} value={rr.key}>{rr.label}</Select.Option>
            ))}
          </Select>
        )
      },
    },
    {
      title: '加入时间', dataIndex: 'joined_at', key: 'joined', width: 170,
      render: (v: string) => v ? v.replace('T', ' ').slice(0, 16) : '-',
    },
    {
      title: '操作', key: 'action', width: 100,
      render: (_: any, r: ProjectMember) => (
        r.role !== 'owner' && canManage ? (
          <Popconfirm title="确认移除该成员？" onOk={() => handleRemove(r.user_id)}>
            <Button size="mini" status="danger" icon={<IconDelete />}>移除</Button>
          </Popconfirm>
        ) : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title heading={5} style={{ margin: 0 }}><IconUserGroup /> 项目成员管理</Title>
        <Space>
          <Button onClick={() => navigate(`/projects/${projectId}`)}>返回项目</Button>
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<IconPlus />} onClick={() => setAddVisible(true)} disabled={!canManage}>添加成员</Button>
        </Space>
      </div>

      <Card>
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary">共 {members.length} 位成员（角色：负责人可管理项目，管理者可编辑，编辑可修改内容，只读仅查看）</Text>
        </div>
        {loading ? <Spin dot style={{ display: 'block', margin: '40px auto' }} /> :
         members.length === 0 ? <Empty description="暂无成员" /> :
         <Table columns={columns} data={members} rowKey="user_id" pagination={false} size="small" />
        }
      </Card>

      {/* 邀请链接 + 访问密码（仅 owner/manager 可见） */}
      {canManage && (
      <Card title={<span><IconLink /> 邀请链接 & 访问密码</span>} style={{ marginTop: 16 }}>
        <div style={{ marginBottom: 20 }}>
          <Text style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>邀请链接</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            生成链接后分享给他人，他们点击链接即可申请加入项目（无需邮箱邀请）
          </Text>
          <Space style={{ width: '100%' }}>
            <Input
              readOnly
              value={inviteUrl}
              placeholder="点击下方按钮生成邀请链接"
              style={{ flex: 1, minWidth: 400 }}
            />
            <Button icon={<IconCopy />} disabled={!inviteUrl} onClick={handleCopyLink}>复制</Button>
            <Button type="primary" icon={<IconLink />} loading={genLoading} onClick={handleGenInvite}>
              {inviteUrl ? '重置链接' : '生成链接'}
            </Button>
          </Space>
        </div>

        <div style={{ paddingTop: 16, borderTop: '1px solid var(--color-fill-2)' }}>
          <Text style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
            <IconLock /> 访问密码 {hasPwd && <Tag color="green" size="small">已设置</Tag>}
          </Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            设置后，通过邀请链接加入时需输入此密码。留空提交可清除密码。
          </Text>
          <Space>
            <Input
              value={pwdInput}
              onChange={setPwdInput}
              placeholder={hasPwd ? '已设置密码，输入新密码可修改' : '设置访问密码（可选）'}
              style={{ width: 300 }}
            />
            <Button onClick={handleSavePwd}>{pwdInput ? '保存' : '清除密码'}</Button>
          </Space>
        </div>
      </Card>
      )}

      {/* 添加成员弹窗 */}
      <Modal
        title="添加项目成员" visible={addVisible}
        onCancel={() => setAddVisible(false)} onOk={handleAdd}
        okText="添加" cancelText="取消"
      >
        <Form form={addForm} layout="vertical">
          <Form.Item field="email" label="成员邮箱" rules={[{ required: true, type: 'email' as any, message: '请输入有效邮箱' }]}>
            <Input placeholder="member@example.com (须已是平台注册用户)" />
          </Form.Item>
          <Form.Item field="role" label="角色" initialValue="editor">
            <Select>
              {PROJECT_ROLES.filter(r => r.key !== 'owner').map(r => (
                <Select.Option key={r.key} value={r.key}>{r.label}</Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ProjectMembersPage
