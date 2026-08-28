/**
 * MyCreditsPage - 我的积分明细
 *
 * 团队积分余额/配额统计卡 + 近 7 日净消耗趋势 + 流水（搜索/类型筛选/真分页）。
 * 积分是团队级概念，切换团队后自动刷新数据。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Card, Grid, Statistic, Table, Typography, Select, Spin, Empty, Tag, Space, Input, Button } from '@arco-design/web-react'
import { IconGift, IconPlus, IconMinus, IconRefresh, IconSearch, IconThunderbolt, IconUser } from '@arco-design/web-react/icon'
import { creditService } from '@/api/services'
import { useTeamStore, useCreditStore, useUserStore } from '@/stores'
import DailyBars from '@/components/charts/DailyBars'

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
  const user = useUserStore((s: any) => s.user)

  const [account, setAccount] = useState<any>(null)
  const [myAllocation, setMyAllocation] = useState<any>(null)
  const [transactions, setTransactions] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [trend, setTrend] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [acct, txs, allocs]: any = await Promise.all([
        creditService.getAccount(),
        creditService.listTransactions({
          type: typeFilter, search: search || undefined, page, page_size: pageSize,
        }),
        creditService.listAllocations().catch(() => []),
      ])
      setAccount(acct)
      const d = txs?.items ? txs : { items: Array.isArray(txs) ? txs : [], total: 0 }
      setTransactions(d.items || [])
      setTotal(typeof d.total === 'number' ? d.total : 0)
      setTrend(d.summary?.trend_7d || [])
      // 当前用户的成员配额（团队 owner 通常无配额记录）
      const mine = (Array.isArray(allocs) ? allocs : []).find((a: any) => user?.id && a.user_id === user.id)
      setMyAllocation(mine || null)
      // 同步刷新顶部积分徽章
      loadBalance()
    } catch { /* 拦截器提示 */ } finally {
      setLoading(false)
    }
  }, [typeFilter, search, page, pageSize, loadBalance, user?.id])

  useEffect(() => {
    // currentOrg 可能为 null（首次加载），等 team store 就绪后再拉
    if (!currentOrg) return
    loadData()
  }, [currentOrg?.id, typeFilter, search, page, pageSize])

  // 流水表格列
  const columns = [
    {
      title: '类型', dataIndex: 'type', width: 90,
      render: (v: string) => {
        const m = TX_TYPE_MAP[v] || { label: v, color: 'gray' }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    {
      title: '金额', dataIndex: 'amount', width: 100,
      render: (v: number) => (
        <Text style={{ color: v >= 0 ? 'rgb(var(--success-6))' : 'rgb(var(--danger-6))', fontWeight: 600 }}>
          {v >= 0 ? '+' : ''}{v}
        </Text>
      ),
    },
    { title: '余额', dataIndex: 'balance_after', width: 90 },
    { title: '模型', dataIndex: 'model', width: 150, ellipsis: true, render: (v: string) => v ? <Tag size="small">{v}</Tag> : '-' },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : '-' },
    {
      title: '时间', dataIndex: 'created_at', width: 150,
      render: (v: string) => v
        ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>
        : '-',
    },
  ]

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title heading={5} style={{ margin: 0 }}>我的积分</Title>
        <Button icon={<IconRefresh />} loading={loading} onClick={loadData}>刷新</Button>
      </div>

      {/* 统计卡：团队余额 / 我的配额 / 累计充值 / 累计消耗 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>{statCard('团队可用余额', balance ?? account?.balance ?? '-', <IconGift style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />, currentOrg?.name)}</Col>
        <Col span={6}>{statCard(
          '我的配额', myAllocation ? `${myAllocation.used}/${myAllocation.quota}` : '不限',
          <IconUser style={{ fontSize: 22, color: 'rgb(var(--purple-6))' }} />,
          myAllocation ? `剩余 ${myAllocation.quota - myAllocation.used}` : '团队 owner 不设配额',
        )}</Col>
        <Col span={6}>{statCard('累计充值', account?.total_recharged ?? '-', <IconPlus style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />)}</Col>
        <Col span={6}>{statCard('累计消耗', account?.total_consumed ?? '-', <IconMinus style={{ fontSize: 22, color: 'rgb(var(--red-6))' }} />)}</Col>
      </Row>

      {/* 近 7 日净变动趋势（正=充值/退款流入，负=消耗） */}
      <Card title={<Space size={8}><IconThunderbolt style={{ color: 'rgb(var(--orange-6))' }} />近 7 日积分净变动</Space>} style={{ marginBottom: 16 }}>
        {trend.length > 0 ? (
          <>
            <DailyBars data={trend.map((t: any) => ({
              date: t.date.slice(5),
              count: Math.abs(t.amount || 0),
              failed: 0,
            }))} />
            <Text type="secondary" style={{ fontSize: 12 }}>柱高为当日净变动绝对值（充值/退款为正，消耗为负；净额以流水为准）</Text>
          </>
        ) : (
          <Empty description="近 7 日无积分变动" />
        )}
      </Card>

      {/* 流水 */}
      <Card
        title={`积分流水${total ? `（共 ${total} 条）` : ''}`}
        extra={
          <Space size={8}>
            <Input
              placeholder="搜索备注 / 模型"
              style={{ width: 200 }}
              value={searchInput}
              onChange={setSearchInput}
              allowClear
              prefix={<IconSearch />}
              onPressEnter={() => { setSearch(searchInput); setPage(1) }}
              onClear={() => { setSearchInput(''); setSearch(''); setPage(1) }}
            />
            <Select
              placeholder="流水类型" allowClear style={{ width: 110 }}
              value={typeFilter}
              onChange={(v) => { setTypeFilter(v); setPage(1) }}
            >
              {Object.entries(TX_TYPE_MAP).map(([k, m]) => (
                <Select.Option key={k} value={k}>{m.label}</Select.Option>
              ))}
            </Select>
          </Space>
        }
      >
        <Spin loading={loading} style={{ display: 'block' }}>
          <Table
            columns={columns}
            data={transactions}
            rowKey="id"
            pagination={{
              current: page,
              pageSize,
              total,
              showTotal: true,
              showJumper: true,
              sizeCanChange: true,
              sizeOptions: [10, 20, 50],
              onChange: (p: number, ps?: number) => {
                setPage(p)
                if (ps && ps !== pageSize) setPageSize(ps)
              },
            }}
            noDataElement={<Empty description="暂无流水记录" />}
          />
        </Spin>
      </Card>
    </div>
  )
}

export default MyCreditsPage
