/**
 * RechargePage - 充值中心: 套餐卡片 + 我的订单 + 发票申请
 *
 * 支付通道状态由后台 payment_enabled 开关控制(与 IAP 类目/商户号资质、
 * ICP 备案进度联动): 关闭时套餐仅展示, 下单按钮禁用并显示筹备文案。
 * 当前渠道: manual(人工确认)——下单后运营对账确认即自动入账并通知。
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Button, Table, Tag, Modal, Form, Input, Radio, Message, Popconfirm,
  Typography, Space, Empty, Spin,
} from '@arco-design/web-react'
import { IconGift, IconThunderbolt } from '@arco-design/web-react/icon'
import { paymentService, type PricingPlan, type PaymentOrder } from '../../api/services'
import { useCreditStore } from '../../stores'

const { Text } = Typography
const yuan = (cents?: number) => ((cents ?? 0) / 100).toFixed(2)

const STATUS_META: Record<string, { color: string; text: string }> = {
  pending: { color: 'orange', text: '待支付' },
  paid: { color: 'green', text: '已入账' },
  cancelled: { color: 'gray', text: '已取消' },
  failed: { color: 'red', text: '已驳回' },
  refunded: { color: 'gray', text: '已退款' },
  // 发票
  issued: { color: 'green', text: '已开票' },
  rejected: { color: 'red', text: '已驳回' },
}

const fmtTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : ''

const RechargePage: React.FC = () => {
  const navigate = useNavigate()
  const { loadBalance } = useCreditStore()
  const [payEnabled, setPayEnabled] = React.useState(false)
  const [payNotice, setPayNotice] = React.useState('')
  const [plans, setPlans] = React.useState<PricingPlan[]>([])
  const [orders, setOrders] = React.useState<PaymentOrder[]>([])
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState<string | null>(null)

  // 发票弹窗
  const [invoiceOrder, setInvoiceOrder] = React.useState<PaymentOrder | null>(null)
  const [invoiceForm] = Form.useForm()
  const [invoiceSubmitting, setInvoiceSubmitting] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [statusRes, plansRes, ordersRes]: any[] = await Promise.all([
        paymentService.status(),
        paymentService.plans(),
        paymentService.listOrders({ page_size: 20 }),
      ])
      setPayEnabled(!!statusRes?.enabled)
      setPayNotice(statusRes?.notice || '')
      setPlans(Array.isArray(plansRes) ? plansRes : [])
      setOrders(Array.isArray(ordersRes) ? ordersRes : [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])

  React.useEffect(() => { load() }, [load])

  const handleBuy = async (plan: PricingPlan) => {
    setSubmitting(plan.id)
    try {
      await paymentService.createOrder(plan.id, 'manual')
      Message.success(`订单已提交：运营对账确认后积分自动到账（订单可在下方「我的订单」查看）`)
      await load()
    } catch (e: any) {
      Message.error(e?.message || '下单失败')
    } finally {
      setSubmitting(null)
    }
  }

  const handleCancel = async (order: PaymentOrder) => {
    try {
      await paymentService.cancelOrder(order.order_no)
      Message.success('订单已取消')
      load()
    } catch (e: any) { Message.error(e?.message || '取消失败') }
  }

  const openInvoice = (order: PaymentOrder) => {
    setInvoiceOrder(order)
    invoiceForm.resetFields()
    invoiceForm.setFieldsValue({ order_no: order.order_no, title_type: 'company', email: undefined })
  }

  const submitInvoice = async () => {
    try {
      const values = await invoiceForm.validate()
      setInvoiceSubmitting(true)
      await paymentService.createInvoice({
        order_no: invoiceOrder!.order_no,
        title_type: values.title_type,
        title: values.title,
        tax_no: values.tax_no,
        email: values.email,
      })
      Message.success('发票申请已提交，审核结果将通过通知与邮件告知')
      setInvoiceOrder(null)
      load()
    } catch (e: any) {
      if (e?.message) Message.error(e.message)
    } finally {
      setInvoiceSubmitting(false)
    }
  }

  const canInvoice = (o: PaymentOrder) =>
    o.status === 'paid' && !o.invoice_status

  return (
    <Card
      title={<Space><IconGift /> 充值中心</Space>}
      extra={<Button size="small" onClick={() => navigate('/credits')}>返回我的积分</Button>}
    >
      {/* 支付通道状态横幅 */}
      {!payEnabled && (
        <div style={{
          padding: '10px 16px', marginBottom: 16, borderRadius: 6,
          background: 'var(--color-fill-2)', border: '1px solid var(--color-border)',
          color: 'var(--color-text-2)', fontSize: 13,
        }}>
          <IconThunderbolt style={{ color: 'rgb(var(--warning-6))', marginRight: 6 }} />
          {payNotice || '在线支付即将开放'}
        </div>
      )}

      {/* 套餐卡片 */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 16, marginBottom: 24,
      }}>
        {plans.map((p) => (
          <div key={p.id} style={{
            position: 'relative', border: `1px solid ${p.badge ? 'rgb(var(--primary-6))' : 'var(--color-border)'}`,
            borderRadius: 8, padding: 20, textAlign: 'center',
            background: 'var(--color-bg-1)',
          }}>
            {p.badge && (
              <div style={{
                position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                background: 'rgb(var(--primary-6))', color: '#fff', fontSize: 12,
                padding: '1px 12px', borderRadius: 10,
              }}>{p.badge}</div>
            )}
            <div style={{ fontSize: 16, fontWeight: 600 }}>{p.name}</div>
            {p.tagline && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{p.tagline}</div>}
            <div style={{ margin: '12px 0 4px' }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: 'rgb(var(--primary-6))' }}>¥{yuan(p.price_cents)}</span>
              {p.original_price_cents && p.original_price_cents > p.price_cents && (
                <span style={{ fontSize: 13, color: 'var(--color-text-4)', textDecoration: 'line-through', marginLeft: 6 }}>
                  ¥{yuan(p.original_price_cents)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-2)' }}>
              {p.credits.toLocaleString()} 积分
              {p.bonus_credits > 0 && (
                <span style={{ color: 'rgb(var(--success-6))' }}> +{p.bonus_credits.toLocaleString()} 加赠</span>
              )}
            </div>
            {p.valid_days > 0 && (
              <div style={{ fontSize: 12, color: 'var(--color-text-4)', marginTop: 2 }}>有效期 {p.valid_days} 天</div>
            )}
            {Array.isArray(p.features) && p.features.length > 0 && (
              <div style={{ textAlign: 'left', margin: '12px 0', fontSize: 12, color: 'var(--color-text-3)', lineHeight: 2 }}>
                {p.features.map((f, i) => <div key={i}>· {f}</div>)}
              </div>
            )}
            <Button
              type="primary" long disabled={!payEnabled}
              loading={submitting === p.id}
              onClick={() => handleBuy(p)}
            >
              {payEnabled ? '立即购买' : '暂不可购'}
            </Button>
          </div>
        ))}
      </div>

      {/* 我的订单 */}
      <Typography.Title heading={6} style={{ marginBottom: 12 }}>我的订单</Typography.Title>
      <Table
        size="small"
        loading={loading}
        data={orders}
        rowKey="id"
        pagination={{ pageSize: 10 }}
        noDataElement={<Empty description="暂无订单" />}
        columns={[
          { title: '订单号', dataIndex: 'order_no', width: 200 },
          { title: '套餐', render: (_: any, o: PaymentOrder) => o.plan_snapshot?.name || o.plan_name || '-' },
          { title: '金额', width: 100, render: (_: any, o: PaymentOrder) => `¥${yuan(o.amount_cents)}` },
          { title: '积分', dataIndex: 'credits', width: 100 },
          { title: '状态', width: 90, render: (_: any, o: PaymentOrder) => {
              const m = STATUS_META[o.status] || { color: 'gray', text: o.status }
              return <Tag color={m.color}>{m.text}</Tag>
            } },
          { title: '发票', width: 90, render: (_: any, o: PaymentOrder) =>
              o.invoice_status
                ? <Tag color={(STATUS_META[o.invoice_status] || {}).color || 'gray'}>
                    {(STATUS_META[o.invoice_status] || {}).text || o.invoice_status}
                  </Tag>
                : <Text type="secondary">-</Text> },
          { title: '时间', width: 160, render: (_: any, o: PaymentOrder) => fmtTime(o.created_at) },
          { title: '操作', width: 160, render: (_: any, o: PaymentOrder) => (
              <Space size={4}>
                {o.status === 'pending' && (
                  <Popconfirm title="确定取消该订单？" onOk={() => handleCancel(o)}>
                    <Button type="text" size="mini">取消</Button>
                  </Popconfirm>
                )}
                {canInvoice(o) && (
                  <Button type="text" size="mini" onClick={() => openInvoice(o)}>申请发票</Button>
                )}
              </Space>
            ) },
        ]}
      />

      {/* 发票申请弹窗 */}
      <Modal
        title="申请开票"
        visible={!!invoiceOrder}
        confirmLoading={invoiceSubmitting}
        onOk={submitInvoice}
        onCancel={() => setInvoiceOrder(null)}
        okText="提交申请"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={invoiceForm} layout="vertical">
          <Form.Item label="订单号">
            <Input value={invoiceOrder?.order_no} disabled />
          </Form.Item>
          <Form.Item label="开票金额">
            <Text>¥{yuan(invoiceOrder?.amount_paid_cents ?? invoiceOrder?.amount_cents)}</Text>
          </Form.Item>
          <Form.Item label="抬头类型" field="title_type" rules={[{ required: true }]}>
            <Radio.Group options={[{ label: '企业', value: 'company' }, { label: '个人', value: 'personal' }]} />
          </Form.Item>
          <Form.Item label="发票抬头" field="title" rules={[{ required: true, message: '请填写发票抬头' }]}>
            <Input placeholder="公司名称或个人姓名" maxLength={255} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {(values) => values.title_type === 'company' && (
              <Form.Item label="税号" field="tax_no" rules={[{ required: true, message: '企业抬头必须填写税号' }]}>
                <Input placeholder="统一社会信用代码" maxLength={50} />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item label="接收邮箱" field="email" rules={[{ required: true, type: 'email', message: '请填写正确的邮箱' }]}>
            <Input placeholder="发票将发送至该邮箱" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

export default RechargePage
