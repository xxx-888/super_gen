/**
 * DashboardPage - 工作台/仪表盘（用户侧）
 *
 * 数据来自 /dashboard/summary 聚合接口（按当前用户统计）：
 * 项目/分镜/任务统计、近 7 日生成趋势、进行中任务（真实数据）、
 * 团队积分余额与最近流水。
 */
import React, { useEffect, useState } from 'react'
import {
  Card, Grid, Typography, Space, Button, Empty, Tag, Tooltip, Spin, Progress,
} from '@arco-design/web-react'
import {
  IconFile, IconVideoCamera, IconApps, IconPlus, IconFolder, IconGift,
  IconMindMapping, IconStorage, IconPlayCircle,
} from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { apiClient } from '@/api/client'
import { templateService } from '@/api/services'
import { useTeamStore } from '@/stores'
import { useCurrentUser } from '@/utils/auth'
import { PROJECT_STATUS, TASK_STATUS, statusColor, statusLabel } from '@/utils/statusLabels'
import DailyBars from '@/components/charts/DailyBars'
import OnboardingTour, { type TourStep } from '@/components/onboarding/OnboardingTour'
import OnboardingChecklist from '@/components/onboarding/OnboardingChecklist'

const { Title, Text } = Typography
const { Row, Col } = Grid

const TASK_TYPE_LABEL: Record<string, string> = {
  video: '视频', image: '图片', audio: '音频', script_parse: '剧本解析',
  remove_subtitle: '去字幕', subtitle: '字幕', script_upload: '剧本导入', video_edit: '视频剪辑',
}

/** 统计卡（带底部次行说明，可点击跳转） */
const StatCard = ({ title, value, icon, sub, onClick }: {
  title: string; value: React.ReactNode; icon?: React.ReactNode; sub?: React.ReactNode; onClick?: () => void
}) => (
  <Card style={{ marginBottom: 16, cursor: onClick ? 'pointer' : 'default' }} onClick={onClick}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {icon}
      <Text type="secondary" style={{ fontSize: 13 }}>{title}</Text>
    </div>
    <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8, lineHeight: 1.2 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{sub}</div>}
  </Card>
)

const DashboardPage: React.FC = () => {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const { currentOrg } = useTeamStore()
  const currentUser = useCurrentUser()

  // ---- 新手引导（M9）：无项目的新用户弹聚光灯 tour；任务清单卡未完成/未收起时常驻 ----
  const [obStatus, setObStatus] = useState<any>(null)
  const [showTour, setShowTour] = useState(false)

  useEffect(() => {
    loadDashboardData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id])

  const loadDashboardData = async () => {
    setLoading(true)
    let fresh: any = null
    try {
      fresh = await apiClient.get('/dashboard/summary', {
        params: currentOrg?.id ? { org_id: currentOrg.id } : {},
      })
      setSummary(fresh || {})
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
    // 新手引导状态：清单进度总要看（已完成的用户后端推导为全勾，卡片自动隐藏）；
    // 聚光灯 tour 只对「还没有项目且没看过 tour」的用户弹
    try {
      const st: any = await templateService.onboardingStatus()
      if (st) {
        setObStatus(st)
        if (!st.tour_done && (fresh?.total_projects ?? 0) === 0) setShowTour(true)
      }
    } catch { /* 引导失败不阻塞页面 */ }
  }

  // 聚焦回来（刚建完项目/跑完生成回来）时静默刷新清单进度
  useEffect(() => {
    const onFocus = async () => {
      if (!obStatus || obStatus.checklist_dismissed) return
      try {
        const st: any = await templateService.onboardingStatus()
        if (st) setObStatus(st)
      } catch { /* 忽略 */ }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obStatus])

  const finishTour = async () => {
    setShowTour(false)
    try { await templateService.dismissOnboarding('tour') } catch { /* 忽略 */ }
    setObStatus((s: any) => s ? { ...s, tour_done: true } : s)
    navigate('/templates')
  }

  const skipTour = async () => {
    setShowTour(false)
    try { await templateService.dismissOnboarding('tour') } catch { /* 忽略 */ }
    setObStatus((s: any) => s ? { ...s, tour_done: true } : s)
  }

  const tourSteps: TourStep[] = [
    {
      title: `欢迎来到 SceneGen，${currentUser?.nickname || '创作者'}`,
      content: <>这里是你的工作台。做出第一支 AI 短剧只需要三步：<b>建项目 → 解析剧本 → 生成画面</b>。跟着走，一分钟上车。</>,
    },
    {
      selector: '#ob-create',
      title: '创建项目，从这里开始',
      content: <>点「新建项目」从零开始，或点「从模板开始」——官方示例自带完整剧本和分镜提示词，<b>一键克隆</b>就能直接体验生成。</>,
    },
    {
      selector: '#ob-recent',
      title: '项目都在这里',
      content: <>之后所有项目会集中在「最近项目」与项目管理页，随时续作。</>,
    },
    {
      selector: '#ob-nav',
      title: '创作工具箱',
      content: <>画布（节点式创作）、素材库、作品画廊都在快捷导航里，等你的项目成型后一一解锁。</>,
      nextText: '去模板库',
    },
    {
      title: '准备好了就出发',
      content: <>完成新手三步（建项目、解析剧本、发起生成），你的第一支片就诞生了。现在，先去模板库挑一个喜欢的题材？</>,
    },
  ]

  const credits = summary?.credits || {}
  const runningTasks = summary?.running_tasks || []
  const recentProjects = summary?.recent_projects || []
  const recentTxs = credits.recent_transactions || []

  return (
    <div className="page-container">
      {/* 页面头部 */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title heading={5} style={{ margin: 0 }}>工作台</Title>
          <Text type="secondary">欢迎回来，开始创作你的AI短剧</Text>
        </div>
        <div id="ob-create">
          <Space size={8}>
            <Button icon={<IconGift />} onClick={() => navigate('/templates')}>从模板开始</Button>
            <Button type="primary" icon={<IconPlus />} onClick={() => navigate('/projects')}>新建项目</Button>
          </Space>
        </div>
      </div>

      {/* 新手任务清单（全部完成或收起后不再渲染） */}
      {obStatus && !obStatus.checklist_dismissed && obStatus.checklist
        && Object.values(obStatus.checklist).some((v) => !v) && (
        <OnboardingChecklist
          checklist={obStatus.checklist}
          onDismiss={() => setObStatus({ ...obStatus, checklist_dismissed: true })}
        />
      )}

      <OnboardingTour steps={tourSteps} visible={showTour} onDone={finishTour} onSkip={skipTour} />

      {loading ? (
        <Card><div style={{ textAlign: 'center', padding: 60 }}><Spin size={28} /></div></Card>
      ) : (
        <>
          {/* 第一排：核心统计 */}
          <Row gutter={16}>
            <Col span={6}>
              <StatCard title="我的项目" value={summary?.total_projects ?? 0}
                sub={`共 ${summary?.total_scenes ?? 0} 个分镜`}
                icon={<IconFolder style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />}
                onClick={() => navigate('/projects')} />
            </Col>
            <Col span={6}>
              <StatCard title="生成任务" value={summary?.total_tasks ?? 0}
                sub={summary?.task_success_rate != null ? `成功率 ${summary.task_success_rate}%` : '暂无已完成样本'}
                icon={<IconApps style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />} />
            </Col>
            <Col span={6}>
              <StatCard title="已生成视频" value={summary?.videos_generated ?? 0}
                sub={`完成 ${summary?.tasks_by_status?.completed ?? 0} / 失败 ${summary?.tasks_by_status?.failed ?? 0}`}
                icon={<IconVideoCamera style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />} />
            </Col>
            <Col span={6}>
              <StatCard title="积分余额"
                value={credits.balance != null ? credits.balance : '-'}
                sub={currentOrg ? `${currentOrg.name || '当前团队'} 账户` : '未选择团队'}
                icon={<IconGift style={{ fontSize: 22, color: 'rgb(var(--gold-6))' }} />}
                onClick={() => navigate('/credits')} />
            </Col>
          </Row>

          {/* 第二排：生成趋势 + 积分近况 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={14}>
              <Card title="近 7 日生成趋势" style={{ height: '100%' }}
                extra={<Space size={12}>
                  <Space size={4}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'rgb(var(--arcoblue-5))', display: 'inline-block' }} /><Text type="secondary" style={{ fontSize: 12 }}>总量</Text></Space>
                  <Space size={4}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'rgb(var(--danger-6))', display: 'inline-block' }} /><Text type="secondary" style={{ fontSize: 12 }}>失败</Text></Space>
                </Space>}>
                <DailyBars data={summary?.tasks_daily} />
              </Card>
            </Col>
            <Col span={10}>
              <Card title="积分近况" style={{ height: '100%' }}
                extra={<Button size="small" onClick={() => navigate('/credits')}>明细</Button>}>
                {recentTxs.length
                  ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {recentTxs.map((t: any, i: number) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <Space size={8} style={{ minWidth: 0 }}>
                            <Tag size="small" color={t.amount >= 0 ? 'green' : 'orange'}>{t.type_label}</Tag>
                            <Text ellipsis style={{ fontSize: 12, maxWidth: 140 }}>{t.remark || '-'}</Text>
                          </Space>
                          <Space size={8}>
                            <Text style={{ fontSize: 12, fontWeight: 600, color: t.amount >= 0 ? 'rgb(var(--success-6))' : 'rgb(var(--warning-6))' }}>
                              {t.amount >= 0 ? '+' : ''}{t.amount}
                            </Text>
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {t.created_at ? new Date(t.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                            </Text>
                          </Space>
                        </div>
                      ))}
                    </div>
                  )
                  : <Empty description="暂无积分流水" />}
              </Card>
            </Col>
          </Row>

          {/* 第三排：最近项目 + 快捷导航/进行中任务 */}
          <Row gutter={16}>
            <Col span={16}>
              <div id="ob-recent" style={{ height: '100%' }}>
              <Card title="最近项目"
                extra={<Button size="small" onClick={() => navigate('/projects')}>全部项目</Button>}>
                {recentProjects.length === 0
                  ? <Empty description="还没有项目，点击右上角「新建项目」开始创作" />
                  : (
                    <Space direction="vertical" style={{ width: '100%' }} size="small">
                      {recentProjects.map((p: any) => (
                        <div key={p.id} onClick={() => navigate(`/projects/${p.id}`)} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '10px 12px', background: 'var(--color-fill-2)', borderRadius: 6, cursor: 'pointer',
                        }}>
                          <Space>
                            <IconFile style={{ color: 'rgb(var(--primary-6))' }} />
                            <Text style={{ fontWeight: 500 }}>{p.name}</Text>
                          </Space>
                          <Space size={10}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {p.updated_at ? new Date(p.updated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                            </Text>
                            <Tag size="small" color={statusColor(p.status, PROJECT_STATUS)}>
                              {statusLabel(p.status, PROJECT_STATUS)}
                            </Tag>
                          </Space>
                        </div>
                      ))}
                    </Space>
                  )}
              </Card>
              </div>
            </Col>
            <Col span={8}>
              <div id="ob-nav">
              <Card title="快捷导航">
                <Space direction="vertical" style={{ width: '100%' }} size="medium">
                  <Button long type="primary" icon={<IconFolder />} onClick={() => navigate('/projects')}>我的项目</Button>
                  <Button long type="outline" icon={<IconMindMapping />} onClick={() => navigate('/canvas')}>我的画布</Button>
                  <Button long type="outline" icon={<IconStorage />} onClick={() => navigate('/resources')}>素材库</Button>
                  <Button long icon={<IconPlayCircle />} onClick={() => navigate('/videos')}>作品画廊</Button>
                </Space>
              </Card>
              </div>

              <Card title="进行中的任务" style={{ marginTop: 16 }}
                extra={<Tooltip content="生成任务由各项目的分镜/画布提交"><span style={{ cursor: 'help', fontSize: 12, color: 'var(--color-text-3)' }}>?</span></Tooltip>}>
                {runningTasks.length > 0
                  ? (
                    <Space direction="vertical" style={{ width: '100%' }} size="medium">
                      {runningTasks.map((t: any) => (
                        <div key={t.id}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <Space size={6}>
                              <Tag size="small" color={statusColor(t.status, TASK_STATUS)}>
                                {TASK_TYPE_LABEL[t.type] || t.type}
                              </Tag>
                              {t.model && <Text type="secondary" ellipsis style={{ fontSize: 11, maxWidth: 120 }}>{t.model}</Text>}
                            </Space>
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {t.created_at ? new Date(t.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}
                            </Text>
                          </div>
                          <Progress percent={t.status === 'pending' ? 0 : (t.progress || 5) / 100} showText={false}
                            status={t.status === 'failed' ? 'error' : 'normal'}
                            color={t.status === 'pending' ? 'rgb(var(--gray-5))' : undefined} />
                        </div>
                      ))}
                    </Space>
                  )
                  : <Empty description="暂无进行中的任务" />}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  )
}

export default DashboardPage
