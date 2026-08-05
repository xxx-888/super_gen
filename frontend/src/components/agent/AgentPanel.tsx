/**
 * AgentPanel - AI Agent 创作面板（对标巨日禄 Agent 模式）
 *
 * 用户给自然语言目标 → Agent 自动编排：查素材库 / 新建资源 / 生图 / 生视频 / 建分镜
 *
 * 布局：
 * - 顶部：目标输入框 + 元素类型多选 + 镜头类型 + "Agent 生成"按钮
 * - 中部：运行步骤列表（每步：工具名 + 状态 + 产出缩略图）
 * - 底部：对话调优区（简化聊天框，发指令微调）
 *
 * 说明：当前后端为骨架，产出可能是 placeholder URL；接通真实模型 API 后即产出真实结果。
 */
import React, { useState, useCallback, useRef } from 'react'
import {
  Card, Input, Button, Space, Tag, Message, Spin, Empty, Grid, Typography,
  Select, Checkbox, Timeline,
} from '@arco-design/web-react'
import {
  IconRobot, IconThunderbolt, IconSearch, IconImage, IconVideoCamera,
  IconPlus, IconCheckCircle, IconCloseCircle, IconClockCircle, IconSend,
  IconBulb,
} from '@arco-design/web-react/icon'
import { episodeService } from '@/api/services'
import { SHOT_TYPES } from '@/types'

const { Text, Paragraph } = Typography
const { Row, Col } = Grid

const TOOL_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  search_materials: { label: '搜索素材库', icon: <IconSearch />, color: 'arcoblue' },
  create_resource: { label: '新建资源', icon: <IconPlus />, color: 'purple' },
  generate_image: { label: '生成图片', icon: <IconImage />, color: 'green' },
  generate_video: { label: '生成视频', icon: <IconVideoCamera />, color: 'orange' },
  create_scene: { label: '创建分镜', icon: <IconThunderbolt />, color: 'cyan' },
}

const STATUS_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  completed: { label: '完成', color: 'rgb(var(--success-6))', icon: <IconCheckCircle /> },
  failed: { label: '失败', color: 'rgb(var(--danger-6))', icon: <IconCloseCircle /> },
  running: { label: '运行中', color: 'rgb(var(--warning-6))', icon: <IconClockCircle /> },
  skipped: { label: '跳过', color: 'var(--color-text-3)', icon: <IconClockCircle /> },
  pending: { label: '等待', color: 'var(--color-text-3)', icon: <IconClockCircle /> },
}

const ELEMENT_OPTIONS = [
  { label: '角色', value: 'character' },
  { label: '场景', value: 'scene' },
  { label: '物品', value: 'prop' },
]

const PRESET_GOALS = [
  '生成主角走进阳光咖啡厅的5秒镜头，氛围温暖',
  '一对情侣在雨中撑伞对话，特写镜头',
  '城市夜景街道空镜，镜头缓缓推进',
]

export interface AgentPanelProps {
  projectId: string
  episodeId: string
  onCompleted?: () => void
}

interface RunStep {
  step: number
  tool: string
  status: string
  args?: Record<string, any>
  output?: Record<string, any>
  error?: string
  artifact_url?: string
  task_id?: string
}

const AgentPanel: React.FC<AgentPanelProps> = ({ projectId, episodeId, onCompleted }) => {
  const [goal, setGoal] = useState('')
  const [shotType, setShotType] = useState('对话场景')
  const [elementTypes, setElementTypes] = useState<string[]>(['character', 'scene'])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [refineInput, setRefineInput] = useState('')
  const timerRef = useRef<any>(null)

  const svc = React.useMemo(() => episodeService(projectId), [projectId])

  const handleRun = useCallback(async (goalText: string, isRefine = false) => {
    if (!goalText.trim()) {
      Message.warning('请输入目标描述')
      return
    }
    setRunning(true)
    setResult(null)
    try {
      const options: Record<string, any> = {
        shot_type: shotType,
        element_types: elementTypes,
        size: '16:9',
        refine: isRefine,
      }
      const res: any = await svc.agent(episodeId).run(goalText, options)
      const r = res?.data ?? res
      setResult(r)
      Message.success(`Agent 完成（${r.steps?.length || 0} 步，产出 ${r.artifacts?.length || 0} 项）`)
      if (r.agent_run_id) {
        // 轮询最新状态（骨架版同步返回已完成，这里仅作刷新确认）
        pollStatus(r.agent_run_id)
      }
      onCompleted?.()
    } catch (e: any) {
      Message.error(e?.message || 'Agent 运行失败')
    } finally {
      setRunning(false)
    }
  }, [svc, episodeId, shotType, elementTypes, onCompleted])

  const pollStatus = useCallback(async (runId: string) => {
    try {
      const res: any = await svc.agent(episodeId).status(runId)
      const s = res?.data ?? res
      if (s && result) {
        setResult({ ...result, _status: s })
      }
    } catch {
      // 忽略轮询错误
    }
  }, [svc, episodeId, result])

  const handleRefine = () => {
    if (!refineInput.trim()) return
    handleRun(refineInput, true)
    setRefineInput('')
  }

  const renderStep = (s: RunStep) => {
    const toolMeta = TOOL_LABELS[s.tool] || { label: s.tool, icon: <IconRobot />, color: 'gray' }
    const statusMeta = STATUS_META[s.status] || STATUS_META.pending
    return (
      <div key={s.step} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
        <div style={{ flexShrink: 0, width: 24, height: 24, borderRadius: '50%', background: 'var(--color-fill-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>
          {s.step + 1}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Tag size="small" color={toolMeta.color}>{toolMeta.icon} {toolMeta.label}</Tag>
            <span style={{ color: statusMeta.color, fontSize: 12 }}>{statusMeta.icon} {statusMeta.label}</span>
          </div>
          {s.args && Object.keys(s.args).length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              参数: {JSON.stringify(s.args).slice(0, 120)}
            </Text>
          )}
          {s.error && (
            <Text style={{ fontSize: 12, color: 'rgb(var(--danger-6))', display: 'block' }}>⚠ {s.error}</Text>
          )}
          {s.output?.items && s.output.items.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              找到 {s.output.count} 个素材: {s.output.items.slice(0, 3).map((i: any) => i.name).join('、')}
              {s.output.count > 3 ? '...' : ''}
            </Text>
          )}
          {s.artifact_url && (
            <div style={{ marginTop: 6 }}>
              <img
                src={s.artifact_url}
                alt="产出"
                style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--color-border)' }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* 表单触发区 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Text style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
          <IconRobot /> Agent 目标描述
        </Text>
        <Input.TextArea
          value={goal}
          onChange={setGoal}
          placeholder="用自然语言描述你想生成的视频片段，例如：生成主角走进阳光咖啡厅的5秒镜头，氛围温暖"
          autoSize={{ minRows: 2, maxRows: 4 }}
          style={{ marginBottom: 8 }}
        />
        {/* 快捷模板 */}
        <Space wrap size={4} style={{ marginBottom: 8 }}>
          {PRESET_GOALS.map((g) => (
            <Button
              key={g}
              size="mini"
              type="text"
              icon={<IconBulb />}
              onClick={() => setGoal(g)}
            >
              {g.length > 16 ? g.slice(0, 16) + '...' : g}
            </Button>
          ))}
        </Space>

        <Row gutter={12} style={{ marginBottom: 8 }}>
          <Col span={12}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>镜头类型</Text>
            <Select value={shotType} onChange={setShotType} size="small" style={{ width: '100%' }}>
              {SHOT_TYPES.map((s) => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>
          </Col>
          <Col span={12}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>需要的元素类型</Text>
            <Checkbox.Group value={elementTypes} onChange={(v: any) => setElementTypes(v as string[])}>
              {ELEMENT_OPTIONS.map((o) => <Checkbox key={o.value} value={o.value}>{o.label}</Checkbox>)}
            </Checkbox.Group>
          </Col>
        </Row>

        <Button
          type="primary"
          long
          loading={running}
          icon={<IconThunderbolt />}
          onClick={() => handleRun(goal)}
        >
          {running ? 'Agent 运行中...' : 'Agent 一键生成'}
        </Button>
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4, textAlign: 'center' }}>
          Agent 会自动查素材库、补齐资源、生图、建分镜（骨架模式，产出可能为占位）
        </Text>
      </Card>

      {/* 运行结果 */}
      {running && !result && (
        <Card size="small"><Spin dot style={{ display: 'block', margin: '20px auto' }} tip="Agent 思考中..." /></Card>
      )}

      {result && (
        <Card
          size="small"
          title={
            <Space>
              <span>Agent 运行结果</span>
              <Tag size="small" color={result.status === 'completed' ? 'green' : result.status === 'partial' ? 'orange' : 'gray'}>
                {result.status === 'completed' ? '全部成功' : result.status === 'partial' ? '部分成功' : result.status}
              </Tag>
              {result.llm_used && <Tag size="small" color="arcoblue">LLM决策</Tag>}
            </Space>
          }
          style={{ marginBottom: 12 }}
        >
          {result.steps?.length > 0 ? (
            <div>{result.steps.map(renderStep)}</div>
          ) : (
            <Empty description="无执行步骤" />
          )}
          {result.artifacts?.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-fill-2)' }}>
              <Text style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>
                产出素材 ({result.artifacts.length})
              </Text>
              <Row gutter={[6, 6]}>
                {result.artifacts.map((a: any, i: number) => (
                  <Col key={i} span={6}>
                    <div style={{
                      aspectRatio: '1/1', background: 'var(--color-fill-3)', borderRadius: 6,
                      overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <img src={a.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => {
                          const t = e.target as HTMLImageElement
                          t.style.display = 'none'
                          const p = t.parentElement; if (p) p.innerHTML = '<span style="font-size:11px;color:var(--color-text-3)">占位</span>'
                        }}
                      />
                    </div>
                  </Col>
                ))}
              </Row>
            </div>
          )}
        </Card>
      )}

      {/* 对话调优区 */}
      {result && (
        <Card size="small" title={<span><IconRobot /> 对话调优</span>}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            可以继续发指令微调，例如："把主角衣服改成红色"、"换成夜晚场景"
          </Text>
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <Input
              value={refineInput}
              onChange={setRefineInput}
              placeholder="输入调优指令..."
              onPressEnter={handleRefine}
              style={{ flex: 1 }}
            />
            <Button type="primary" icon={<IconSend />} onClick={handleRefine} loading={running} />
          </div>
        </Card>
      )}
    </div>
  )
}

export default AgentPanel
