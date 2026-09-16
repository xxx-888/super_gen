/**
 * AdminPaymentPage - 支付管理: 订单对账确认 / 套餐管理 / 发票审核
 *
 * 订单渠道: manual(人工确认)为当前可用通道——用户下单后运营比对到账流水,
 * 点「确认入账」即自动充值积分并通知用户(站内+邮件, 幂等可重复点)。
 * 微信/支付宝/IAP 资质到位后接入 payment_service 渠道适配层, 回调自动入账。
 */
import React from 'react'
import {
  Card, Table, Tag, Button, Space, Input, Modal, Message, Popconfirm,
  Form, Select, InputNumber, Switch, Typography, Tabs, Grid,
} from '@arco-design/web-react'
import { IconSearch, IconPlus, IconSafe, IconApps, IconClockCircle, IconFile } from '@arco-design/web-react/icon'
import { adminPaymentService, type PricingPlan, type PaymentOrder } from '../../api/services'

const { Row, Col } = Grid
const { Text } = Typography

const yuan = (cents?: number) => ((cents ?? 0) / 100).toFixed(2)
const fmtTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-'

const STATUS_META: Record<string, { color: string; text: string }> = {
  pending: { color: 'orange', text: '待处理' },
  paid: { color: 'green', text: '已入账' },
  cancelled: { color: 'gray', text: '已取消' },
  failed: { color: 'red', text: '已驳回' },
  refunded: { color: 'gray', text: '已退款' },
  issued: { color: 'green', text: '已开票' },
  rejected: { color: 'red', text: '已驳回' },
}

const Tab = { status: (s?: string) => (STATUS_META[s || ''] ? <Tag color={STATUS_META[s!].color}>{STATUS_META[s!].text}</Tag> : s || '-') }

// ==================== 订单对账 ====================

const OrdersTab: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [orders, setOrders] = React.useState<PaymentOrder[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [status, setStatus] = React.useState<string>('pending')
  const [search, setSearch] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [action, setAction] = React.useState<{ type: 'confirm' | 'reject'; order: PaymentOrder } | null>(null)
  const [noteForm] = Form.useForm()
  const [submitting, setSubmitting] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await adminPaymentService.orders({
        status: status || undefined, search: search || undefined, page, page_size: 15,
      })
      setOrders(res?.items || [])
      setTotal(res?.total || 0)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [status, search, page])

  React.useEffect(() => { load() }, [load])

  const submitAction = async () => {
    if (!action) return
    setSubmitting(true)
    try {
      const note = noteForm.getFieldValue('note')
      if (action.type === 'confirm') {
        await adminPaymentService.confirmOrder(action.order.order_no, note)
        Message.success('已确认入账，积分到账并通知用户')
      } else {
        await adminPaymentService.rejectOrder(action.order.order_no, note)
        Message.success('已驳回')
      }
      setAction(null)
      noteForm.resetFields()
      load()
      onChanged?.()
    } catch (e: any) {
      Message.error(e?.message || '操作失败')
    } finally { setSubmitting(false) }
  }

  return (
    <>
      <Space style={{ marginBottom: 12 }} size={8}>
        <Select value={status} onChange={(v) => { setPage(1); setStatus(v) }} style={{ width: 140 }} allowClear placeholder="全部状态">
          <Select.Option value="pending">待处理</Select.Option>
          <Select.Option value="paid">已入账</Select.Option>
          <Select.Option value="cancelled">已取消</Select.Option>
          <Select.Option value="failed">已驳回</Select.Option>
        </Select>
        <Input.Search
          placeholder="订单号 / 用户邮箱 / 团队名"
          style={{ width: 260 }} allowClear
          onSearch={(v) => { setPage(1); setSearch(v) }}
        />
      </Space>
      <Table
        size="small" loading={loading} data={orders} rowKey="id"
        pagination={{ total, pageSize: 15, current: page, onChange: setPage }}
        columns={[
          { title: '订单号', dataIndex: 'order_no', width: 200 },
          { title: '团队', dataIndex: 'org_name', width: 130 },
          { title: '用户', width: 170, render: (_: any, o: any) => o.user_nickname || o.user_email || '-' },
          { title: '套餐', width: 100, render: (_: any, o: any) => o.plan_name || '-' },
          { title: '金额', width: 90, render: (_: any, o: any) => `¥${yuan(o.amount_cents)}` },
          { title: '积分', dataIndex: 'credits', width: 90 },
          { title: '渠道', dataIndex: 'channel', width: 90, render: (c: string) => (c === 'manual' ? '人工' : c) },
          { title: '状态', width: 90, render: (_: any, o: any) => Tab.status(o.status) },
          { title: '发票', width: 90, render: (_: any, o: any) => o.invoice_status ? Tab.status(o.invoice_status) : '-' },
          { title: '下单时间', width: 160, render: (_: any, o: any) => fmtTime(o.created_at) },
          { title: '操作', width: 150, fixed: 'right' as const, render: (_: any, o: any) => (
              o.status === 'pending' ? (
                <Space size={4}>
                  <Button type="primary" size="mini"
                          onClick={() => { setAction({ type: 'confirm', order: o }); noteForm.resetFields() }}>
                    确认入账
                  </Button>
                  <Button size="mini" status="danger"
                          onClick={() => { setAction({ type: 'reject', order: o }); noteForm.resetFields() }}>
                    驳回
                  </Button>
                </Space>
              ) : <Typography.Text type="secondary">-</Typography.Text>
            ) },
        ]}
      />
      <Modal
        title={action?.type === 'confirm' ? `确认入账：${action?.order.order_no}` : `驳回订单：${action?.order.order_no}`}
        visible={!!action}
        confirmLoading={submitting}
        onOk={submitAction}
        onCancel={() => setAction(null)}
        okText={action?.type === 'confirm' ? '确认入账' : '驳回'}
        unmountOnExit
      >
        <Form form={noteForm} layout="vertical">
          {action?.type === 'confirm' && (
            <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--color-text-2)' }}>
              确认后向团队 <b>{action.order.org_name}</b> 充值 <b>{action.order.credits}</b> 积分，
              并通知下单人（站内 + 邮件）。重复点击不会重复入账。
            </div>
          )}
          <Form.Item label={action?.type === 'confirm' ? '备注(可选)' : '驳回原因'} field="note">
            <Input.TextArea placeholder={action?.type === 'confirm' ? '如：已核对银行到账流水' : '如：未查询到对应到账流水'} maxLength={255} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

// ==================== 套餐管理 ====================

const EMPTY_PLAN = { code: '', name: '', tagline: '', price_cents: 990, credits: 1000, bonus_credits: 0, valid_days: 0, badge: '', sort_order: 0, is_enabled: true }

const PlansTab: React.FC = () => {
  const [plans, setPlans] = React.useState<PricingPlan[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editing, setEditing] = React.useState<Partial<PricingPlan> | null>(null)
  const [isNew, setIsNew] = React.useState(false)
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await adminPaymentService.plans()
      setPlans(Array.isArray(res) ? res : [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])

  React.useEffect(() => { load() }, [load])

  const openNew = () => {
    setIsNew(true); setEditing({ ...EMPTY_PLAN })
    form.resetFields(); form.setFieldsValue({ ...EMPTY_PLAN })
  }

  const openEdit = (p: PricingPlan) => {
    setIsNew(false); setEditing(p)
    form.resetFields(); form.setFieldsValue({ ...p, features: Array.isArray(p.features) ? p.features.join('\n') : '' })
  }

  const submit = async () => {
    try {
      const v = await form.validate()
      const payload: any = { ...v }
      if (typeof payload.features === 'string') {
        payload.features = payload.features.split('\n').map((s: string) => s.trim()).filter(Boolean)
      }
      setSubmitting(true)
      if (isNew) {
        await adminPaymentService.createPlan(payload)
        Message.success('套餐已创建')
      } else {
        const { code, ...rest } = payload
        await adminPaymentService.updatePlan(editing!.id!, rest)
        Message.success('套餐已更新')
      }
      setEditing(null)
      load()
    } catch (e: any) {
      if (e?.message) Message.error(e.message)
    } finally { setSubmitting(false) }
  }

  const handleDelete = async (p: PricingPlan) => {
    try {
      const res: any = await adminPaymentService.deletePlan(p.id)
      Message.success(res?.soft_deleted ? '已有订单引用，已改为下架停售' : '已删除')
      load()
    } catch (e: any) { Message.error(e?.message || '删除失败') }
  }

  return (
    <>
      <Button type="primary" icon={<IconPlus />} style={{ marginBottom: 12 }} onClick={openNew}>新建套餐</Button>
      <Table
        size="small" loading={loading} data={plans} rowKey="id" pagination={false}
        columns={[
          { title: '代码', dataIndex: 'code', width: 100 },
          { title: '名称', dataIndex: 'name', width: 120 },
          { title: '售价', width: 100, render: (_: any, p: any) => `¥${yuan(p.price_cents)}` },
          { title: '积分', width: 120, render: (_: any, p: any) => `${p.credits}${p.bonus_credits ? ` +${p.bonus_credits}` : ''}` },
          { title: '角标', dataIndex: 'badge', width: 100, render: (v: string) => v || '-' },
          { title: '排序', dataIndex: 'sort_order', width: 70 },
          { title: '上架', width: 80, render: (_: any, p: any) => p.is_enabled ? <Tag color="green">上架中</Tag> : <Tag>已下架</Tag> },
          { title: '操作', width: 150, render: (_: any, p: any) => (
              <Space size={4}>
                <Button type="text" size="mini" onClick={() => openEdit(p)}>编辑</Button>
                <Popconfirm title="确定删除？(有订单时改为下架)" onOk={() => handleDelete(p)}>
                  <Button type="text" size="mini" status="danger">删除</Button>
                </Popconfirm>
              </Space>
            ) },
        ]}
      />
      <Modal
        title={isNew ? '新建套餐' : `编辑套餐：${editing?.name}`}
        visible={!!editing}
        confirmLoading={submitting}
        onOk={submit}
        onCancel={() => setEditing(null)}
        okText="保存" unmountOnExit
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item label="代码" field="code" rules={[{ required: true, message: '如 trial/creator/studio' }]} style={{ width: 150 }}>
              <Input disabled={!isNew} placeholder="trial" maxLength={30} />
            </Form.Item>
            <Form.Item label="名称" field="name" rules={[{ required: true }]} style={{ width: 160 }}>
              <Input placeholder="创作者版" maxLength={100} />
            </Form.Item>
          </Space>
          <Form.Item label="一句话卖点" field="tagline"><Input maxLength={255} /></Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item label="售价(分)" field="price_cents" rules={[{ required: true }]} style={{ width: 130 }}>
              <InputNumber min={1} placeholder="990 = ¥9.9" />
            </Form.Item>
            <Form.Item label="到账积分" field="credits" rules={[{ required: true }]} style={{ width: 130 }}>
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item label="加赠积分" field="bonus_credits" style={{ width: 130 }}>
              <InputNumber min={0} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item label="角标" field="badge" style={{ width: 140 }}>
              <Input placeholder="最受欢迎" maxLength={30} />
            </Form.Item>
            <Form.Item label="排序(小在前)" field="sort_order" style={{ width: 140 }}>
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item label="上架" field="is_enabled" triggerPropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item label="权益点(每行一条)" field="features">
            <Input.TextArea placeholder={'高清 1080P 导出\n每月 3 次一键成片'} autoSize={{ minRows: 3 }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

// ==================== 发票审核 ====================

const InvoicesTab: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [invs, setInvs] = React.useState<any[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [status, setStatus] = React.useState<string>('pending')
  const [loading, setLoading] = React.useState(true)
  const [action, setAction] = React.useState<{ type: 'issue' | 'reject'; inv: any } | null>(null)
  const [noteForm] = Form.useForm()
  const [submitting, setSubmitting] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await adminPaymentService.invoices({ status: status || undefined, page, page_size: 15 })
      setInvs(res?.items || [])
      setTotal(res?.total || 0)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [status, page])

  React.useEffect(() => { load() }, [load])

  const submit = async () => {
    if (!action) return
    setSubmitting(true)
    try {
      const note = noteForm.getFieldValue('note')
      if (action.type === 'issue') {
        await adminPaymentService.issueInvoice(action.inv.id, note)
        Message.success('已标记开票并通知申请人')
      } else {
        await adminPaymentService.rejectInvoice(action.inv.id, note)
        Message.success('已驳回并通知申请人')
      }
      setAction(null); load()
      onChanged?.()
    } catch (e: any) { Message.error(e?.message || '操作失败') }
    finally { setSubmitting(false) }
  }

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select value={status} onChange={(v) => { setPage(1); setStatus(v) }} style={{ width: 140 }} allowClear placeholder="全部状态">
          <Select.Option value="pending">待处理</Select.Option>
          <Select.Option value="issued">已开票</Select.Option>
          <Select.Option value="rejected">已驳回</Select.Option>
        </Select>
      </Space>
      <Table
        size="small" loading={loading} data={invs} rowKey="id"
        pagination={{ total, pageSize: 15, current: page, onChange: setPage }}
        columns={[
          { title: '订单号', dataIndex: 'order_no', width: 200 },
          { title: '申请人', dataIndex: 'user_email', width: 170 },
          { title: '金额', width: 90, render: (_: any, r: any) => `¥${yuan(r.amount_cents)}` },
          { title: '抬头', width: 160, render: (_: any, r: any) => r.title },
          { title: '类型', width: 70, render: (t: string) => (t === 'company' ? '企业' : '个人') },
          { title: '税号', dataIndex: 'tax_no', width: 170, render: (v: string) => v || '-' },
          { title: '接收邮箱', dataIndex: 'email', width: 180 },
          { title: '状态', width: 90, render: (_: any, r: any) => Tab.status(r.status) },
          { title: '申请时间', width: 160, render: (_: any, r: any) => fmtTime(r.created_at) },
          { title: '操作', width: 140, fixed: 'right' as const, render: (_: any, r: any) => (
              r.status === 'pending' ? (
                <Space size={4}>
                  <Button type="primary" size="mini" onClick={() => { setAction({ type: 'issue', inv: r }); noteForm.resetFields() }}>标记开票</Button>
                  <Button size="mini" status="danger" onClick={() => { setAction({ type: 'reject', inv: r }); noteForm.resetFields() }}>驳回</Button>
                </Space>
              ) : <Typography.Text type="secondary">{r.admin_note || '-'}</Typography.Text>
            ) },
        ]}
      />
      <Modal
        title={action?.type === 'issue' ? '标记已开票' : '驳回发票申请'}
        visible={!!action}
        confirmLoading={submitting}
        onOk={submit}
        onCancel={() => setAction(null)}
        okText={action?.type === 'issue' ? '确认开票' : '驳回'}
        unmountOnExit
      >
        <Form form={noteForm} layout="vertical">
          {action?.type === 'issue' && (
            <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--color-text-2)' }}>
              开票完成后请将发票发送至申请人邮箱：<b>{action.inv.email}</b>
            </div>
          )}
          <Form.Item label={action?.type === 'issue' ? '备注(可选)' : '驳回原因'} field="note">
            <Input.TextArea maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

const AdminPaymentPage: React.FC = () => {
  const [stats, setStats] = React.useState<any>(null)

  const loadStats = React.useCallback(async () => {
    try { setStats(await adminPaymentService.stats()) } catch { /* 拦截器提示 */ }
  }, [])
  React.useEffect(() => { loadStats() }, [loadStats])

  const statCard = (title: string, value: React.ReactNode, icon: React.ReactNode, sub?: React.ReactNode) => (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {icon}
        <Text type="secondary" style={{ fontSize: 13 }}>{title}</Text>
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8, lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{sub}</div>}
    </Card>
  )

  return (
    <div>
      {/* 汇总统计卡（后端 /admin/payment/stats 全量口径） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>{statCard('累计收入',
          stats ? `¥${yuan(stats.total_revenue_cents)}` : '-',
          <IconSafe style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />,
          stats ? `今日 +¥${yuan(stats.today_revenue_cents)}` : undefined)}</Col>
        <Col span={6}>{statCard('订单总数', stats?.total_orders ?? '-',
          <IconApps style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />,
          stats ? `已入账 ${stats.paid_orders} · 取消/驳回 ${stats.closed_orders}` : undefined)}</Col>
        <Col span={6}>{statCard('待处理订单', stats?.pending_orders ?? '-',
          <IconClockCircle style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />,
          '人工对账通道，确认后积分到账')}</Col>
        <Col span={6}>{statCard('发票待审核', stats?.invoice_pending ?? '-',
          <IconFile style={{ fontSize: 22, color: 'rgb(var(--purple-6))' }} />,
          stats ? `已开票 ${stats.invoice_issued}` : undefined)}</Col>
      </Row>

      <Card title="支付管理">
        <Tabs defaultActiveTab="orders" type="card-gutter">
          <Tabs.TabPane key="orders" title="订单对账">
            <OrdersTab onChanged={loadStats} />
          </Tabs.TabPane>
          <Tabs.TabPane key="plans" title="套餐管理">
            <PlansTab />
          </Tabs.TabPane>
          <Tabs.TabPane key="invoices" title="发票审核">
            <InvoicesTab onChanged={loadStats} />
          </Tabs.TabPane>
        </Tabs>
      </Card>
    </div>
  )
}

export default AdminPaymentPage
