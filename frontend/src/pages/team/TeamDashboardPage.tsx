/**
 * TeamDashboardPage - 数据看板 (M2)
 *
 * 概览卡片 + 近14天积分消耗趋势(SVG柱状图) + 项目/人员积分消耗排行
 */
import React, { useEffect, useState } from 'react'
import { Card, Spin, Statistic, Grid, Table, Tag, Typography, Empty, Radio, Tabs } from '@arco-design/web-react'
import { IconFolder, IconGift, IconUser, IconFire } from '@arco-design/web-react/icon'
import { teamService } from '@/api/services'
import { useTeamStore } from '@/stores'
import TeamCreditsPage from './TeamCreditsPage'

const { Title, Text } = Typography
const { Row, Col } = Grid

const TrendChart: React.FC<{ data: Array<{ date: string; consumed: number }> }> = ({ data }) => {
  if (!data || data.length === 0) return <Empty description="暂无数据" />
  const max = Math.max(...data.map((d) => d.consumed), 1)
  const barWidth = 100 / data.length
  const height = 180

  return (
    <div>
      <svg width="100%" height={height + 30} style={{ display: 'block' }}>
        {data.map((d, i) => {
          const h = (d.consumed / max) * height
          const x = i * barWidth
          return (
            <g key={i}>
              <rect
                x={x + barWidth * 0.15} y={height - h}
                width={barWidth * 0.7} height={h}
                fill="rgb(var(--primary-6))" rx={2}
              />
              <text x={x + barWidth / 2} y={height + 14} textAnchor="middle" fontSize={9} fill="var(--color-text-3)">
                {d.date.slice(5)}
              </text>
            </g>
          )
        })}
      </svg>
      <div style={{ textAlign: 'center', color: 'var(--color-text-3)', fontSize: 12, marginTop: 4 }}>
        消耗积分峰值: {max}
      </div>
    </div>
  )
}

const TeamDashboardPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(14)
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    if (!currentOrg) return
    const load = async () => {
      setLoading(true)
      try {
        const res: any = await teamService.dashboard(currentOrg.id, days)
        setData(res?.data ?? res)
      } catch { /* ignore */ } finally { setLoading(false) }
    }
    load()
  }, [currentOrg, days])

  const { overview, credit_trend, project_ranking, member_ranking } = data || {}

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title heading={5} style={{ margin: 0 }}>数据看板</Title>
        <Radio.Group
          type="button" size="small" value={days}
          onChange={(v) => setDays(Number(v))}
        >
          <Radio value={7}>近 7 天</Radio>
          <Radio value={14}>近 14 天</Radio>
          <Radio value={30}>近 30 天</Radio>
        </Radio.Group>
      </div>

      <Tabs activeTab={tab} onChange={setTab}>
        <Tabs.TabPane key="overview" title="概览">
      {loading ? <Spin dot style={{ display: 'block', margin: '40px auto' }} /> :
       !data ? <Empty description="暂无数据" /> : (
        <>
      {/* 概览卡片 */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        <Col span={6}><Card><Statistic title="项目总数" value={overview.project_count} prefix={<IconFolder />} /></Card></Col>
        <Col span={6}><Card><Statistic title="片段总数" value={overview.clip_count} /></Card></Col>
        <Col span={6}><Card><Statistic title="可用积分" value={overview.credit_balance} prefix={<IconGift />} styleValue={{ color: 'rgb(var(--success-6))' }} /></Card></Col>
        <Col span={6}><Card><Statistic title="累计消耗" value={overview.credit_consumed} prefix={<IconFire />} styleValue={{ color: 'rgb(var(--danger-6))' }} /></Card></Col>
      </Row>

      {/* 积分趋势 */}
      <Card title={`近 ${days} 天积分消耗趋势`} style={{ marginBottom: 20 }}>
        <TrendChart data={credit_trend} />
      </Card>

      {/* 排行榜 */}
      <Row gutter={16}>
        <Col span={12}>
          <Card title={<span><IconFolder /> 项目积分消耗排行</span>}>
            {project_ranking.length === 0 ? <Empty description="暂无消耗" /> : (
              <Table
                size="small" rowKey="project_id" pagination={false}
                data={project_ranking}
                columns={[
                  { title: '排名', dataIndex: '_rank', width: 60, render: (_v, _r, i) => <Text bold>#{i + 1}</Text> },
                  { title: '项目', dataIndex: 'name' },
                  { title: '消耗', dataIndex: 'consumed', width: 100, render: (v: number) => <Text style={{ color: 'rgb(var(--danger-6))' }}>{v}</Text> },
                ]}
              />
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title={<span><IconUser /> 人员积分消耗排行</span>}>
            {member_ranking.length === 0 ? <Empty description="暂无消耗" /> : (
              <Table
                size="small" rowKey="user_id" pagination={false}
                data={member_ranking}
                columns={[
                  { title: '排名', dataIndex: '_rank', width: 60, render: (_v, _r, i) => <Text bold>#{i + 1}</Text> },
                  { title: '成员', dataIndex: 'name' },
                  { title: '消耗', dataIndex: 'consumed', width: 100, render: (v: number) => <Text style={{ color: 'rgb(var(--danger-6))' }}>{v}</Text> },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>
        </>
      )}
        </Tabs.TabPane>
        {/* 积分明细统计（原独立「积分统计」页并入） */}
        <Tabs.TabPane key="credits" title="积分明细">
          <TeamCreditsPage embedded />
        </Tabs.TabPane>
      </Tabs>
    </div>
  )
}

export default TeamDashboardPage
