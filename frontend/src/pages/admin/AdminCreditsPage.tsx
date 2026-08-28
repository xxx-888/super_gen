/**
 * AdminCreditsPage - 后台积分管理 (M1)
 *
 * 功能:
 * - 汇总统计卡（账户数/总余额/累计与今日充值消耗，后端 summary）
 * - 团队积分账户列表：搜索/排序/低余额警示/充值/按团队钻取流水
 * - 全局积分流水：团队/类型筛选 + 备注模型搜索
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Table, Tag, Space, Button, Message, Modal, Form, Input, InputNumber,
  Typography, Grid, Select, Popconfirm, Tooltip,
} from '@arco-design/web-react'
import {
  IconGift, IconRefresh, IconPlus, IconSearch, IconSafe,
  IconDownCircle, IconExclamationCircle, IconThunderbolt,
} from '@arco-design/web-react/icon'
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

/** 低余额警示阈值 */
const LOW_BALANCE = 100

const AdminCreditsPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [transactions, setTransactions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  // 账户筛选
  const [accSearch, setAccSearch] = useState('')
  // 流水筛选
  const [txFilter, setTxFilter] = useState<{ org_id?: string; type?: string; search?: string }>({})
  const [txSearch, setTxSearch] = useState('')
  // 充值
  const [rechargeVisible, setRechargeVisible] = useState(false)
  const [rechargeTarget, setRechargeTarget] = useState<any>(null)
  const [rechargeForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  // 流水区锚点（点击账户「流水」滚动过去）
  const txSectionRef = React.useRef<HTMLDivElement>(null)

  const loadAccounts = useCallback(async (search?: string) => {
    const s = search !== undefined ? search : accSearch
    const res: any = await adminService.credits.listAccounts(s ? { search: s } : undefined)
    const d = res?.data ?? res
    setAccounts(Array.isArray(d?.items) ? d.items : [])
    setSummary(d?.summary ?? null)
  }, [accSearch])

  const loadTx = useCallback(async () => {
    const res: any = await adminService.credits.listTransactions({ limit: 300, ...txFilter })
    setTransactions(Array.isArray(res) ? res : [])
  }, [txFilter])

  const loadData = async () => {
    setLoading(true)
    try {
      await Promise.all([loadAccounts(), loadTx()])
    } catch {
      Message.error('加载积分数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [loadTx])

  // 账户表格列
  const accountColumns = [
    {
      title: '团队', dataIndex: 'org_name', key: 'org_name',
      render: (_: any, record: any) => (
        <Text copyable={{ text: record.org_id }}>
          {record.org_name || '未知团队'}{record.is_personal ? '（个人）' : ''}
        </Text>
      ),
    },
    {
      title: '可用余额', dataIndex: 'balance', key: 'balance', width: 130,
      sorter: (a: any, b: any) => (a.balance || 0) - (b.balance || 0),
      render: (v: number) => (
        <Space size={6}>
          <Text bold style={{ color: v > 0 ? 'rgb(var(--success-6))' : 'rgb(var(--danger-6))' }}>{v}</Text>
          {v <= LOW_BALANCE && (
            <Tooltip content={`余额 ≤ ${LOW_BALANCE}，团队可能很快无法提交生成任务`}>
              <Tag size="small" color="red">低余额</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    { title: '已分配', dataIndex: 'allocated', key: 'allocated', width: 90 },
    {
      title: '累计充值', dataIndex: 'total_recharged', key: 'total_recharged', width: 100,
      sorter: (a: any, b: any) => (a.total_recharged || 0) - (b.total_recharged || 0),
    },
    {
      title: '累计消耗', dataIndex: 'total_consumed', key: 'total_consumed', width: 100,
      sorter: (a: any, b: any) => (a.total_consumed || 0) - (b.total_consumed || 0),
      render: (v: number) => <Text style={{ color: 'rgb(var(--danger-6))' }}>{v}</Text>,
    },
    {
      title: '操作', key: 'action', width: 150,
      render: (_: any, record: any) => (
        <Space size={4}>
          <Button
            type="text" size="mini" status="success" icon={<IconPlus />}
            title="手动充值"
            onClick={() => { setRechargeTarget(record); rechargeForm.setFieldsValue({ amount: 1000, remark: '' }); setRechargeVisible(true) }}
          >充值</Button>
          <Button
            type="text" size="mini" icon={<IconDownCircle />}
            title="查看该团队流水"
            onClick={() => {
              setTxFilter((f) => ({ ...f, org_id: record.org_id }))
              txSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >流水</Button>
        </Space>
      ),
    },
  ]

  // 流水表格列
  const txColumns = [
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 80,
      render: (v: string) => {
        const m = TX_TYPE_MAP[v] || { label: v, color: 'gray' }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    {
      title: '金额', dataIndex: 'amount', key: 'amount', width: 90,
      render: (v: number) => (
        <Text style={{ color: v >= 0 ? 'rgb(var(--success-6))' : 'rgb(var(--danger-6))', fontWeight: 600 }}>
          {v >= 0 ? '+' : ''}{v}
        </Text>
      ),
    },
    { title: '余额', dataIndex: 'balance_after', key: 'balance_after', width: 80 },
    {
      title: '团队', key: 'org', width: 150, ellipsis: true,
      render: (_: any, record: any) => (
        <Text style={{ fontSize: 13 }}>{record.org_name || (record.org_id ? String(record.org_id).slice(0, 8) + '…' : '-')}</Text>
      ),
    },
    { title: '模型', dataIndex: 'model', key: 'model', width: 130, ellipsis: true, render: (v: string) => v || '-' },
    { title: '备注', dataIndex: 'remark', key: 'remark', ellipsis: true, render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : '-' },
    {
      title: '时间', dataIndex: 'created_at', key: 'created_at', width: 140,
      render: (v: string) => v
        ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>
        : '-',
    },
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
      Message.error(e?.response?.data?.detail || '充值失败')
    } finally {
      setSubmitting(false)
    }
  }

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
      {/* 汇总统计卡（后端 summary 全量口径） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>{statCard('团队账户数', summary?.account_count ?? '-', <IconGift style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />)}</Col>
        <Col span={6}>{statCard('可用余额总计', summary?.total_balance ?? '-', <IconSafe style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />, '所有账户余额之和')}</Col>
        <Col span={6}>{statCard('累计充值', summary?.total_recharged ?? '-', <IconPlus style={{ fontSize: 22, color: 'rgb(var(--purple-6))' }} />, `今日 +${summary?.today_recharged ?? 0}`)}</Col>
        <Col span={6}>{statCard('累计消耗', summary?.total_consumed ?? '-', <IconThunderbolt style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />, `今日 -${summary?.today_consumed ?? 0}`)}</Col>
      </Row>

      {/* 账户列表 */}
      <Card
        title={<Space size={8}>
          <span>团队积分账户</span>
          <Input
            placeholder="搜索团队名"
            style={{ width: 180 }}
            value={accSearch}
            onChange={setAccSearch}
            allowClear
            prefix={<IconSearch />}
            onPressEnter={() => loadAccounts()}
            onClear={() => { setAccSearch(''); loadAccounts('') }}
          />
        </Space>}
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Popconfirm title="确认刷新全部积分数据？" onOk={loadData}>
              <Button icon={<IconRefresh />} loading={loading}>刷新</Button>
            </Popconfirm>
          </Space>
        }
      >
        <Table
          columns={accountColumns}
          data={accounts}
          rowKey="id"
          pagination={accounts.length > 10 ? { pageSize: 10, showTotal: true } : false}
          loading={loading}
          size="small"
        />
      </Card>

      {/* 流水 */}
      <div ref={txSectionRef}>
        <Card
          title={`积分流水${txFilter.org_id ? `（已按团队过滤，${transactions.length} 条）` : ''}`}
          extra={
            <Space size={8} wrap>
              <Input
                placeholder="搜索备注 / 模型"
                style={{ width: 180 }}
                value={txSearch}
                onChange={setTxSearch}
                allowClear
                prefix={<IconSearch />}
                onPressEnter={() => setTxFilter((f) => ({ ...f, search: txSearch || undefined }))}
                onClear={() => { setTxSearch(''); setTxFilter((f) => ({ ...f, search: undefined })) }}
              />
              <Select
                placeholder="团队" allowClear style={{ width: 150 }} showSearch
                value={txFilter.org_id}
                onChange={(v) => setTxFilter((f) => ({ ...f, org_id: v || undefined }))}
              >
                {accounts.map((a: any) => (
                  <Select.Option key={a.org_id} value={a.org_id}>{a.org_name}{a.is_personal ? '（个人）' : ''}</Select.Option>
                ))}
              </Select>
              <Select
                placeholder="流水类型" allowClear style={{ width: 110 }}
                value={txFilter.type}
                onChange={(v) => setTxFilter((f) => ({ ...f, type: v || undefined }))}
              >
                {Object.entries(TX_TYPE_MAP).map(([k, m]) => (
                  <Select.Option key={k} value={k}>{m.label}</Select.Option>
                ))}
              </Select>
              {txFilter.org_id && (
                <Button size="small" onClick={() => setTxFilter((f) => ({ ...f, org_id: undefined }))}>
                  清除团队过滤
                </Button>
              )}
            </Space>
          }
        >
          <Table
            columns={txColumns}
            data={transactions}
            rowKey="id"
            pagination={{ pageSize: 20, showTotal: true, showJumper: true, sizeCanChange: true, sizeOptions: [20, 50, 100] }}
            size="small"
          />
        </Card>
      </div>

      {/* 充值弹窗 */}
      <Modal
        title={`手动充值${rechargeTarget ? ` · ${rechargeTarget.org_name || ''}` : ''}`}
        visible={rechargeVisible}
        onCancel={() => { setRechargeVisible(false); setRechargeTarget(null) }}
        onOk={handleRecharge}
        confirmLoading={submitting}
        okText="充值"
        cancelText="取消"
      >
        <Form form={rechargeForm} layout="vertical">
          {rechargeTarget && (
            <Space size={16}>
              <Text type="secondary">当前余额：<Text bold style={{ color: 'rgb(var(--success-6))' }}>{rechargeTarget.balance}</Text></Text>
              {rechargeTarget.is_personal && <Tag size="small">个人团队</Tag>}
            </Space>
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
            <Input placeholder="可选，如：季度充值" maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default AdminCreditsPage
