/**
 * MyCreditsPage - 我的积分明细
 *
 * 展示当前团队的积分余额与流水记录。
 * 积分是团队级概念，切换团队后自动刷新数据。
 * 普通用户也能看到自己团队的积分去向（之前只有管理员有积分管理页）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Card, Grid, Statistic, Table, Typography, Select, Spin, Empty, Tag, Space } from '@arco-design/web-react'
import { IconGift, IconPlus, IconMinus, IconRefresh } from '@arco-design/web-react/icon'
import { creditService } from '@/api/services'
import { useTeamStore, useCreditStore } from '@/stores'

const { Title, Text } = Typography
const { Row, Col } = Grid

// 流水类型 → 中文 + 颜色
const TX_TYPE_MAP: Record<string, { label: string; color: string }> = {
  recharge: { label: '充值', color: 'green' },
  allocate: { label: '分配', color: 'arcoblue' },
  consume: { label: '消耗', color: 'orangered' },
  refund: { label: '退款', color: 'cyan' },
  adjust: { label: '调整', color: 'orange' },
}

const MyCreditsPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const { balance, loadBalance } = useCreditStore()

  const [account, setAccount] = useState<any>(null)
  const [transactions, setTransactions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [acct, txs]: any = await Promise.all([
        creditService.getAccount(),
        creditService.listTransactions({ type: typeFilter, page, page_size: pageSize }),
      ])
      setAccount(acct)
      setTransactions(Array.isArray(txs) ? txs : [])
      // 同步刷新顶部积分徽章
      loadBalance()
    } catch { /* 拦截器提示 */ } finally {
      setLoading(false)
    }
  }, [typeFilter, page, pageSize, loadBalance])

  useEffect(() => {
    // currentOrg 可能为 null（首次加载），等 team store 就绪后再拉
    if (!currentOrg) return
    loadData()
  }, [currentOrg?.id, typeFilter, page, pageSize])

  // 流水表格列
  const columns = [
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 90,
      render: (v: string) => {
        const m = TX_TYPE_MAP[v] || { label: v, color: 'gray' }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    {
      title: '金额', dataIndex: 'amount', key: 'amount', width: 100,
      render: (v: number) => (
        <Text style={{ color: v >= 0 ? 'rgb(var(--success-6))' : 'rgb(var(--danger-6))', fontWeight: 600 }}>
          {v >= 0 ? '+' : ''}{v}
        </Text>
      ),
    },
    { title: '余额', dataIndex: 'balance_after', key: 'balance_after', width: 80 },
    { title: '模型', dataIndex: 'model', key: 'model', width: 130, render: (v: string) => v || '-' },
    { title: '备注', dataIndex: 'remark', key: 'remark', render: (v: string) => v || '-' },
    {
      title: '时间', dataIndex: 'created_at', key: 'created_at', width: 160,
      render: (v: string) => v ? v.replace('T', ' ').slice(0, 19) : '-',
    },
  ]

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 4 }}>我的积分</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
        当前团队：{currentOrg?.name || '加载中...'}{currentOrg?.is_personal ? '（个人）' : ''}
      </Text>

      {/* 余额概览卡片 */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="可用余额"
              value={balance}
              prefix={<IconGift style={{ color: 'rgb(var(--warning-6))' }} />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="累计充值" value={account?.total_recharged ?? 0} prefix={<IconPlus style={{ color: 'rgb(var(--success-6))' }} />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="累计消耗" value={account?.total_consumed ?? 0} prefix={<IconMinus style={{ color: 'rgb(var(--danger-6))' }} />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="已分配额度" value={account?.allocated ?? 0} />
          </Card>
        </Col>
      </Row>

      {/* 流水记录 */}
      <Card
        title="积分流水"
        extra={
          <Space>
            <Select
              placeholder="按类型筛选"
              style={{ width: 130 }}
              allowClear
              value={typeFilter}
              onChange={(v) => { setTypeFilter(v); setPage(1) }}
            >
              <Select.Option value="consume">消耗</Select.Option>
              <Select.Option value="recharge">充值</Select.Option>
              <Select.Option value="refund">退款</Select.Option>
              <Select.Option value="allocate">分配</Select.Option>
              <Select.Option value="adjust">调整</Select.Option>
            </Select>
          </Space>
        }
      >
        {loading ? (
          <Spin dot style={{ display: 'block', margin: '40px auto' }} />
        ) : transactions.length === 0 ? (
          <Empty description={currentOrg ? '该团队暂无积分流水' : '请先选择团队'} />
        ) : (
          <Table
            columns={columns}
            data={transactions}
            rowKey="id"
            size="small"
            pagination={{
              current: page,
              pageSize,
              total: transactions.length >= pageSize ? (page * pageSize) + 1 : (page - 1) * pageSize + transactions.length,
              showTotal: true,
              sizeOptions: [10, 20, 50],
              onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            }}
          />
        )}
      </Card>
    </div>
  )
}

export default MyCreditsPage
