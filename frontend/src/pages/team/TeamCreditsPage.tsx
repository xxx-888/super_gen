/**
 * TeamCreditsPage - 积分统计 (M2)
 *
 * 按日期范围 + 维度(项目/账号)筛选, 展示积分消耗明细.
 */
import React, { useEffect, useState } from 'react'
import { Card, Spin, Table, Typography, DatePicker, Radio, Space, Empty } from '@arco-design/web-react'
import { teamService } from '@/api/services'
import { useTeamStore } from '@/stores'
import dayjs from 'dayjs'

const { Title } = Typography
const { RangePicker } = DatePicker

const TeamCreditsPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const [loading, setLoading] = useState(false)
  const [dimension, setDimension] = useState<'project' | 'account'>('project')
  const [dateRange, setDateRange] = useState<[string, string]>([
    dayjs().subtract(30, 'day').format('YYYY-MM-DD'),
    dayjs().format('YYYY-MM-DD'),
  ])
  const [result, setResult] = useState<any>(null)

  useEffect(() => {
    if (!currentOrg) return
    const load = async () => {
      setLoading(true)
      try {
        const res: any = await teamService.creditStats(currentOrg.id, {
          start_date: dateRange[0], end_date: dateRange[1], dimension,
        })
        setResult(res?.data ?? res)
      } catch { /* ignore */ } finally { setLoading(false) }
    }
    load()
  }, [currentOrg, dimension, dateRange])

  const columns = dimension === 'project'
    ? [
        { title: '排名', render: (_v: any, _r: any, i: number) => `#${i + 1}`, width: 70 },
        { title: '项目名称', dataIndex: 'name' },
        { title: '状态', dataIndex: 'status', render: (v: string) => v || '-' },
        { title: '消耗积分', dataIndex: 'consumed', render: (v: number) => <b style={{ color: 'rgb(var(--danger-6))' }}>{v}</b> },
        { title: '任务次数', dataIndex: 'count' },
      ]
    : [
        { title: '排名', render: (_v: any, _r: any, i: number) => `#${i + 1}`, width: 70 },
        { title: '成员', dataIndex: 'name' },
        { title: '消耗积分', dataIndex: 'consumed', render: (v: number) => <b style={{ color: 'rgb(var(--danger-6))' }}>{v}</b> },
        { title: '任务次数', dataIndex: 'count' },
      ]

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>积分统计</Title>

      <Card style={{ marginBottom: 16 }}>
        <Space size="large">
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
        </Space>
      </Card>

      <Card title={`积分消耗${dimension === 'project' ? '(按项目)' : '(按账号)'}`}>
        {loading ? <Spin dot style={{ display: 'block', margin: '20px auto' }} /> :
         !result?.items?.length ? <Empty description="该范围内暂无消耗记录" /> :
         <Table size="small" rowKey={dimension === 'project' ? 'project_id' : 'user_id'} pagination={false} data={result.items} columns={columns} />
        }
      </Card>
    </div>
  )
}

export default TeamCreditsPage
