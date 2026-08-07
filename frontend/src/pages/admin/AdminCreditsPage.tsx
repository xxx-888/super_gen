/**
 * AdminCreditsPage - 后台积分管理 (M1)
 *
 * 功能:
 * - 所有团队积分账户列表 + 手动充值
 * - 全局积分流水(按团队/类型筛选)
 *
 * 作为独立路由页(/admin/credits)与 AdminDashboardPage 的 tab 内容共用.
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Table, Tag, Space, Button, Message, Modal, Form, Input, InputNumber,
  Typography, Statistic, Grid, Select,
} from '@arco-design/web-react'
import { IconGift, IconRefresh, IconPlus } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text } = Typography
const { Row, Col } = Grid

const TX_TYPE_MAP: Record<string, { label: string; color: string }> = {
  recharge: { label: '充值', color: 'green' },
  allocate: { label: '分配', color: 'arcoblue' },
  consume: { label: '消耗', color: 'orange' },
  refund: { label: '退还', color: 'cyan' },
  adjust: { label: '调整', color: 'gray' },
}

const AdminCreditsPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([])
  const [transactions, setTransactions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [rechargeVisible, setRechargeVisible] = useState(false)
  const [rechargeTarget, setRechargeTarget] = useState<any>(null)
  const [rechargeForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [txFilter, setTxFilter] = useState<{ org_id?: string; type?: string }>({})

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [accs, txs]: any = await Promise.all([
        adminService.credits.listAccounts(),
        adminService.credits.listTransactions({ limit: 200, ...txFilter }),
      ])
      setAccounts(Array.isArray(accs) ? accs : [])
      setTransactions(Array.isArray(txs) ? txs : [])
    } catch {
      Message.error('加载积分数据失败')
    } finally {
      setLoading(false)
    }
  }, [txFilter])

  useEffect(() => { loadData() }, [loadData])

  // 汇总统计
  const totalBalance = accounts.reduce((s, a) => s + (a.balance || 0), 0)
  const totalConsumed = accounts.reduce((s, a) => s + (a.total_consumed || 0), 0)
  const totalRecharged = accounts.reduce((s, a) => s + (a.total_recharged || 0), 0)

  // 账户表格列（后端已 join 团队名）
  const accountColumns = [
    {
      title: '团队', dataIndex: 'org_name', key: 'org_name',
      render: (_: any, record: any) => (
        <Text copyable={{ text: record.org_id }}>
          {record.org_name || '未知团队'}{record.is_personal ? '（个人）' : ''}
        </Text>
      ),
    },
    { title: '可用余额', dataIndex: 'balance', key: 'balance', render: (v: number) => <Text bold style={{ color: 'rgb(var(--success-6))' }}>{v}</Text> },
    { title: '已分配', dataIndex: 'allocated', key: 'allocated' },
    { title: '累计充值', dataIndex: 'total_recharged', key: 'total_recharged' },
    { title: '累计消耗', dataIndex: 'total_consumed', key: 'total_consumed', render: (v: number) => <Text style={{ color: 'rgb(var(--danger-6))' }}>{v}</Text> },
    {
      title: '操作', key: 'action',
      render: (_: any, record: any) => (
        <Button
          type="outline" size="small" icon={<IconPlus />}
          onClick={() => { setRechargeTarget(record); setRechargeVisible(true) }}
        >充值</Button>
      ),
    },
  ]

  // 流水表格列
  const txColumns = [
    {
      title: '类型', dataIndex: 'type', key: 'type',
      render: (v: string) => {
        const m = TX_TYPE_MAP[v] || { label: v, color: 'gray' }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    {
      title: '金额', dataIndex: 'amount', key: 'amount',
      render: (v: number) => (
        <Text style={{ color: v >= 0 ? 'rgb(var(--success-6))' : 'rgb(var(--danger-6))', fontWeight: 600 }}>
          {v >= 0 ? '+' : ''}{v}
        </Text>
      ),
    },
    { title: '余额', dataIndex: 'balance_after', key: 'balance_after' },
    {
      title: '团队', key: 'org',
      render: (_: any, record: any) => (
        <span>{record.org_name || (record.org_id ? String(record.org_id).slice(0, 8) + '…' : '-')}</span>
      ),
    },
    { title: '模型', dataIndex: 'model', key: 'model', render: (v: string) => v || '-' },
    { title: '备注', dataIndex: 'remark', key: 'remark', render: (v: string) => v || '-' },
    { title: '时间', dataIndex: 'created_at', key: 'created_at', render: (v: string) => v?.replace('T', ' ').slice(0, 19) },
  ]

  const handleRecharge = async () => {
    try {
      const values = await rechargeForm.validate()
      setSubmitting(true)
      await adminService.credits.recharge(rechargeTarget.org_id, {
        amount: values.amount,
        remark: values.remark,
      })
      Message.success(`充值成功：${values.amount} 积分`)
      setRechargeVisible(false)
      rechargeForm.resetFields()
      setRechargeTarget(null)
      loadData()
    } catch (e: any) {
      if (e?.errorFields) return // 表单校验错误
      Message.error('充值失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {/* 汇总卡片 */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        <Col span={6}><Card><Statistic title="团队账户数" value={accounts.length} prefix={<IconGift />} /></Card></Col>
        <Col span={6}><Card><Statistic title="可用余额总计" value={totalBalance} suffix="积分" /></Card></Col>
        <Col span={6}><Card><Statistic title="累计充值总计" value={totalRecharged} suffix="积分" /></Card></Col>
        <Col span={6}><Card><Statistic title="累计消耗总计" value={totalConsumed} suffix="积分" /></Card></Col>
      </Row>

      {/* 账户列表 */}
      <Card title="团队积分账户" style={{ marginBottom: 20 }} extra={
        <Button icon={<IconRefresh />} onClick={loadData} loading={loading}>刷新</Button>
      }>
        <Table
          columns={accountColumns}
          data={accounts}
          rowKey="id"
          pagination={{ pageSize: 15 }}
          loading={loading}
          size="small"
        />
      </Card>

      {/* 流水 */}
      <Card
        title="积分流水"
        extra={
          <Space>
            <Select
              placeholder="流水类型" allowClear style={{ width: 130 }}
              value={txFilter.type}
              onChange={(v) => setTxFilter((f) => ({ ...f, type: v || undefined }))}
            >
              {Object.entries(TX_TYPE_MAP).map(([k, m]) => (
                <Select.Option key={k} value={k}>{m.label}</Select.Option>
              ))}
            </Select>
          </Space>
        }
      >
        <Table
          columns={txColumns}
          data={transactions}
          rowKey="id"
          pagination={{ pageSize: 20 }}
          size="small"
        />
      </Card>

      {/* 充值弹窗 */}
      <Modal
        title="手动充值"
        visible={rechargeVisible}
        onCancel={() => { setRechargeVisible(false); setRechargeTarget(null) }}
        onOk={handleRecharge}
        confirmLoading={submitting}
        okText="充值"
        cancelText="取消"
      >
        <Form form={rechargeForm} layout="vertical">
          {rechargeTarget && (
            <Text type="secondary">目标团队：{rechargeTarget.org_id.slice(0, 12)}…  当前余额：{rechargeTarget.balance}</Text>
          )}
          <Form.Item
            field="amount"
            label="充值积分数量"
            rules={[{ required: true, type: 'number' as any, min: 1, message: '请输入大于0的整数' }]}
            style={{ marginTop: 12 }}
          >
            <InputNumber placeholder="如 1000" min={1} step={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="remark" label="备注">
            <Input placeholder="可选，如：季度充值" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default AdminCreditsPage
