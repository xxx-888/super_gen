/**
 * WizardAgentModal - 剧本驱动 4 阶段 Agent 向导（对标巨日禄 Agent）
 *
 * 流程：输入剧本 → 资产详情 → 分镜管理 → 视频编辑
 * - 阶段1：选模式 + 粘贴剧本 → 调 /wizard/start 自动解析
 * - 阶段2：展示解析出的角色/场景/物品，每项可从素材库选资源（复用 MaterialPickerModal）
 * - 阶段3：展示自动拆的分镜（时长/空间/角色姿态/运镜/旁白），可编辑/删除
 * - 阶段4：表格化管理，一键生成全部视频
 *
 * 任务持久化在后端 Episode.meta.wizard_stage，关闭重开能恢复到上次阶段。
 */
import React, { useState, useEffect, useCallback } from 'react'
import {
  Modal, Steps, Button, Space, Input, Radio, Message, Spin, Empty, Tag,
  Card, Grid, Typography, Select, Tabs, Table, Popconfirm, Tooltip,
} from '@arco-design/web-react'
import {
  IconFile, IconUser, IconVideoCamera, IconEdit, IconLeft, IconRight,
  IconThunderbolt, IconRefresh, IconImage, IconCheckCircle, IconCloseCircle,
  IconDelete, IconPlus, IconStorage, IconClockCircle, IconDownload,
} from '@arco-design/web-react/icon'
import { episodeService } from '@/api/services'
import MaterialPickerModal from '@/components/material/MaterialPickerModal'

const { Step } = Steps
const { Text, Title, Paragraph } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

const STAGES = [
  { key: 'script_input', label: '输入剧本', icon: <IconFile />, desc: '粘贴整集剧本并选择生成模式' },
  { key: 'assets', label: '资产详情', icon: <IconUser />, desc: '为解析出的角色/场景选择资源' },
  { key: 'scenes', label: '分镜管理', icon: <IconVideoCamera />, desc: '查看/编辑自动拆分的分镜' },
  { key: 'edit', label: '视频编辑', icon: <IconEdit />, desc: '一键生成全部视频' },
]

const MODES = [
  { value: 'fusion', label: '融生视频', desc: '从提示词直接生视频，速度最快' },
  { value: 'image_to_video', label: '图生视频', desc: '先生图再生视频，画面更精准' },
  { value: 'composite', label: '综合生视频', desc: '最完整（画面+角色+运镜）' },
  { value: 'ppt', label: '真人解说PPT', desc: '旁白+分页配图，弱化运动' },
]

export interface WizardAgentModalProps {
  visible: boolean
  projectId: string
  episodeId: string
  onCancel: () => void
  onCompleted?: () => void
}

const WizardAgentModal: React.FC<WizardAgentModalProps> = ({
  visible, projectId, episodeId, onCancel, onCompleted,
}) => {
  const [stage, setStage] = useState<string>('script_input')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<string>('fusion')
  const [scriptContent, setScriptContent] = useState('')
  const [wizardData, setWizardData] = useState<any>({
    characters: [], scenes: [], props: [], shots: [], asset_map: {}, source: null,
  })
  const [scenes, setScenes] = useState<any[]>([])  // 阶段4 从后端拉的分镜
  const [pickerTarget, setPickerTarget] = useState<{ key: string; type: 'character' | 'scene' | 'prop' } | null>(null)
  const [generating, setGenerating] = useState(false)

  const svc = React.useMemo(() => episodeService(projectId), [projectId])

  // 打开时恢复状态
  const loadState = useCallback(async () => {
    if (!episodeId) return
    try {
      const res: any = await svc.wizard(episodeId).get()
      const s = res?.data ?? res
      setStage(s.stage || 'script_input')
      setMode(s.mode || 'fusion')
      setWizardData({
        characters: s.characters || [],
        scenes: s.scenes || [],
        props: s.props || [],
        shots: s.shots || [],
        asset_map: s.asset_map || {},
        source: s.source,
      })
      if (s.has_script && !scriptContent) {
        // 不直接覆盖用户正在编辑的，仅当为空时回填
      }
    } catch { /* 忽略 */ }
  }, [svc, episodeId])

  useEffect(() => {
    if (visible) loadState()
  }, [visible, loadState])

  // 阶段1：开始解析
  const handleStart = async () => {
    if (!scriptContent.trim()) {
      Message.warning('请粘贴剧本内容')
      return
    }
    setLoading(true)
    try {
      const res: any = await svc.wizard(episodeId).start(scriptContent, mode)
      const r = res?.data ?? res
      Message.success(`解析完成：${r.characters?.length || 0} 角色，${r.scenes?.length || 0} 场景，${r.shots_count || 0} 分镜（${r.source === 'llm' ? 'LLM' : '正则兜底'}）`)
      await loadState()
      setStage('assets')
    } catch (e: any) {
      Message.error(e?.message || '解析失败')
    } finally {
      setLoading(false)
    }
  }

  // 阶段2：选择资源回调
  const handlePicked = (result: { resource_id: string; type: string }) => {
    if (!pickerTarget) return
    setWizardData((d: any) => ({
      ...d,
      asset_map: { ...d.asset_map, [pickerTarget.key]: { resource_id: result.resource_id, type: result.type } },
    }))
    setPickerTarget(null)
    Message.success('已关联资源')
  }

  // 阶段2 → 阶段3：保存资产 + 拆分镜
  const handleSaveAssetsAndSplit = async () => {
    setLoading(true)
    try {
      // 保存资产分配
      const assignments: Record<string, string> = {}
      Object.entries(wizardData.asset_map || {}).forEach(([k, v]: [string, any]) => {
        if (v?.resource_id) assignments[k] = v.resource_id
      })
      await svc.wizard(episodeId).saveAssets(assignments)
      // 拆分镜
      const res: any = await svc.wizard(episodeId).splitScenes()
      const r = res?.data ?? res
      Message.success(`已生成 ${r.count} 个分镜`)
      setStage('edit')
      await loadScenes()
    } catch (e: any) {
      Message.error(e?.message || '拆分镜失败')
    } finally {
      setLoading(false)
    }
  }

  // 阶段4：加载分镜列表
  const loadScenes = useCallback(async () => {
    try {
      const res: any = await svc.clips(episodeId)
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setScenes(list)
    } catch { /* 忽略 */ }
  }, [svc, episodeId])

  useEffect(() => {
    if (stage === 'edit') loadScenes()
  }, [stage, loadScenes])

  // 阶段4：生成视频
  const handleGenerate = async (sceneIds?: string[]) => {
    setGenerating(true)
    try {
      const res: any = await svc.wizard(episodeId).generate(sceneIds, mode)
      const r = res?.data ?? res
      Message.success(`生成完成：${r.completed} 成功，${r.failed} 失败`)
      await loadScenes()
      onCompleted?.()
    } catch (e: any) {
      Message.error(e?.message || '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  // 步骤切换（点 Steps 顶部）
  const handleStepChange = async (newStage: string) => {
    // 进入新阶段前先持久化当前阶段
    try { await svc.wizard(episodeId).setStage(newStage) } catch { /* 忽略 */ }
    setStage(newStage)
    if (newStage === 'edit') loadScenes()
  }

  const currentStepIndex = Math.max(0, STAGES.findIndex(s => s.key === stage))

  // ==================== 阶段渲染 ====================
  const renderStage1 = () => (
    <div>
      <Text style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>选择生成模式</Text>
      <Radio.Group value={mode} onChange={(v: any) => setMode(v)} style={{ marginBottom: 16 }}>
        {MODES.map(m => (
          <Radio key={m.value} value={m.value}>
            <Space size={4}>
              <span style={{ fontWeight: 600 }}>{m.label}</span>
              <Text type="secondary" style={{ fontSize: 12 }}>{m.desc}</Text>
            </Space>
          </Radio>
        ))}
      </Radio.Group>

      <Text style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>粘贴整集剧本</Text>
      <Input.TextArea
        value={scriptContent}
        onChange={setScriptContent}
        placeholder={'在此粘贴一整集剧本内容...\n\nAgent 会自动：\n1. 提取所有角色（含外貌描述）\n2. 提取所有场景（含画面描述）\n3. 拆分成多个分镜（含时长/角色姿态/运镜/旁白）'}
        style={{ minHeight: 280, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.7 }}
        showWordLimit
        maxLength={6000}
      />
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {wizardData.source && <Tag size="small" color={wizardData.source === 'llm' ? 'arcoblue' : 'orange'}>上次解析：{wizardData.source === 'llm' ? 'LLM' : '正则兜底'}</Tag>}
        </Text>
        <Button type="primary" icon={<IconThunderbolt />} loading={loading} onClick={handleStart}>
          开始解析
        </Button>
      </div>
    </div>
  )

  const renderAssetCard = (item: any, type: 'character' | 'scene' | 'prop', label: string) => {
    const key = `${type}:${item.name}`
    const assigned = wizardData.asset_map?.[key]
    return (
      <Card key={key} size="small" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Space size={6}>
              <Tag size="small" color={type === 'character' ? 'purple' : type === 'scene' ? 'green' : 'orange'}>{label}</Tag>
              <Text style={{ fontWeight: 600 }}>{item.name}</Text>
              {assigned && <Tag size="small" color="arcoblue">✓ 已关联</Tag>}
            </Space>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4, marginLeft: 4 }}>
              {item.description || item.appearance_prompt || item.prompt || '无描述'}
            </Text>
          </div>
          <Button
            size="small"
            type={assigned ? 'outline' : 'primary'}
            icon={<IconStorage />}
            onClick={() => setPickerTarget({ key, type })}
          >
            {assigned ? '重选' : '选择资源'}
          </Button>
        </div>
      </Card>
    )
  }

  const renderStage2 = () => (
    <div>
      {loading ? <Spin dot style={{ display: 'block', margin: '40px auto' }} /> :
        (wizardData.characters.length === 0 && wizardData.scenes.length === 0 && wizardData.props.length === 0) ? (
        <Empty description="暂无解析数据，请先在阶段1解析剧本" style={{ padding: 40 }} />
      ) : (
        <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 8 }}>
          {wizardData.characters.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Title heading={6} style={{ marginBottom: 8 }}><IconUser /> 角色（{wizardData.characters.length}）</Title>
              {wizardData.characters.map((c: any) => renderAssetCard(c, 'character', '角色'))}
            </div>
          )}
          {wizardData.scenes.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Title heading={6} style={{ marginBottom: 8 }}><IconImage /> 场景（{wizardData.scenes.length}）</Title>
              {wizardData.scenes.map((s: any) => renderAssetCard(s, 'scene', '场景'))}
            </div>
          )}
          {wizardData.props.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Title heading={6} style={{ marginBottom: 8 }}><IconStorage /> 物品（{wizardData.props.length}）</Title>
              {wizardData.props.map((p: any) => renderAssetCard(p, 'prop', '物品'))}
            </div>
          )}
        </div>
      )}
    </div>
  )

  const renderStage3 = () => {
    const shots = wizardData.shots || []
    if (shots.length === 0) {
      return <Empty description="暂无分镜数据，请先完成解析" style={{ padding: 40 }} />
    }
    return (
      <div style={{ maxHeight: 460, overflowY: 'auto', paddingRight: 8 }}>
        {shots.map((shot: any, idx: number) => (
          <Card key={idx} size="small" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: '50%', background: 'rgb(var(--primary-6))', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                {shot.sequence || idx + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                  {shot.duration && <Tag size="small" color="arcoblue"><IconClockCircle /> {shot.duration}s</Tag>}
                  {shot.location && <Tag size="small" color="green">📍 {shot.location}</Tag>}
                  {shot.shot_type && <Tag size="small">{shot.shot_type}</Tag>}
                  {shot.camera_movement && shot.camera_movement !== '静止' && <Tag size="small" color="orange">🎥 {shot.camera_movement}</Tag>}
                  {shot.characters?.map((c: any, i: number) => (
                    <Tag key={i} size="small" color="purple">{c.name}{c.pose ? `·${c.pose.slice(0, 10)}` : ''}</Tag>
                  ))}
                </div>
                {shot.narration && (
                  <Paragraph style={{ fontSize: 12, color: 'var(--color-text-2)', margin: '4px 0', lineHeight: 1.6 }}>
                    {shot.narration}
                  </Paragraph>
                )}
                {shot.prompt && (
                  <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                    提示词：{shot.prompt.slice(0, 120)}{shot.prompt.length > 120 ? '...' : ''}
                  </Text>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    )
  }

  const renderStage4 = () => {
    const columns = [
      { title: '序号', dataIndex: 'sequence', width: 60, render: (v: number) => <Text bold>#{v}</Text> },
      {
        title: '已确认素材', dataIndex: 'thumbnail_url', width: 100,
        render: (v: string) => v
          ? <img src={v} alt="" style={{ width: 56, height: 32, objectFit: 'cover', borderRadius: 4 }} onError={(e) => (e.target as HTMLImageElement).style.opacity = '0.3'} />
          : <Tag size="small" color="gray">无</Tag>,
      },
      {
        title: '视频素材', dataIndex: 'generated_video_url', width: 100,
        render: (v: string) => v
          ? <video src={v} style={{ width: 56, height: 32, objectFit: 'cover', borderRadius: 4 }} muted />
          : <Tag size="small" color="gray">未生成</Tag>,
      },
      {
        title: '分镜提示词', dataIndex: 'prompt', ellipsis: true,
        render: (v: string) => <Text style={{ fontSize: 12 }}>{v?.slice(0, 80) || '空'}</Text>,
      },
      {
        title: '状态', dataIndex: 'status', width: 90,
        render: (v: string) => {
          const map: any = {
            completed: { color: 'green', icon: <IconCheckCircle /> },
            failed: { color: 'red', icon: <IconCloseCircle /> },
            generating: { color: 'orange', icon: <IconClockCircle /> },
            ready: { color: 'arcoblue' },
            pending: { color: 'gray' },
          }
          const m = map[v] || { color: 'gray' }
          return <Tag size="small" color={m.color}>{m.icon} {v}</Tag>
        },
      },
      {
        title: '操作', width: 120,
        render: (_: any, row: any) => (
          <Space size={4}>
            <Tooltip content="生成本镜">
              <Button size="mini" type="outline" icon={<IconVideoCamera />}
                loading={generating} disabled={row.status === 'completed'}
                onClick={() => handleGenerate([row.id])} />
            </Tooltip>
            {row.generated_video_url && (
              <Tooltip content="下载">
                <Button size="mini" type="text" icon={<IconDownload />} href={row.generated_video_url} target="_blank" />
              </Tooltip>
            )}
          </Space>
        ),
      },
    ]
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Text type="secondary">共 {scenes.length} 个分镜，{scenes.filter((s: any) => s.status === 'completed').length} 个已生成</Text>
          <Space>
            <Button icon={<IconRefresh />} onClick={loadScenes} size="small">刷新</Button>
            <Button type="primary" icon={<IconThunderbolt />} loading={generating} onClick={() => handleGenerate()}>
              一键生成全部
            </Button>
          </Space>
        </div>
        <Table
          columns={columns}
          data={scenes}
          rowKey="id"
          pagination={{ pageSize: 8 }}
          size="small"
        />
      </div>
    )
  }

  return (
    <Modal
      title={<Space><IconThunderbolt /> Agent 向导 — 剧本驱动视频生成</Space>}
      visible={visible}
      onCancel={onCancel}
      footer={null}
      style={{ width: 1100, top: 20 }}
      maskClosable={false}
    >
      {/* 顶部 Steps */}
      <Steps current={currentStepIndex} type="arrow" style={{ marginBottom: 24 }}>
        {STAGES.map((s, i) => (
          <Step
            key={s.key}
            title={<a onClick={() => handleStepChange(s.key)}>{s.label}</a>}
            description={s.desc}
          />
        ))}
      </Steps>

      {/* 当前阶段内容 */}
      <div style={{ minHeight: 380 }}>
        {stage === 'script_input' && renderStage1()}
        {stage === 'assets' && renderStage2()}
        {stage === 'scenes' && renderStage3()}
        {stage === 'edit' && renderStage4()}
      </div>

      {/* 底部导航 */}
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-fill-2)', display: 'flex', justifyContent: 'space-between' }}>
        <Button
          icon={<IconLeft />}
          disabled={currentStepIndex === 0}
          onClick={() => handleStepChange(STAGES[Math.max(0, currentStepIndex - 1)].key)}
        >
          上一步
        </Button>
        <Space>
          {stage === 'assets' && (
            <Button type="primary" icon={<IconRight />} loading={loading} onClick={handleSaveAssetsAndSplit}>
              保存并生成分镜
            </Button>
          )}
          {stage === 'scenes' && (
            <Button type="primary" icon={<IconRight />} onClick={() => handleStepChange('edit')}>
              进入视频编辑
            </Button>
          )}
          <Button onClick={onCancel}>关闭</Button>
        </Space>
      </div>

      {/* 素材库选择器（阶段2 复用） */}
      {pickerTarget && projectId && (
        <MaterialPickerModal
          visible={!!pickerTarget}
          classType={pickerTarget.type}
          projectId={projectId}
          onSelect={handlePicked}
          onCancel={() => setPickerTarget(null)}
        />
      )}
    </Modal>
  )
}

export default WizardAgentModal
