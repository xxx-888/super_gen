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
  InputNumber, Switch, Checkbox,
} from '@arco-design/web-react'
import {
  IconFile, IconUser, IconVideoCamera, IconEdit, IconLeft, IconRight,
  IconThunderbolt, IconRefresh, IconImage, IconCheckCircle, IconCloseCircle,
  IconDelete, IconPlus, IconStorage, IconClockCircle, IconDownload,
} from '@arco-design/web-react/icon'
import { episodeService, scriptService, creationService } from '@/api/services'
import MaterialPickerModal from '@/components/material/MaterialPickerModal'
import { truncatePromptText } from '@/utils/prompt'
import { getTaskPollTimeout } from '@/hooks/useSiteConfig'
import { ASPECT_RATIOS } from '@/types'

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
  const [scenes, setScenes] = useState<any[]>([])  // 阶段3/4 从后端拉的分镜
  const [pickerTarget, setPickerTarget] = useState<{ key: string; type: 'character' | 'scene' | 'prop' } | null>(null)
  const [generating, setGenerating] = useState(false)
  // 阶段4可用模型列表
  const [genModels, setGenModels] = useState<any[]>([])
  // 阶段4勾选的分镜（用于批量生成选中的）
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([])

  // 默认生成参数工厂
  const DEFAULT_GEN_PARAMS = (): { model: string; size: string; duration: number; resolution: string; quality: string; watermark: boolean } => ({
    model: '', size: '16:9', duration: 5, resolution: '720p', quality: 'hd', watermark: false,
  })
  // 每个分镜独立的生成参数 sceneId → params
  const [sceneParamsMap, setSceneParamsMap] = useState<Record<string, ReturnType<typeof DEFAULT_GEN_PARAMS>>>({})
  // 参数设置 Modal：target = '__batch__' 表示批量生成；sceneId 表示单个分镜；null 关闭
  const [paramModalTarget, setParamModalTarget] = useState<string | null>(null)
  // Modal 内编辑中的参数（临时副本）
  const [editingParams, setEditingParams] = useState<ReturnType<typeof DEFAULT_GEN_PARAMS>>(DEFAULT_GEN_PARAMS())
  // 阶段3 编辑分镜（null 关闭）
  const [editingScene, setEditingScene] = useState<any | null>(null)
  // 历史进度信息（有解析过的数据时非 null，用于阶段1显示"恢复进度"横幅）
  const [historyInfo, setHistoryInfo] = useState<{
    stage: string; mode: string; shotsCount: number; charactersCount: number; scenesCount: number
  } | null>(null)
  // 当前集关联的剧本 id（用于剧本列表标记"已解析"）
  const [linkedScriptId, setLinkedScriptId] = useState<string | null>(null)

  // 加载可用模型列表（阶段4选择用）
  const loadGenModels = useCallback(async () => {
    try {
      const res: any = await creationService.models.list({ type: 'image_to_video' })
      const list = (res?.data ?? res) as any[]
      const norm = Array.isArray(list) ? list : []
      setGenModels(norm)
    } catch { /* 模型加载失败不阻断 */ }
  }, [])

  useEffect(() => {
    if (stage === 'edit' && genModels.length === 0) loadGenModels()
  }, [stage, genModels.length, loadGenModels])
  // 项目已有剧本列表（阶段1可选）
  const [scripts, setScripts] = useState<any[]>([])
  const [selectedScriptId, setSelectedScriptId] = useState<string>('')

  const svc = React.useMemo(() => episodeService(projectId), [projectId])

  // 加载项目下的剧本列表（阶段1选择用）
  const loadScripts = useCallback(async () => {
    if (!projectId) return
    try {
      const res: any = await scriptService.list(projectId)
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setScripts(list)
    } catch { setScripts([]) }
  }, [projectId])

  // 选中已有剧本时，用其内容填充文本框。
  // 如果选中的是已解析的剧本（关联当前集且有历史），提示可以恢复进度
  const handleScriptSelect = useCallback(async (scriptId: string) => {
    setSelectedScriptId(scriptId)
    if (!scriptId) { setScriptContent(''); return }
    try {
      const res: any = await scriptService.get(scriptId)
      const sc = res?.data ?? res
      setScriptContent(sc?.content || '')
      // 如果选中的是已解析剧本，提示用户可以恢复进度
      if (linkedScriptId === scriptId && historyInfo) {
        Message.info(`该剧本已解析过，可点击上方「恢复进度」直接进入${historyInfo.stage === 'edit' ? '视频编辑' : historyInfo.stage === 'scenes' ? '分镜管理' : '继续编辑'}`)
      }
    } catch { /* 忽略 */ }
  }, [linkedScriptId, historyInfo])

  // 打开时恢复状态
  const loadState = useCallback(async () => {
    if (!episodeId) return
    try {
      const res: any = await svc.wizard(episodeId).get()
      const s = res?.data ?? res
      // 已知的合法阶段
      const validStages = ['script_input', 'assets', 'scenes', 'edit']
      let restoredStage = s.stage || 'script_input'
      if (!validStages.includes(restoredStage)) {
        restoredStage = 'edit'
      }
      // 查 episode 详情拿 script_id（用于剧本列表标记）
      try {
        const epRes: any = await svc.get(episodeId)
        const epData = epRes?.data ?? epRes
        setLinkedScriptId(epData?.script_id || null)
      } catch { /* 忽略 */ }
      // 检测是否有历史进度
      const hasHistory = s.has_script || (s.stage && s.stage !== 'script_input') || (s.characters || []).length > 0
      if (hasHistory) {
        // 智能推导恢复目标阶段（防止后端 stage 被回退覆盖成 script_input）
        let recoverStage = restoredStage
        if (recoverStage === 'script_input') {
          // stage 是 script_input 但有解析数据 → 根据数据推导真实进度
          if ((s.shots || []).length > 0) {
            recoverStage = 'edit'      // 有分镜 → 视频编辑
          } else if ((s.characters || []).length > 0) {
            recoverStage = 'assets'     // 有角色但无分镜 → 资产详情
          }
        }
        setHistoryInfo({
          stage: recoverStage,
          mode: s.mode || 'fusion',
          shotsCount: (s.shots || []).length,
          charactersCount: (s.characters || []).length,
          scenesCount: (s.scenes || []).length,
        })
      } else {
        setHistoryInfo(null)
      }
      if (restoredStage === 'edit' || restoredStage === 'scenes') {
        setStage(restoredStage)
      } else {
        setStage('script_input')
      }
      setMode(s.mode || 'fusion')
      setWizardData({
        characters: s.characters || [],
        scenes: s.scenes || [],
        props: s.props || [],
        shots: s.shots || [],
        asset_map: s.asset_map || {},
        source: s.source,
      })
    } catch { /* 忽略 */ }
  }, [svc, episodeId])

  useEffect(() => {
    if (visible) {
      loadState()
      loadScripts()
    }
  }, [visible, loadState, loadScripts])

  // 轮询剧本解析异步任务（LLM 解析时间不固定，用任务轮询避免 30s 超时）
  const pollParseStatus = (taskId: string): Promise<any> => {
    return new Promise((resolve) => {
      const intervalSec = 3
      const maxAttempts = Math.ceil(getTaskPollTimeout() / intervalSec) + 10
      let attempts = 0
      const poll = async () => {
        attempts++
        try {
          const res: any = await svc.wizard(episodeId).startStatus(taskId)
          const data = res?.data ?? res
          if (data.status === 'completed') {
            resolve(data.result)
            return
          }
          if (data.status === 'failed') {
            resolve(null)
            return
          }
        } catch { /* 网络错误继续轮询 */ }
        if (attempts >= maxAttempts) {
          resolve(null)
          return
        }
        setTimeout(poll, intervalSec * 1000)
      }
      poll()
    })
  }

  // 阶段1：开始解析（异步：提交 → 轮询 → 完成）
  const handleStart = async () => {
    if (!scriptContent.trim()) {
      Message.warning('请粘贴或选择剧本内容')
      return
    }
    setLoading(true)
    try {
      // 1. 提交解析任务（立即返回 task_id）
      const startRes: any = await svc.wizard(episodeId).start(scriptContent, mode, selectedScriptId || undefined)
      const startData = startRes?.data ?? startRes
      const taskId = startData?.task_id
      if (!taskId) {
        // 兼容：若后端直接返回结果（旧版），直接用
        Message.success(`解析完成：${startData.characters?.length || 0} 角色，${startData.scenes?.length || 0} 场景，${startData.shots_count || 0} 分镜`)
        await loadState()
        setStage('assets')
        return
      }
      // 2. 轮询任务状态
      const result = await pollParseStatus(taskId)
      if (!result) {
        Message.error('解析超时或失败，请重试（剧本过长或 AI 服务繁忙）')
        return
      }
      const r = result
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
  // 已有分镜时弹选择框：查看现有 vs 重新拆分（覆盖）
  const handleSaveAssetsAndAdvance = async () => {
    setLoading(true)
    try {
      // 保存资产分配
      const assignments: Record<string, string> = {}
      Object.entries(wizardData.asset_map || {}).forEach(([k, v]: [string, any]) => {
        if (v?.resource_id) assignments[k] = v.resource_id
      })
      await svc.wizard(episodeId).saveAssets(assignments)

      // 用 loadScenes 返回值判断（避免 React state 异步延迟）
      const existingScenes = await loadScenes()

      if (existingScenes.length === 0) {
        // 无分镜 → 首次拆分
        const res: any = await svc.wizard(episodeId).splitScenes(false)
        const r = res?.data ?? res
        Message.success(`已生成 ${r.count} 个分镜`)
        await loadScenes()
        setStage('scenes')
        return
      }

      // 已有分镜 → 弹选择框
      const completedCount = existingScenes.filter((s: any) => s.status === 'completed').length
      Modal.confirm({
        title: `已有 ${existingScenes.length} 个分镜`,
        content: (
          <div style={{ lineHeight: 1.8 }}>
            <div>当前已有 {existingScenes.length} 个分镜{completedCount > 0 ? `（${completedCount} 个已生成视频）` : ''}。</div>
            <div style={{ color: 'var(--color-text-3)', marginTop: 8, fontSize: 13 }}>
              ✅ 点击「查看现有分镜」保留当前分镜进入下一步<br />
              🔄 点击「重新拆分」用最新解析结果覆盖（已生成的视频将丢失）
            </div>
          </div>
        ),
        okText: '🔄 重新拆分（覆盖）',
        cancelText: '✅ 查看现有分镜',
        okButtonProps: { status: 'danger' },
        cancelButtonProps: { type: 'primary', status: 'default' },
        onOk: async () => {
          // 重新拆分
          setLoading(true)
          try {
            const res2: any = await svc.wizard(episodeId).splitScenes(true)
            const r2 = res2?.data ?? res2
            Message.success(`已重新生成 ${r2.count} 个分镜`)
            setSelectedSceneIds([]) // 清空选中
            await loadScenes()
            setStage('scenes')
          } catch (e2: any) {
            Message.error(e2?.message || '拆分镜失败')
          } finally {
            setLoading(false)
          }
        },
        onCancel: async () => {
          // 查看现有分镜（不重新拆分）
          await loadScenes()
          setStage('scenes')
        },
      })
    } catch (e: any) {
      Message.error(e?.message || '操作失败')
    } finally {
      setLoading(false)
    }
  }

  // 加载分镜列表（返回 list 供调用方直接使用，避免 React state 异步延迟）
  const loadScenes = useCallback(async (): Promise<any[]> => {
    try {
      const res: any = await svc.clips(episodeId)
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setScenes(list)
      return list
    } catch { return [] }
  }, [svc, episodeId])

  useEffect(() => {
    // scenes 阶段和 edit 阶段都需要从后端加载真实分镜
    if (stage === 'scenes' || stage === 'edit') loadScenes()
  }, [stage, loadScenes])

  // 阶段4：生成视频（接受 genParams 参数）
  const doGenerate = async (sceneIds: string[] | undefined, params: ReturnType<typeof DEFAULT_GEN_PARAMS>) => {
    if (genModels.length === 0) {
      Message.warning('暂无可用模型，请在后台「配置模型」中添加并启用视频生成模型')
      return
    }
    if (!params.model) {
      Message.warning('请先选择生成模型')
      return
    }
    setGenerating(true)
    try {
      const res: any = await svc.wizard(episodeId).generate(sceneIds, mode, params)
      const r = res?.data ?? res
      if (r.failed > 0 && r.completed > 0) {
        Message.warning(`生成完成：${r.completed} 成功，${r.failed} 失败（可在分镜列表重试）`)
      } else if (r.failed > 0) {
        Message.error(`生成失败：${r.failed} 个分镜失败`)
      } else {
        Message.success(`生成完成：${r.completed} 个分镜全部成功`)
      }
      await loadScenes()
      onCompleted?.()
    } catch (e: any) {
      Message.error(e?.message || '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  // 打开参数设置 Modal（单个分镜 or 批量）
  // target = sceneId → 给该分镜设参数后生成
  // target = '__batch__' → 批量生成参数
  const openParamModal = (target: string) => {
    if (genModels.length === 0) {
      Message.warning('暂无可用模型，请在后台「配置模型」中添加并启用视频生成模型')
      return
    }
    // 预填：单个分镜用已存参数，批量用默认或第一个模型
    if (target === '__batch__') {
      const firstModel = genModels[0]?.id || ''
      setEditingParams({ ...DEFAULT_GEN_PARAMS(), model: firstModel })
    } else {
      const existing = sceneParamsMap[target]
      setEditingParams(existing ? { ...existing } : { ...DEFAULT_GEN_PARAMS(), model: genModels[0]?.id || '' })
    }
    setParamModalTarget(target)
  }

  // 参数 Modal 确认：保存参数并触发生成
  const confirmParamModal = async () => {
    if (!editingParams.model) {
      Message.warning('请选择生成模型')
      return
    }
    const target = paramModalTarget
    setParamModalTarget(null) // 先关闭 Modal
    if (!target) return

    if (target === '__batch__') {
      // 批量生成（选中 or 全部）
      const ids = selectedSceneIds.length > 0 ? selectedSceneIds : undefined
      await doGenerate(ids, editingParams)
    } else {
      // 单个分镜生成：保存该分镜的参数
      setSceneParamsMap(m => ({ ...m, [target]: { ...editingParams } }))
      await doGenerate([target], editingParams)
    }
  }

  // 步骤切换（点 Steps 顶部）
  const handleStepChange = (newStage: string) => {
    // 只更新前端 UI，不调后端 setStage API。
    // 后端 wizard_stage 只在各阶段的业务操作时自动推进（解析→assets，拆分→edit 等），
    // 这样后端始终记录"最远达到的阶段"，用户回退不会覆盖它，
    // 刷新后 loadState 读到的就是真正的最远进度。
    setStage(newStage)
    if (newStage === 'edit' || newStage === 'scenes') loadScenes()
  }

  const currentStepIndex = Math.max(0, STAGES.findIndex(s => s.key === stage))

  // ==================== 阶段渲染 ====================
  const renderStage1 = () => (
    <div>
      {/* ── 历史进度恢复横幅 ── */}
      {historyInfo && (
        <Card size="small" style={{
          marginBottom: 16, background: 'rgb(var(--primary-1))',
          border: '1px solid rgb(var(--primary-5))',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <Space size={6}>
                <Tag size="small" color="arcoblue">
                  {historyInfo.stage === 'edit' ? '视频编辑' : historyInfo.stage === 'scenes' ? '分镜管理' : historyInfo.stage === 'assets' ? '资产详情' : '输入剧本'}
                </Tag>
                <Text style={{ fontWeight: 600, fontSize: 13 }}>上次进度</Text>
              </Space>
              <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>
                {MODES.find((m: any) => m.value === historyInfo.mode)?.label || historyInfo.mode}
                {historyInfo.charactersCount > 0 && ` · ${historyInfo.charactersCount} 角色`}
                {historyInfo.scenesCount > 0 && ` · ${historyInfo.scenesCount} 场景`}
                {historyInfo.shotsCount > 0 && ` · ${historyInfo.shotsCount} 分镜`}
              </div>
            </div>
            <Space>
              <Button type="primary" size="small" icon={<IconRight />}
                onClick={(e) => { e.stopPropagation(); handleStepChange(historyInfo.stage) }}>
                恢复进度
              </Button>
              <Button size="small" type="text" onClick={(e) => {
                e.stopPropagation()
                setHistoryInfo(null)
                setScriptContent('')
                setSelectedScriptId('')
                setStage('script_input')
              }}>
                重新开始
              </Button>
            </Space>
          </div>
        </Card>
      )}

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

      <Text style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>从项目剧本选择（可选）</Text>
      <Select
        value={selectedScriptId || undefined}
        onChange={handleScriptSelect}
        placeholder="选择已有剧本自动填充内容（也可直接粘贴）"
        showSearch
        allowClear
        style={{ width: '100%', marginBottom: 12 }}
        filterOption={(input: string, option: any) => {
          const sc = scripts.find((s: any) => s.id === option?.value)
          return sc ? (sc.title || '').toLowerCase().includes(input.toLowerCase()) : false
        }}
      >
        {scripts.map((s: any) => (
          <Select.Option key={s.id} value={s.id}>
            {s.title || '未命名剧本'}
            {s.parsed_data ? (
              <Tag size="small" color="green" style={{ marginLeft: 6 }}>已解析</Tag>
            ) : (
              <Tag size="small" style={{ marginLeft: 6 }}>未解析</Tag>
            )}
            {linkedScriptId === s.id && historyInfo && (
              <Tag size="small" color="arcoblue" style={{ marginLeft: 6 }}>已关联本集</Tag>
            )}
          </Select.Option>
        ))}
      </Select>

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
          {loading
            ? <Tag size="small" color="arcoblue">AI 解析中，请耐心等待…</Tag>
            : (wizardData.source && <Tag size="small" color={wizardData.source === 'llm' ? 'arcoblue' : 'orange'}>上次解析：{wizardData.source === 'llm' ? 'LLM' : '正则兜底'}</Tag>)}
        </Text>
        <Button type="primary" icon={<IconThunderbolt />} loading={loading} onClick={handleStart}>
          {loading ? '解析中…' : '开始解析'}
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

  // 阶段3：编辑分镜保存
  const handleSaveSceneEdit = async () => {
    if (!editingScene) return
    try {
      await svc.updateClip(episodeId, editingScene.id, {
        prompt: editingScene.prompt,
        duration: editingScene.duration,
        shot_type: editingScene.shot_type,
      })
      Message.success('分镜已更新')
      setEditingScene(null)
      await loadScenes()
    } catch (e: any) {
      Message.error(e?.message || '更新失败')
    }
  }

  // 阶段3：删除分镜
  const handleDeleteScene = (sc: any) => {
    Modal.confirm({
      title: '确认删除',
      content: `确定删除分镜 #${sc.sequence} 吗？此操作不可恢复。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        try {
          await svc.deleteClip(episodeId, sc.id)
          Message.success('已删除')
          // 从选中列表也移除
          setSelectedSceneIds(prev => prev.filter(id => id !== sc.id))
          await loadScenes()
        } catch (e: any) {
          Message.error(e?.message || '删除失败')
        }
      },
    })
  }

  // 阶段3 分镜勾选切换
  const toggleSceneSelect = (sceneId: string) => {
    setSelectedSceneIds(prev =>
      prev.includes(sceneId) ? prev.filter(id => id !== sceneId) : [...prev, sceneId]
    )
  }

  const renderStage3 = () => {
    // 用后端真实分镜（Scene 表）而非解析中间产物
    if (scenes.length === 0) {
      return <Empty description="暂无分镜，请先完成资产关联并生成分镜" style={{ padding: 40 }} />
    }
    return (
      <div>
        <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {scenes.length} 个分镜
            {selectedSceneIds.length > 0 && <Tag size="small" color="arcoblue" style={{ marginLeft: 8 }}>已选 {selectedSceneIds.length} 个（将进入视频编辑）</Tag>}
          </Text>
          <Space size="small">
            <Button size="mini" type="text" onClick={() => setSelectedSceneIds(scenes.map((s: any) => s.id))}>全选</Button>
            <Button size="mini" type="text" onClick={() => setSelectedSceneIds([])}>清空</Button>
          </Space>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', paddingRight: 8 }}>
          {scenes.map((sc: any, idx: number) => {
            const isSelected = selectedSceneIds.includes(sc.id)
            return (
              <Card key={sc.id || idx} size="small" style={{
                marginBottom: 8,
                borderLeft: isSelected ? '3px solid rgb(var(--primary-6))' : '3px solid transparent',
                background: isSelected ? 'var(--color-fill-1)' : 'var(--color-bg-2)',
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <Checkbox
                    checked={isSelected}
                    onChange={() => toggleSceneSelect(sc.id)}
                    style={{ marginTop: 4, flexShrink: 0 }}
                  />
                  <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: '50%', background: 'rgb(var(--primary-6))', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>
                    {sc.sequence || idx + 1}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                      {sc.duration && <Tag size="small" color="arcoblue"><IconClockCircle /> {sc.duration}s</Tag>}
                      {sc.shot_type && <Tag size="small">{sc.shot_type}</Tag>}
                      {sc.status === 'completed' && <Tag size="small" color="green">已生成</Tag>}
                      {sc.status === 'failed' && <Tag size="small" color="red">失败</Tag>}
                    </div>
                    <Text style={{ fontSize: 12, color: 'var(--color-text-2)', display: 'block', lineHeight: 1.6 }}>
                      {truncatePromptText(sc.prompt, 150)}
                    </Text>
                  </div>
                  <Space size={2} style={{ flexShrink: 0 }}>
                    <Tooltip content="编辑">
                      <Button size="mini" type="text" icon={<IconEdit />} onClick={() => setEditingScene({ ...sc })} />
                    </Tooltip>
                    <Tooltip content="删除">
                      <Button size="mini" type="text" icon={<IconDelete />} status="danger" onClick={() => handleDeleteScene(sc)} />
                    </Tooltip>
                  </Space>
                </div>
              </Card>
            )
          })}
        </div>
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
          💡 勾选要生成的分镜，进入视频编辑后只生成选中的；不勾选则默认全部进入视频编辑。
        </Text>
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
        title: '参数', width: 70,
        render: (_: any, row: any) => {
          const p = sceneParamsMap[row.id]
          return p
            ? <Tag size="small" color="arcoblue">已设</Tag>
            : <Tag size="small" color="gray">默认</Tag>
        },
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
        title: '操作', width: 130,
        render: (_: any, row: any) => (
          <Space size={4}>
            <Tooltip content="设置参数并生成">
              <Button size="mini" type="primary" icon={<IconVideoCamera />}
                loading={generating} disabled={row.status === 'completed'}
                onClick={() => openParamModal(row.id)} />
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
          <Text type="secondary">
            共 {scenes.length} 个分镜，{scenes.filter((s: any) => s.status === 'completed').length} 个已生成
            {selectedSceneIds.length > 0 && <Tag size="small" color="arcoblue" style={{ marginLeft: 8 }}>已选 {selectedSceneIds.length} 个</Tag>}
          </Text>
          <Space>
            <Button icon={<IconRefresh />} onClick={loadScenes} size="small">刷新</Button>
            {selectedSceneIds.length > 0 && (
              <Button type="outline" icon={<IconThunderbolt />} loading={generating}
                onClick={() => openParamModal('__batch__')}>
                生成选中（{selectedSceneIds.length}）
              </Button>
            )}
            <Button type="primary" icon={<IconThunderbolt />} loading={generating}
              onClick={() => openParamModal('__batch__')} disabled={selectedSceneIds.length > 0}>
              一键生成全部
            </Button>
          </Space>
        </div>

        {genModels.length === 0 && (
          <Card size="small" style={{ marginBottom: 12 }}>
            <Text type="error" style={{ fontSize: 13 }}>
              ⚠️ 暂无可用视频生成模型，请在后台「配置模型」中添加并启用 image_to_video 类型模型后才能生成视频。
            </Text>
          </Card>
        )}

        <Table
          columns={columns}
          data={scenes}
          rowKey="id"
          pagination={{ pageSize: 8 }}
          size="small"
          rowSelection={{
            selectedRowKeys: selectedSceneIds,
            onChange: (keys: any[]) => setSelectedSceneIds(keys as string[]),
            checkboxProps: (record: any) => ({
              disabled: record.status === 'completed',
            }),
          }}
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
            <Button type="primary" icon={<IconRight />} loading={loading} onClick={handleSaveAssetsAndAdvance}>
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

      {/* ── 分镜编辑 Modal（阶段3） ── */}
      <Modal
        title={`编辑分镜 #${editingScene?.sequence || ''}`}
        visible={!!editingScene}
        onCancel={() => setEditingScene(null)}
        onOk={handleSaveSceneEdit}
        okText="保存"
        cancelText="取消"
        style={{ width: 600, top: 60 }}
      >
        {editingScene && (
          <div>
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>提示词</Text>
              <Input.TextArea
                value={editingScene.prompt || ''}
                onChange={(v: string) => setEditingScene((s: any) => ({ ...s, prompt: v }))}
                autoSize={{ minRows: 4, maxRows: 10 }}
                style={{ marginTop: 4 }}
              />
            </div>
            <Grid.Row gutter={12}>
              <Grid.Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>时长（秒）</Text>
                <InputNumber
                  value={editingScene.duration || 5}
                  onChange={(v: number) => setEditingScene((s: any) => ({ ...s, duration: v }))}
                  min={2} max={60}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>镜头类型</Text>
                <Input
                  value={editingScene.shot_type || ''}
                  onChange={(v: string) => setEditingScene((s: any) => ({ ...s, shot_type: v }))}
                  style={{ marginTop: 4 }}
                />
              </Grid.Col>
            </Grid.Row>
          </div>
        )}
      </Modal>

      {/* ── 生成参数设置 Modal（单个分镜 or 批量生成共用） ── */}
      <Modal
        title={paramModalTarget === '__batch__'
          ? (selectedSceneIds.length > 0 ? `批量生成（${selectedSceneIds.length} 个选中分镜）` : '一键生成全部 — 参数设置')
          : '生成本镜 — 参数设置'}
        visible={paramModalTarget !== null}
        onCancel={() => setParamModalTarget(null)}
        onOk={confirmParamModal}
        okText={paramModalTarget === '__batch__' ? '开始生成' : '生成本镜'}
        cancelText="取消"
        style={{ width: 560, top: 60 }}
        maskClosable={false}
      >
        <Grid.Row gutter={[12, 12]}>
          <Grid.Col span={24}>
            <Text type="secondary" style={{ fontSize: 12 }}>生成模型 *</Text>
            <Select
              value={editingParams.model || undefined}
              onChange={(v: string) => setEditingParams(p => ({ ...p, model: v }))}
              placeholder="选择视频生成模型"
              style={{ width: '100%', marginTop: 2 }}
              showSearch
              filterOption={(input: string, option: any) => {
                const m = genModels.find((x: any) => x.id === option?.value)
                return m ? (m.name || '').toLowerCase().includes(input.toLowerCase()) : false
              }}
              notFoundContent="暂无可用模型，请在后台配置"
            >
              {genModels.map((m: any) => (
                <Select.Option key={m.id} value={m.id}>
                  {m.name}（{(m.config || {}).model || m.name}）
                </Select.Option>
              ))}
            </Select>
          </Grid.Col>
          <Grid.Col span={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>画面比例</Text>
            <Select
              value={editingParams.size}
              onChange={(v: string) => setEditingParams(p => ({ ...p, size: v }))}
              style={{ width: '100%', marginTop: 2 }}
            >
              {ASPECT_RATIOS.map(r => (
                <Select.Option key={r.value} value={r.value}>{r.value}</Select.Option>
              ))}
            </Select>
          </Grid.Col>
          <Grid.Col span={12}>
            <Text type="secondary" style={{ fontSize: 12 }}>分辨率</Text>
            <Select
              value={editingParams.resolution}
              onChange={(v: string) => setEditingParams(p => ({ ...p, resolution: v }))}
              style={{ width: '100%', marginTop: 2 }}
            >
              {['480p', '720p', '768P', '1080p', '2k', '4k'].map(r => (
                <Select.Option key={r} value={r}>{r}</Select.Option>
              ))}
            </Select>
          </Grid.Col>
          <Grid.Col span={12}>
            <Text type="secondary" style={{ fontSize: 12 }}>质量</Text>
            <div style={{ marginTop: 4 }}>
              <Radio.Group
                value={editingParams.quality}
                onChange={(v: any) => setEditingParams(p => ({ ...p, quality: v }))}
                type="button"
              >
                <Radio value="standard">快速</Radio>
                <Radio value="hd">HD</Radio>
              </Radio.Group>
            </div>
          </Grid.Col>
          <Grid.Col span={12}>
            <Text type="secondary" style={{ fontSize: 12 }}>水印</Text>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Switch
                checked={editingParams.watermark}
                onChange={(v: boolean) => setEditingParams(p => ({ ...p, watermark: v }))}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>{editingParams.watermark ? '添加' : '不添加'}</Text>
            </div>
          </Grid.Col>
        </Grid.Row>
        <div style={{ marginTop: 10, padding: '6px 10px', background: 'var(--color-fill-2)', borderRadius: 4, fontSize: 12, color: 'var(--color-text-3)' }}>
          ⏱️ 视频时长自动取每个分镜自身的时长，无需手动设置
        </div>
      </Modal>

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
