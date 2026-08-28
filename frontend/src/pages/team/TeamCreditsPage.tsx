/**
 * TeamCreditsPage - 积分统计 (M2)
 *
 * 按日期范围 + 维度(项目/账号)筛选, 展示积分消耗明细.
 */
import React, { useEffect, useState } from 'react'
import { Card, Spin, Table, Typography, DatePicker, Radio, Space, Empty, Button, Message } from '@arco-design/web-react'
import { IconDownload, IconRefresh } from '@arco-design/web-react/icon'
import { teamService } from '@/api/services'
import { useTeamStore } from '@/stores'
import dayjs from 'dayjs'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

const TeamCreditsPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => {
  const { currentOrg } = useTeamStore()
  const [loading, setLoading] = useState(false)
  const [dimension, setDimension] = useState<'project' | 'account'>('project')
  const [dateRange, setDateRange] = useState<[string, string]>([
    dayjs().subtract(30, 'day').format('YYYY-MM-DD'),
    dayjs().format('YYYY-MM-DD'),
  ])
  const [result, setResult] = useState<any>(null)

  const load = async () => {
    if (!currentOrg) return
    setLoading(true)
    try {
      const res: any = await teamService.creditStats(currentOrg.id, {
        start_date: dateRange[0], end_date: dateRange[1], dimension,
      })
      setResult(res?.data ?? res)
    } catch { /* ignore */ } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [currentOrg, dimension, dateRange])

  // 导出当前统计结果 CSV（BOM 防 Excel 乱码）
  const handleExport = () => {
    const items = result?.items || []
    if (!items.length) { Message.warning('当前没有数据可导出'); return }
    const header = dimension === 'project'
      ? ['排名', '项目名称', '状态', '消耗积分', '任务次数']
      : ['排名', '成员', '消耗积分', '任务次数']
    const lines = items.map((it: any, i: number) => dimension === 'project'
      ? [i + 1, it.name || '', it.status || '', it.consumed ?? 0, it.count ?? 0]
      : [i + 1, it.name || '', it.consumed ?? 0, it.count ?? 0])
    const csv = '\uFEFF' + [header, ...lines].map((r) => r.map((c: any) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `积分统计_${dimension === 'project' ? '按项目' : '按账号'}_${dateRange[0]}_${dateRange[1]}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    Message.success(`已导出 ${items.length} 条`)
  }

  const columns = dimension === 'project'
    ? [
        { title: '排名', render: (_v: any, _r: any, i: number) => `#${i + 1}`, width: 70 },
        { title: '项目名称', dataIndex: 'name' },
        { title: '状态', dataIndex: 'status', render: (v: string) => v || '-' },
        { title: '消耗积分', dataIndex: 'consumed', sorter: (a: any, b: any) => (a.consumed || 0) - (b.consumed || 0), render: (v: number) => <b style={{ color: 'rgb(var(--danger-6))' }}>{v}</b> },
        { title: '任务次数', dataIndex: 'count', sorter: (a: any, b: any) => (a.count || 0) - (b.count || 0) },
      ]
    : [
        { title: '排名', render: (_v: any, _r: any, i: number) => `#${i + 1}`, width: 70 },
        { title: '成员', dataIndex: 'name' },
        { title: '消耗积分', dataIndex: 'consumed', sorter: (a: any, b: any) => (a.consumed || 0) - (b.consumed || 0), render: (v: number) => <b style={{ color: 'rgb(var(--danger-6))' }}>{v}</b> },
        { title: '任务次数', dataIndex: 'count', sorter: (a: any, b: any) => (a.count || 0) - (b.count || 0) },
      ]

  const totalConsumed = (result?.items || []).reduce((s: number, it: any) => s + (it.consumed || 0), 0)
  const totalCount = (result?.items || []).reduce((s: number, it: any) => s + (it.count || 0), 0)

  return (
    <div style={embedded ? { paddingTop: 8 } : undefined}>
      {!embedded && (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title heading={5} style={{ margin: 0 }}>积分统计</Title>
        <Space size={8}>
          <Button icon={<IconRefresh />} onClick={load} loading={loading}>刷新</Button>
          <Button icon={<IconDownload />} onClick={handleExport} disabled={!(result?.items?.length)}>导出 CSV</Button>
        </Space>
      </div>
      )}

      <Card style={{ marginBottom: 16 }}>
        <Space size="large" wrap>
          <span>日期范围：</span>
          <RangePicker
            value={[dateRange[0], dateRange[1]] as any}
            onChange={(_, ds) => ds[0] && ds[1] && setDateRange([ds[0].format('YYYY-MM-DD'), ds[1].format('YYYY-MM-DD')])}
            style={{ width: 280 }}
          />
          <span>统计维度：</span>
          <Radio.Group value={dimension} onChange={(v) => setDimension(v as any)}>
            <Radio value="project">按项目</Radio>
            <Radio value="account">按账号</Radio>
          </Radio.Group>
          <Text type="secondary" style={{ fontSize: 13 }}>
            合计消耗 <Text bold style={{ color: 'rgb(var(--danger-6))' }}>{totalConsumed}</Text> 积分 · {totalCount} 次任务
          </Text>
          {embedded && (
            <>
              <Button icon={<IconRefresh />} onClick={load} loading={loading}>刷新</Button>
              <Button icon={<IconDownload />} onClick={handleExport} disabled={!(result?.items?.length)}>导出 CSV</Button>
            </>
          )}
        </Space>
      </Card>

      <Card title={`积分消耗${dimension === 'project' ? '(按项目)' : '(按账号)'}（${result?.items?.length || 0} 条）`}>
        {loading ? <Spin dot style={{ display: 'block', margin: '20px auto' }} /> :
         !result?.items?.length ? <Empty description="该范围内暂无消耗记录" /> :
         <Table size="small" rowKey={dimension === 'project' ? 'project_id' : 'user_id'}
           pagination={result.items.length > 20 ? { pageSize: 20, showTotal: true } : false}
           data={result.items} columns={columns} />
        }
      </Card>
    </div>
  )
}

export default TeamCreditsPage
