/**
 * TeamMembersPage - 成员管理 (M2)
 *
 * 概览卡(总成员/活跃/剩余积分/已分配) + 成员表格(项目归属/+/-积分/状态/操作) +
 * 邀请成员弹窗 / 编辑 / 重置密码 / 操作日志抽屉
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Spin, Table, Typography, Grid, Statistic, Button, Space, Tag, Input,
  Modal, Form, Select, Message, Popconfirm, Drawer, InputNumber,
} from '@arco-design/web-react'
import {
  IconUserGroup, IconUser, IconGift, IconPlus, IconRefresh, IconLock, IconHistory,
} from '@arco-design/web-react/icon'
import { teamService, creditService } from '@/api/services'
import { useTeamStore, useCreditStore } from '@/stores'

const { Title, Text } = Typography
const { Row, Col } = Grid

const TeamMembersPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const { account } = useCreditStore()
  const [members, setMembers] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [inviteVisible, setInviteVisible] = useState(false)
  const [inviteForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [editTarget, setEditTarget] = useState<any>(null)
  const [editForm] = Form.useForm()
  const [resetTarget, setResetTarget] = useState<any>(null)
  const [resetForm] = Form.useForm()
  const [logsTarget, setLogsTarget] = useState<any>(null)
  const [logs, setLogs] = useState<any[]>([])
  // 配额分配（+/-积分）
  const [allocTarget, setAllocTarget] = useState<any>(null)
  const [allocForm] = Form.useForm()
  const [allocSubmitting, setAllocSubmitting] = useState(false)
  // 筛选（角色/状态，前端过滤）
  const [roleFilter, setRoleFilter] = useState<string | undefined>(undefined)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)

  const orgId = currentOrg?.id

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const res: any = await teamService.members.list(orgId, search ? { search } : undefined)
      setMembers(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [orgId, search])

  useEffect(() => { load() }, [load])

  // 概览统计
  const total = members.length
  const active = members.filter((m) => m.is_active).length
  const allocated = members.reduce((s, m) => s + (m.credit_quota || 0), 0)
  const balance = account?.balance ?? 0

  const handleInvite = async () => {
    try {
      const v = await inviteForm.validate()
      setSubmitting(true)
      await teamService.members.invite(orgId, v)
      Message.success('成员邀请成功')
      setInviteVisible(false)
      inviteForm.resetFields()
      load()
    } catch (e: any) {
      if (e?.errorFields) return
      Message.error('邀请失败')
    } finally { setSubmitting(false) }
  }

  const handleEdit = async () => {
    try {
      const v = await editForm.validate()
      await teamService.members.update(orgId, editTarget.user_id, v)
      Message.success('已更新')
      setEditTarget(null)
      load()
    } catch (e: any) { if (e?.errorFields) return }
  }

  const handleResetPwd = async () => {
    try {
      const v = await resetForm.validate()
      await teamService.members.resetPassword(orgId, resetTarget.user_id, v.new_password)
      Message.success('密码已重置')
      setResetTarget(null)
      resetForm.resetFields()
    } catch (e: any) { if (e?.errorFields) return }
  }

  const handleToggle = async (record: any) => {
    try {
      await teamService.members.toggleStatus(orgId, record.user_id)
      Message.success(record.is_active ? '已禁用' : '已启用')
      load()
    } catch { Message.error('操作失败') }
  }

  const handleViewLogs = async (record: any) => {
    setLogsTarget(record)
    try {
      const res: any = await teamService.members.logs(orgId, record.user_id)
      setLogs(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { setLogs([]) }
  }

  // 配额分配：正数=增加配额，负数=回收（调 creditService.allocate）
  const openAllocate = (r: any) => {
    setAllocTarget(r)
    allocForm.setFieldsValue({ amount: 100, remark: '' })
  }
  const handleAllocate = async () => {
    if (!allocTarget) return
    try {
      const v = await allocForm.validate()
      setAllocSubmitting(true)
      await creditService.allocate({
        user_id: allocTarget.user_id,
        amount: v.amount,
        remark: v.remark || undefined,
      })
      Message.success(v.amount >= 0 ? `已分配 ${v.amount} 积分给 ${allocTarget.nickname}` : `已从 ${allocTarget.nickname} 回收 ${-v.amount} 积分`)
      setAllocTarget(null)
      load()
    } catch (e: any) {
      if (e?.errorFields) return
      Message.error(e?.response?.data?.detail || '分配失败')
    } finally {
      setAllocSubmitting(false)
    }
  }

  // 前端角色/状态过滤
  const visibleMembers = members.filter((m) => {
    if (roleFilter && m.role !== roleFilter) return false
    if (statusFilter === 'active' && !m.is_active) return false
    if (statusFilter === 'inactive' && m.is_active) return false
    return true
  })

  const columns = [
    {
      title: '成员信息', dataIndex: 'nickname', key: 'nickname',
      render: (v: string, r: any) => (
        <div>
          <Text bold>{v}</Text>
          <div style={{ fontSize: 12, color: 'var(--color-text-3)' }}>{r.email}</div>
        </div>
      ),
    },
    {
      title: '所属项目', dataIndex: 'projects', key: 'projects',
      render: (v: string[]) => v?.length ? <Space wrap>{v.slice(0, 2).map((p, i) => <Tag key={i}>{p}</Tag>)}{v.length > 2 && <Tag>+{v.length - 2}</Tag>}</Space> : <Text type="secondary">-</Text>,
    },
    {
      title: '角色', dataIndex: 'role', key: 'role', width: 90,
      render: (v: string) => v === 'owner' ? <Tag color="red">创建者</Tag> : v === 'admin' ? <Tag color="arcoblue">管理员</Tag> : <Tag>成员</Tag>,
    },
    {
      title: '积分配额', key: 'credit', width: 150,
      render: (_v: any, r: any) => (
        <Space size={6}>
          <Text>{r.credit_used}/{r.credit_quota}</Text>
          <Button size="mini" type="text" icon={<IconGift />} title="分配/回收积分" onClick={() => openAllocate(r)} />
        </Space>
      ),
    },
    {
      title: '状态', dataIndex: 'is_active', key: 'status', width: 90,
      render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? '活跃' : '禁用'}</Tag>,
    },
    {
      title: '加入时间', dataIndex: 'joined_at', key: 'joined', width: 160,
      render: (v: string) => v ? v.replace('T', ' ').slice(0, 16) : '-',
    },
    {
      title: '操作', key: 'action', width: 260, fixed: 'right' as const,
      render: (_v: any, r: any) => (
        <Space size="small">
          <Button size="mini" onClick={() => { setEditTarget(r); editForm.setFieldsValue({ role: r.role, display_name: r.nickname }) }}>编辑</Button>
          <Button size="mini" icon={<IconLock />} onClick={() => setResetTarget(r)}>重置密码</Button>
          <Button size="mini" icon={<IconHistory />} onClick={() => handleViewLogs(r)}>日志</Button>
          {r.role !== 'owner' && (
            <Popconfirm title={r.is_active ? '确定禁用该成员?' : '确定启用?'} onOk={() => handleToggle(r)}>
              <Button size="mini" type="outline" status={r.is_active ? 'danger' : 'success'}>{r.is_active ? '禁用' : '启用'}</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>成员管理</Title>

      {/* 概览卡 */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        <Col span={6}><Card><Statistic title="总成员数" value={total} prefix={<IconUserGroup />} /></Card></Col>
        <Col span={6}><Card><Statistic title="活跃成员" value={active} prefix={<IconUser />} /></Card></Col>
        <Col span={6}><Card><Statistic title="账户剩余积分" value={balance} prefix={<IconGift />} styleValue={{ color: 'rgb(var(--success-6))' }} /></Card></Col>
        <Col span={6}><Card><Statistic title="已分配积分" value={allocated} /></Card></Col>
      </Row>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Input.Search
            placeholder="搜索成员名称/邮箱" style={{ width: 220 }}
            value={search} onChange={setSearch} onSearch={load} allowClear
          />
          <Space size={8} wrap>
            <Select
              placeholder="角色" style={{ width: 100 }} allowClear value={roleFilter}
              onChange={setRoleFilter}
            >
              <Select.Option value="owner">创建者</Select.Option>
              <Select.Option value="admin">管理员</Select.Option>
              <Select.Option value="member">成员</Select.Option>
            </Select>
            <Select
              placeholder="状态" style={{ width: 90 }} allowClear value={statusFilter}
              onChange={setStatusFilter}
            >
              <Select.Option value="active">活跃</Select.Option>
              <Select.Option value="inactive">禁用</Select.Option>
            </Select>
            <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
            <Button type="primary" icon={<IconPlus />} onClick={() => setInviteVisible(true)}>分配下级账户</Button>
          </Space>
        </div>

        <Table
          columns={columns} data={visibleMembers} rowKey="user_id"
          pagination={{ pageSize: 15, showTotal: true }} loading={loading} size="small"
          scroll={{ x: 1100 }}
          noDataElement="没有符合条件的成员"
        />
      </Card>

      {/* 配额分配弹窗 */}
      <Modal
        title={`积分配额 · ${allocTarget?.nickname || ''}`}
        visible={!!allocTarget}
        onCancel={() => setAllocTarget(null)}
        onOk={handleAllocate}
        confirmLoading={allocSubmitting}
        okText="确认"
        cancelText="取消"
      >
        {allocTarget && (
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            当前配额 {allocTarget.credit_quota ?? 0}，已用 {allocTarget.credit_used ?? 0}，剩余 {(allocTarget.credit_quota ?? 0) - (allocTarget.credit_used ?? 0)}
            （团队账户余额 {balance}）
          </Text>
        )}
        <Form form={allocForm} layout="vertical">
          <Form.Item
            field="amount" label="分配数量（正数=分配给成员，负数=回收）"
            rules={[{ required: true, type: 'number' as any, message: '请输入数量' }]}
          >
            <InputNumber placeholder="如 100（回收填 -50）" step={50} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="remark" label="备注">
            <Input placeholder="可选，如：本月制作配额" maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 邀请成员 */}
      <Modal
        title="分配下级账户" visible={inviteVisible}
        onCancel={() => setInviteVisible(false)} onOk={handleInvite}
        confirmLoading={submitting} okText="邀请" cancelText="取消"
      >
        <Form form={inviteForm} layout="vertical">
          <Form.Item field="email" label="邮箱" rules={[{ required: true, type: 'email' as any, message: '请输入有效邮箱' }]}>
            <Input placeholder="member@example.com" />
          </Form.Item>
          <Form.Item field="display_name" label="显示名">
            <Input placeholder="成员昵称(可选)" />
          </Form.Item>
          <Form.Item field="role" label="角色" rules={[{ required: true }]} initialValue="member">
            <Select>
              <Select.Option value="member">普通成员</Select.Option>
              <Select.Option value="admin">管理员</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item field="password" label="初始密码(新用户)" rules={[{ required: true, minLength: 8, message: '至少8位' }]}>
            <Input.Password placeholder="新用户需设置初始密码" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑成员 */}
      <Modal
        title="编辑成员" visible={!!editTarget}
        onCancel={() => setEditTarget(null)} onOk={handleEdit}
        okText="保存" cancelText="取消"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item field="display_name" label="显示名"><Input /></Form.Item>
          <Form.Item field="role" label="角色">
            <Select>
              <Select.Option value="member">普通成员</Select.Option>
              <Select.Option value="admin">管理员</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码 */}
      <Modal
        title="重置密码" visible={!!resetTarget}
        onCancel={() => setResetTarget(null)} onOk={handleResetPwd}
        okText="重置" cancelText="取消"
      >
        <p style={{ color: 'var(--color-text-3)' }}>将为 <b>{resetTarget?.nickname}</b> 设置新密码</p>
        <Form form={resetForm} layout="vertical">
          <Form.Item field="new_password" label="新密码" rules={[{ required: true, minLength: 8, message: '至少8位' }]}>
            <Input.Password placeholder="至少8位" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 操作日志抽屉 */}
      <Drawer
        title={<span>{logsTarget?.nickname} 的操作日志</span>}
        visible={!!logsTarget} onCancel={() => setLogsTarget(null)}
        width={480} footer={null}
      >
        {logs.length === 0 ? <Text type="secondary">暂无操作记录</Text> : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {logs.map((l: any) => (
              <Card key={l.id} size="small">
                <Space>
                  <Tag color="arcoblue">{l.action}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>{l.created_at?.replace('T', ' ').slice(0, 19)}</Text>
                </Space>
                <div style={{ marginTop: 6 }}>{l.detail || '-'}</div>
              </Card>
            ))}
          </Space>
        )}
      </Drawer>
    </div>
  )
}

export default TeamMembersPage
