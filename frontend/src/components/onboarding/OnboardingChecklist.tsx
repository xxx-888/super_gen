/**
 * OnboardingChecklist - 新手任务清单卡（挂在工作台顶部）
 *
 * 三步任务（创建项目 / 完成剧本解析 / 发起一次生成）的完成状态由后端
 * 从真实创作数据推导（GET /onboarding/status），不会与实际进度脱节。
 * 全部完成或用户点「收起」后隐藏（dismiss 持久化到用户 onboarding 状态）。
 */
import React, { useState } from 'react'
import { Button, Card, Progress, Space, Typography } from '@arco-design/web-react'
import { IconCheckCircle, IconClose, IconThunderbolt } from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { templateService } from '@/api/services'

const { Text } = Typography

const TASKS = [
  { key: 'created_project', label: '创建第一个项目', hint: '空白新建，或克隆官方示例 / 挑一个题材剧本', to: '/templates' },
  { key: 'parsed_script', label: '完成一次剧本解析', hint: '剧本编辑器里点「AI 解析」，自动拆出分镜与角色', to: '/projects' },
  { key: 'first_generation', label: '发起第一次生成', hint: '分镜列表点「生成分镜图」，产出你的第一帧画面', to: '/projects' },
] as const

const OnboardingChecklist: React.FC<{
  checklist: Record<string, boolean>
  onDismiss: () => void
}> = ({ checklist, onDismiss }) => {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const done = TASKS.filter((t) => checklist?.[t.key]).length
  if (done === TASKS.length) return null

  const handleDismiss = async () => {
    if (busy) return
    setBusy(true)
    try { await templateService.dismissOnboarding('checklist') } catch { /* 忽略 */ }
    onDismiss()
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <IconThunderbolt style={{ fontSize: 20, color: 'rgb(var(--orange-6))' }} />
        <Text style={{ fontWeight: 600, fontSize: 15 }}>新手三步，做出你的第一支片</Text>
        <Button
          size="mini" type="text" icon={<IconClose />} style={{ marginLeft: 'auto' }}
          onClick={handleDismiss}
        >收起</Button>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {TASKS.map((t, i) => {
          const ok = !!checklist?.[t.key]
          return (
            <div
              key={t.key}
              onClick={() => !ok && navigate(t.to)}
              style={{
                flex: '1 1 220px', minWidth: 220, cursor: ok ? 'default' : 'pointer',
                padding: '10px 14px', borderRadius: 8,
                background: ok ? 'rgb(var(--success-1))' : 'var(--color-fill-2)',
                border: `1px solid ${ok ? 'rgb(var(--success-3))' : 'transparent'}`,
                opacity: ok ? 0.85 : 1,
              }}
            >
              <Space size={8}>
                <IconCheckCircle style={{ color: ok ? 'rgb(var(--success-6))' : 'var(--color-text-4)', fontSize: 18 }} />
                <Text style={{ fontWeight: 600, textDecoration: ok ? 'line-through' : 'none' }}>
                  {i + 1}. {t.label}
                </Text>
              </Space>
              <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 6, paddingLeft: 26 }}>{t.hint}</div>
            </div>
          )
        })}
      </div>
      <Progress
        percent={done / TASKS.length}
        showText={false}
        color="rgb(var(--success-6))"
        style={{ marginTop: 12 }}
      />
    </Card>
  )
}

export default OnboardingChecklist
