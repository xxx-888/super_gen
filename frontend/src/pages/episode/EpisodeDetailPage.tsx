/**
 * EpisodeDetailPage - 集详情(创作面板) - 对标巨日禄 material_list
 *
 * 点击集卡片进入此页. 布局:
 * - 左侧: 创作参数(镜头类型/创作模式/元素/提示词/尺寸/数量) + 提交
 * - 右侧: 素材成果区(全部/看图片/看视频/对口型/Agent/改视频/看收藏 分类tab)
 * - 顶部: 集标题 + 一键成片 + 返回集列表
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Card, Typography, Button, Space, Select, Tag, Input, Radio, Message,
  Empty, Spin, Grid, Tabs, Modal, Form, InputNumber, Popconfirm, Switch,
} from '@arco-design/web-react'
import {
  IconVideoCamera, IconImage, IconLeft, IconPlus, IconDelete, IconBulb,
  IconSound, IconRobot, IconEdit, IconStar, IconThunderbolt, IconRefresh, IconPlayCircle,
  IconShareExternal, IconCheck,
} from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { episodeService, creationService, taskService, workbenchService } from '@/api/services'
import { useTeamStore, useCreditStore } from '@/stores'
import { GenElementInput, CreationMode, SHOT_TYPES, ASPECT_RATIOS, ratioToCss } from '@/types'
import MaterialPickerModal, { MaterialPickResult } from '@/components/material/MaterialPickerModal'
// 快速生成(AgentPanel) 已移除，功能合并到 Agent 向导
import WizardAgentModal from '@/components/agent/WizardAgentModal'
import PromptEditorLite from '@/components/editor/PromptEditorLite'
import HighlightPrompt from '@/components/editor/HighlightPrompt'
import PublishWorkModal, { PublishTarget } from '@/components/showcase/PublishWorkModal'
import { SCENE_STATUS } from '@/utils/statusLabels'
import { renderPromptText, truncatePromptText } from '@/utils/prompt'
import { getTaskPollTimeout } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

const MODE_LABELS: Record<string, string> = {
  fusion: '在线融合生图',
  image_to_video: '图生视频',
  first_last_frame: '首尾帧生成视频',
}

const ELEMENT_TYPES = [
  { key: 'character', label: '角色' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '物品' },
  { key: 'pose', label: '姿态' },
  { key: 'effect', label: '特效' },
  { key: 'audio', label: '音频' },
  { key: 'video', label: '视频' },
]

/** 从素材库选择元素类型（其余为手填） */
const LIB_ELEMENT_TYPES = ['character', 'scene', 'prop', 'audio', 'video']

/** 元素类型 → 参考媒体 URL 字段（音频/视频走 reference_audio/reference_video） */
const MEDIA_URL_FIELD: Record<string, 'image_url' | 'audio_url' | 'video_url'> = {
  audio: 'audio_url',
  video: 'video_url',
}

const RESOLUTIONS = ['480p', '720p', '768P', '1080p', '2k', '4k']

const MATERIAL_TABS = [
  { key: 'all', label: '全部', icon: <IconImage /> },
  { key: 'image', label: '看图片', icon: <IconImage /> },
  { key: 'video', label: '看视频', icon: <IconVideoCamera /> },
  { key: 'lip_sync', label: '对口型', icon: <IconSound /> },
  { key: 'agent', label: 'Agent', icon: <IconRobot /> },
  { key: 'edit', label: '改视频', icon: <IconEdit /> },
  { key: 'favorite', label: '看收藏', icon: <IconStar /> },
]

const EpisodeDetailPage: React.FC = () => {
  const { projectId, episodeId } = useParams<{ projectId: string; episodeId: string }>()
  const navigate = useNavigate()
  const { loadBalance } = useCreditStore()

  const [episode, setEpisode] = useState<any>(null)
  const [clips, setClips] = useState<any[]>([])
  const [materials, setMaterials] = useState<any[]>([])
  const [matTab, setMatTab] = useState('all')
  const [loading, setLoading] = useState(false)

  // 创作参数
  const [shotType, setShotType] = useState('对话场景')
  const [mode, setMode] = useState<CreationMode>('fusion')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('16:9')
  const [count, setCount] = useState(1)
  const [quality, setQuality] = useState<'hd' | 'standard'>('hd')
  const [watermark, setWatermark] = useState(false)
  const [elements, setElements] = useState<GenElementInput[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [rendering, setRendering] = useState(false)
  // 创作面板的模型选择
  const [panelModels, setPanelModels] = useState<any[]>([])
  const [panelModelId, setPanelModelId] = useState<string>('')
  const [panelModelsLoading, setPanelModelsLoading] = useState(false)
  // 生成类型：图片 or 视频（决定加载哪种模型 + 用哪个 task_type）
  const [genType, setGenType] = useState<'video' | 'image'>('video')

  // 分镜新建/编辑弹窗（共用一个 Modal，editingClip 为 null 时是新建）
  const [clipModalVisible, setClipModalVisible] = useState(false)
  const [editingClip, setEditingClip] = useState<any | null>(null)
  const [clipPrompt, setClipPrompt] = useState('')
  const [clipShotType, setClipShotType] = useState('对话场景')
  const [clipDuration, setClipDuration] = useState(5)
  const [clipSize, setClipSize] = useState('16:9')
  const [clipResolution, setClipResolution] = useState('720p')
  const [clipQuality, setClipQuality] = useState<'hd' | 'standard'>('hd')
  const [clipWatermark, setClipWatermark] = useState(false)
  const [clipSaving, setClipSaving] = useState(false)

  // 发布到作品展示：目标分镜 + 已发布视频地址集合（用于标记「已发布」）
  const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(null)
  const [publishedUrls, setPublishedUrls] = useState<Set<string>>(new Set())

  // 单镜生成弹窗
  const [genModalVisible, setGenModalVisible] = useState(false)
  const [genClip, setGenClip] = useState<any | null>(null)
  const [genMode, setGenMode] = useState<string>('image_to_video')
  const [genModelId, setGenModelId] = useState<string>('')
  const [genModels, setGenModels] = useState<any[]>([])
  const [genModelsLoading, setGenModelsLoading] = useState(false)
  const [genSize, setGenSize] = useState('16:9')
  const [genDuration, setGenDuration] = useState(5)
  const [genResolution, setGenResolution] = useState('768P')
  const [genQuality, setGenQuality] = useState<'hd' | 'standard'>('hd')
  const [genWatermark, setGenWatermark] = useState(false)
  const [genFirstFrame, setGenFirstFrame] = useState('')
  const [genLastFrame, setGenLastFrame] = useState('')
  const [genSubmitting, setGenSubmitting] = useState(false)
  // 正在生成中的分镜 id 集合（用于列表显示"生成中"状态）
  const [generatingClipIds, setGeneratingClipIds] = useState<Set<string>>(new Set())
  // 媒体预览弹窗（素材区点击查看视频/图片）
  const [previewMedia, setPreviewMedia] = useState<{ url: string; isVideo: boolean } | null>(null)

  const svc = useMemo(() => (projectId ? episodeService(projectId) : null), [projectId])

  const loadAll = useCallback(async () => {
    if (!svc || !episodeId) return
    setLoading(true)
    try {
      const [ep, cl, mat]: any = await Promise.all([
        svc.get(episodeId),
        svc.clips(episodeId),
        svc.materials(episodeId, matTab === 'all' ? undefined : matTab),
      ])
      setEpisode(ep?.data ?? ep)
      setClips(Array.isArray(cl) ? cl : (cl?.data ?? []))
      setMaterials(Array.isArray(mat) ? mat : (mat?.data ?? []))
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [svc, episodeId, matTab])

  useEffect(() => { loadAll() }, [loadAll])
  // 挂载时加载视频模型（默认生成类型为视频）
  useEffect(() => { loadPanelModels('video') }, [])

  // 加载「我的作品」视频地址集合：用于标记分镜成片是否已发布过画廊
  useEffect(() => {
    workbenchService.myWorks().then((res: any) => {
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setPublishedUrls(new Set(list.map((w: any) => w.video_url).filter(Boolean)))
    }).catch(() => { /* 未登录等场景忽略 */ })
  }, [])

  // 定时刷新（10秒）：同步其他用户的生成状态变化（generating→completed/failed）
  useEffect(() => {
    const timer = setInterval(() => loadAll(), 10000)
    return () => clearInterval(timer)
  }, [loadAll])

  const addElement = (type: string) => {
    // 角色/场景/物品/音频/视频：从素材库选择（找不到可新建）；姿态/特效：直接加空行
    if (LIB_ELEMENT_TYPES.includes(type)) {
      setPickerType(type as 'character' | 'scene' | 'prop' | 'audio' | 'video')
    } else {
      setElements([...elements, { type: type as any, name: '', image_url: '' }])
    }
  }
  const removeElement = (idx: number) => setElements(elements.filter((_, i) => i !== idx))
  const updateElement = (idx: number, field: string, value: string) =>
    setElements(elements.map((e, i) => i === idx ? { ...e, [field]: value } : e))

  // 素材库选择器：选中后同步到项目资源并回填为新元素
  const [pickerType, setPickerType] = useState<'character' | 'scene' | 'prop' | 'audio' | 'video' | null>(null)
  // Agent 向导（剧本驱动 4 阶段，对标巨日禄）
  const [wizardVisible, setWizardVisible] = useState(false)
  const handlePicked = (result: MaterialPickResult) => {
    // 选择器把媒体地址统一放在 image_url 返回：音频/视频需转存到对应参考字段
    const mediaField = MEDIA_URL_FIELD[result.type]
    setElements([...elements, {
      type: result.type as any,
      name: result.name,
      image_url: mediaField ? undefined : (result.image_url || ''),
      audio_url: mediaField === 'audio_url' ? result.image_url : undefined,
      video_url: mediaField === 'video_url' ? result.image_url : undefined,
      resource_id: result.resource_id,
      material_id: result.material_id || undefined,
    }])
    setPickerType(null)
    const typeLabel = ELEMENT_TYPES.find(t => t.key === result.type)?.label || result.type
    Message.success(`已添加${typeLabel}：${result.name}`)
  }

  const handleGenerate = async () => {
    // 模型校验：必须选了模型才能提交
    if (!panelModelId) {
      Message.warning(panelModels.length === 0
        ? `未配置可用模型，请到「后台管理 → 配置模型」添加${genType === 'video' ? '图生视频' : '文生图'}模型`
        : '请先选择模型')
      return
    }
    if (!prompt && (mode === 'fusion' || genType === 'image')) { Message.warning('请输入描述'); return }
    setSubmitting(true)
    try {
      const payload: Record<string, any> = {
        prompt, size, count,
        quality, watermark_enabled: watermark,
        model: panelModelId,
        // 完整透传元素参考媒体：image_url(参考图) / audio_url(参考音频) / video_url(参考视频)
        elements: elements.filter(e => e.name).map(e => ({
          type: e.type,
          name: e.name,
          image_url: e.image_url || undefined,
          audio_url: e.audio_url || undefined,
          video_url: e.video_url || undefined,
        })),
      }
      let res: any
      // 图片生成走 fusion（文生图）；视频生成按 mode 选择
      if (genType === 'image' || mode === 'fusion') {
        res = await creationService.fusion(payload, projectId)
      } else if (mode === 'image_to_video') {
        res = await creationService.imageToVideo(payload, projectId, episodeId)
      } else {
        res = await creationService.firstLastFrame(payload, projectId, episodeId)
      }
      const r = res?.data ?? res
      Message.success(`生成成功! 消耗 ${r.credits_consumed} 积分`)
      loadBalance(); loadAll()
    } catch (e: any) { Message.error(e?.message || '生成失败') }
    finally { setSubmitting(false) }
  }

  // 合并完整成片(所有分镜已完成时): 不提交生成任务、不扣积分
  const handleRecompose = async () => {
    if (!svc || !episodeId) return
    setRendering(true)
    try {
      const res: any = await svc.compose(episodeId)
      const r = res?.data ?? res
      Message.success(`合并完成！已合成 ${r.clip_count} 个分镜`)
      loadAll()
    } catch { /* 拦截器统一提示 */ } finally { setRendering(false) }
  }

  const handleOneClickRender = async () => {
    if (!svc || !episodeId) return
    // 无分镜时直接提示
    if (clips.length === 0) {
      Modal.info({
        title: '无法一键成片',
        content: '该集暂无分镜，请先用 Agent 向导（解析剧本→拆分镜）或手动创建分镜后再一键成片。',
        okText: '知道了',
      })
      return
    }

    // 所有分镜已完成 → 直接合并成完整视频（不再提交生成任务、不扣积分）
    const allCompleted = clips.every((c: any) => c.status === 'completed' && c.generated_video_url)
    if (allCompleted) {
      Modal.confirm({
        title: '合并完整成片',
        content: (
          <div style={{ lineHeight: 1.8 }}>
            <div>本集 <strong>{clips.length}</strong> 个分镜已全部完成，将按分镜顺序合并为一个完整视频。</div>
            <div style={{ color: 'var(--color-text-3)', fontSize: 13, marginTop: 4 }}>
              不提交生成任务、不消耗积分；合并后可在下方「完整成片」中播放和发布。
            </div>
          </div>
        ),
        okText: '开始合并',
        cancelText: '取消',
        onOk: handleRecompose,
      })
      return
    }

    // 有未完成的分镜 → 走生成流程（只为未完成分镜提交任务由后端编排）
    const COST_PER_SCENE = 10
    const totalCost = clips.length * COST_PER_SCENE
    // 弹确认框
    Modal.confirm({
      title: '确认一键成片',
      content: (
        <div style={{ lineHeight: 1.8 }}>
          <div>本集共 <strong>{clips.length}</strong> 个分镜，预估消耗 <strong style={{ color: 'rgb(var(--warning-6))' }}>{totalCost}</strong> 积分。</div>
          <div style={{ color: 'var(--color-text-3)', fontSize: 13, marginTop: 4 }}>
            将为每个分镜生成图生视频任务，完成后可在右侧素材区查看。
          </div>
          <div style={{ marginTop: 8, maxHeight: 100, overflowY: 'auto', fontSize: 12, color: 'var(--color-text-3)' }}>
            {clips.slice(0, 3).map((c: any) => (
              <div key={c.id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                #{c.sequence} {(c.prompt || '').slice(0, 40)}
              </div>
            ))}
            {clips.length > 3 && <div>...还有 {clips.length - 3} 个分镜</div>}
          </div>
        </div>
      ),
        okText: `开始生成（消耗 ${totalCost} 积分）`,
        cancelText: '取消',
        onOk: async () => {
          setRendering(true)
          try {
            const res: any = await svc.oneClickRender(episodeId)
            const r = res?.data ?? res
            loadBalance(); loadAll()
            // 结果汇总
            if (r.scene_count === 0 || !r.scene_count) {
              Message.info(r.message || '该集暂无分镜')
              return
            }
            if (!r.tasks?.length) {
              // 没有新任务：全部分镜已生成（提示走合并）或其他提示
              Message.info(r.message || '没有需要生成的分镜')
              return
            }
            const completed = r.completed || 0
            const failed = r.failed || 0
            const processing = r.processing || 0
            if (failed === 0 && processing > 0) {
              const skipped = r.skipped_in_flight || 0
              Message.info(`已提交 ${processing} 个分镜生成任务${skipped > 0 ? `（${skipped} 个已在生成中自动跳过）` : ''}，生成完成后分镜列表自动更新；全部完成后再次点击「一键成片」即可合并完整视频`)
            } else if (failed === 0) {
              Message.success(`一键成片完成！${completed} 个分镜全部成功，消耗 ${r.credits_consumed} 积分`)
            } else {
              Modal.info({
                title: '一键成片完成（部分失败）',
                content: (
                  <div style={{ lineHeight: 1.8 }}>
                    <div>成功：<strong style={{ color: 'rgb(var(--success-6))' }}>{completed}</strong> 个</div>
                    {processing > 0 && <div>生成中：<strong style={{ color: 'rgb(var(--arcoblue-6))' }}>{processing}</strong> 个（完成后自动更新）</div>}
                    <div>失败：<strong style={{ color: 'rgb(var(--danger-6))' }}>{failed}</strong> 个（分镜 #{r.failed_scenes?.join(', #')}）</div>
                    <div>消耗：{r.credits_consumed} 积分</div>
                    <div style={{ color: 'var(--color-text-3)', fontSize: 13, marginTop: 8 }}>
                      失败的分镜可在分镜列表中单独重试。
                    </div>
                  </div>
                ),
                okText: '知道了',
              })
            }
          } catch (e: any) {
            Message.error(e?.message || '一键成片失败')
          } finally {
            setRendering(false)
          }
        },
    })
  }

  // 打开新建分镜弹窗
  const openCreateClip = () => {
    setEditingClip(null)
    setClipPrompt('')
    setClipShotType(shotType)
    setClipDuration(5)
    setClipSize(size)
    setClipResolution('720p')
    setClipQuality(quality)
    setClipWatermark(watermark)
    setClipModalVisible(true)
  }

  // 打开编辑分镜弹窗
  const openEditClip = (c: any) => {
    setEditingClip(c)
    setClipPrompt(c.prompt || '')
    setClipShotType(c.shot_type || '对话场景')
    setClipDuration(c.duration || 5)
    setClipSize(c.size || '16:9')
    setClipResolution(c.resolution || '720p')
    setClipQuality(c.quality || 'hd')
    setClipWatermark(c.watermark_enabled ?? false)
    setClipModalVisible(true)
  }

  // 保存分镜（新建或编辑统一处理）
  const handleSaveClip = async () => {
    if (!svc || !episodeId) return
    if (!clipPrompt.trim()) { Message.warning('请输入分镜提示词'); return }
    setClipSaving(true)
    try {
      const payload = {
        prompt: clipPrompt,
        shot_type: clipShotType,
        creation_mode: mode,
        duration: clipDuration,
        size: clipSize,
        resolution: clipResolution,
        quality: clipQuality,
        watermark_enabled: clipWatermark,
      }
      if (editingClip) {
        await svc.updateClip(episodeId, editingClip.id, payload)
        Message.success('分镜已更新')
      } else {
        await svc.createClip(episodeId, payload)
        Message.success('分镜已添加')
      }
      setClipModalVisible(false)
      loadAll()
    } catch (e: any) {
      Message.error(e?.message || '保存失败')
    } finally {
      setClipSaving(false)
    }
  }

  // 删除分镜
  const handleDeleteClip = async (clipId: string) => {
    if (!svc || !episodeId) return
    try {
      await svc.deleteClip(episodeId, clipId)
      Message.success('分镜已删除')
      loadAll()
    } catch (e: any) {
      Message.error(e?.message || '删除失败')
    }
  }

  // ===== 单镜生成 =====
  const loadGenModels = async () => {
    setGenModelsLoading(true)
    try {
      const res: any = await creationService.models.list({ type: 'image_to_video' })
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setGenModels(list)
      if (list.length && !genModelId) setGenModelId(list[0].id)
    } catch { /* 非管理员或未配置，忽略 */ }
    finally { setGenModelsLoading(false) }
  }

  // 创作面板：按生成类型（图片/视频）加载对应模型
  const loadPanelModels = async (gtype: 'video' | 'image') => {
    setPanelModelsLoading(true)
    try {
      const modelType = gtype === 'video' ? 'image_to_video' : 'text_to_image'
      const res: any = await creationService.models.list({ type: modelType })
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setPanelModels(list)
      setPanelModelId(list.length ? list[0].id : '')
    } catch { /* 未配置忽略 */ }
    finally { setPanelModelsLoading(false) }
  }

  // 切换生成类型时重新加载模型
  const onGenTypeChange = (gtype: 'video' | 'image') => {
    setGenType(gtype)
    setPanelModelId('')
    setPanelModels([])
    loadPanelModels(gtype)
  }

  const openGenModal = (clip: any) => {
    // 状态检测：如果该分镜正在生成中，阻止重复提交
    if (clip.status === 'generating' || generatingClipIds.has(clip.id)) {
      Message.warning('该分镜正在生成视频，请等待完成后再操作')
      return
    }
    setGenClip(clip)
    setGenMode(clip.creation_mode || 'image_to_video')
    setGenSize((clip.meta || clip.size) || '16:9')
    setGenDuration(clip.duration || 5)
    setGenResolution((clip.meta || {}).resolution || clip.resolution || '768P')
    setGenQuality((clip.meta || {}).quality || 'hd')
    setGenWatermark((clip.meta || {}).watermark_enabled || false)
    setGenFirstFrame('')
    setGenLastFrame('')
    setGenModalVisible(true)
    if (genModels.length === 0) loadGenModels()
  }

  const handleGenSubmit = async () => {
    if (!genClip) return
    // 首尾帧模式校验：至少提供首帧
    if (genMode === 'first_last_frame' && !genFirstFrame.trim()) {
      Message.warning('首尾帧模式需要提供首帧图片 URL')
      return
    }
    setGenSubmitting(true)
    // 标记该分镜为生成中
    setGeneratingClipIds(prev => new Set(prev).add(genClip.id))
    try {
      const payload: Record<string, any> = {
        size: genSize,
        duration: genDuration,
        resolution: genResolution,
        quality: genQuality,
        watermark_enabled: genWatermark,
        model: genModelId || undefined,
      }
      // 首尾帧模式传 frame URL
      if (genMode === 'first_last_frame') {
        payload.first_frame_url = genFirstFrame.trim() || undefined
        payload.last_frame_url = genLastFrame.trim() || undefined
      }
      // 图生视频模式：有首帧图片时作为 image_url 传入
      if (genMode === 'image_to_video' && genFirstFrame.trim()) {
        payload.image_url = genFirstFrame.trim()
      }
      const res: any = await creationService.clipGenerate(genClip.id, payload, genMode)
      const r = res?.data ?? res
      setGenModalVisible(false)
      // 若是同步完成（status=completed），直接刷新；否则轮询 task 状态
      if (r.status === 'completed' && r.urls?.length) {
        Message.success('生成完成')
        setGeneratingClipIds(prev => { const s = new Set(prev); s.delete(genClip.id); return s })
        loadAll()
      } else if (r.task_id) {
        Message.info('生成中，请稍候...')
        pollClipGen(r.task_id, genClip.id)
      } else {
        Message.success('已提交生成')
        setGeneratingClipIds(prev => { const s = new Set(prev); s.delete(genClip.id); return s })
        loadAll()
      }
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || e?.message || '生成失败')
      setGeneratingClipIds(prev => { const s = new Set(prev); s.delete(genClip.id); return s })
    } finally {
      setGenSubmitting(false)
    }
  }

  // 轮询单镜生成任务状态（3秒间隔，超时上限跟随后台「系统设置」的 task_poll_timeout_seconds）
  const pollClipGen = (taskId: string, clipId: string) => {
    const intervalSec = 3
    // +10 次冗余：确保前端不会比后端先放弃（后端标记 failed 后会命中 failed 分支正常退出）
    const maxAttempts = Math.ceil(getTaskPollTimeout() / intervalSec) + 10
    let attempt = 0
    const timer = setInterval(async () => {
      attempt++
      try {
        const res: any = await taskService.get(taskId)
        const task = res?.data ?? res
        if (task.status === 'completed') {
          clearInterval(timer)
          setGeneratingClipIds(prev => { const s = new Set(prev); s.delete(clipId); return s })
          Message.success('分镜视频生成完成')
          loadAll()
        } else if (task.status === 'failed') {
          clearInterval(timer)
          setGeneratingClipIds(prev => { const s = new Set(prev); s.delete(clipId); return s })
          Message.error(task.error_message || '生成失败')
          loadAll()
        }
      } catch { /* 网络错误继续轮询 */ }
      if (attempt >= maxAttempts) {
        clearInterval(timer)
        setGeneratingClipIds(prev => { const s = new Set(prev); s.delete(clipId); return s })
        const mins = Math.round((maxAttempts * intervalSec) / 60)
        Message.warning(`生成超时（约 ${mins} 分钟），请稍后在视频预览页查看结果`)
      }
    }, intervalSec * 1000)
  }

  // 素材成果渲染
  const renderMaterials = () => {
    if (loading) return <Spin dot style={{ display: 'block', margin: '40px auto' }} />
    if (materials.length === 0) return <Empty description="暂无素材，提交任务后展示" />
    return (
      <Row gutter={[8, 8]}>
        {materials.flatMap(m => (m.urls || []).map((url: string, i: number) => {
          const isVideo = url.includes('.mp4') || url.includes('.webm') || m.type === 'video' || m.type === 'image_to_video' || m.type === 'first_last_frame'
          const typeLabel = isVideo ? '视频' : (m.type === 'image' ? '图片' : m.type)
          // 关联分镜序号（后端返回 scene_sequence），无关联时显示序号
          const sceneTag = m.scene_sequence != null ? `分镜 #${m.scene_sequence}` : null
          const scenePrompt = m.scene_prompt || ''
          return (
            <Col key={`${m.task_id}-${i}`} span={8}>
              <Card size="small" hoverable style={{ cursor: 'pointer' }}
                onClick={() => setPreviewMedia({ url, isVideo })}
                cover={
                  <div style={{ aspectRatio: '16/9', background: 'var(--color-fill-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' }}>
                    {isVideo ? (
                      <>
                        <video src={url} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} muted preload="metadata" />
                        <IconPlayCircle style={{ position: 'absolute', fontSize: 32, color: 'rgba(255,255,255,0.8)' }} />
                      </>
                    ) : (
                      <img src={url} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    )}
                  </div>
                }
              >
                <Card.Meta description={
                  <div>
                    <Space size={4} style={{ marginBottom: 2 }}>
                      <Tag size="small" color={isVideo ? 'green' : 'arcoblue'}>{typeLabel}</Tag>
                      {sceneTag && <Tag size="small" color="purple">{sceneTag}</Tag>}
                    </Space>
                    {scenePrompt && (
                      <Text type="secondary" style={{ fontSize: 11, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {scenePrompt}
                      </Text>
                    )}
                  </div>
                } />
              </Card>
            </Col>
          )
        }))}
      </Row>
    )
  }

  if (loading && !episode) return <Spin dot style={{ display: 'block', margin: '60px auto' }} />

  return (
    <div>
      {/* 顶部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Button icon={<IconLeft />} onClick={() => navigate(`/projects/${projectId}/episodes`)}>返回</Button>
          <Title heading={5} style={{ margin: 0 }}>{episode?.title || '集详情'}</Title>
          {episode && <Tag color="arcoblue">{episode.status}</Tag>}
        </Space>
        <Space>
          <Button type="primary" icon={<IconThunderbolt />} onClick={() => setWizardVisible(true)}>
            Agent 向导
          </Button>
          <Button type="primary" icon={<IconVideoCamera />} loading={rendering} onClick={handleOneClickRender}>
            一键成片
          </Button>
        </Space>
      </div>

      {/* 完整成片: 所有分镜合并后的成片(播放/发布/重新合并) */}
      {episode?.composed_video_url && (
        <Card
          size="small"
          style={{ marginBottom: 16 }}
          title={<span><IconVideoCamera style={{ marginRight: 6, color: 'rgb(var(--success-6))' }} />完整成片{episode.composed_clip_count ? `（${episode.composed_clip_count} 个分镜合并）` : ''}</span>}
          extra={
            <Space>
              {publishedUrls.has(episode.composed_video_url) ? (
                <Tag color="green" icon={<IconCheck />}>已发布画廊</Tag>
              ) : (
                <Button size="small" type="primary" icon={<IconShareExternal />}
                  onClick={() => setPublishTarget({
                    videoUrl: episode.composed_video_url,
                    coverUrl: undefined,
                    projectId,
                    episodeId,
                    defaultTitle: episode?.title || '完整成片',
                    defaultTags: [],
                  })}>
                  发布到作品展示
                </Button>
              )}
              <Popconfirm title="重新合并将覆盖当前成片，继续？" onOk={handleRecompose}>
                <Button size="small" icon={<IconRefresh />} loading={rendering}>重新合并</Button>
              </Popconfirm>
            </Space>
          }
        >
          <video
            src={episode.composed_video_url}
            controls
            playsInline
            preload="metadata"
            style={{ width: '100%', maxHeight: 420, aspectRatio: '16/9', background: '#000', borderRadius: 8, display: 'block' }}
          />
        </Card>
      )}

      <Row gutter={16}>
        {/* 左侧: 创作参数 */}
        <Col span={13}>
          <Card title="创作参数" size="small">
            {/* 生成类型：图片 or 视频 */}
            <Text style={{ display: 'block', marginBottom: 4 }}>* 生成类型</Text>
            <Radio.Group value={genType} onChange={(v) => onGenTypeChange(v)} style={{ marginBottom: 12 }}>
              <Radio value="video">视频</Radio>
              <Radio value="image">图片</Radio>
            </Radio.Group>

            {/* 模型选择 */}
            <Text style={{ display: 'block', marginBottom: 4 }}>* 生成模型</Text>
            {panelModelsLoading ? <Spin size={20} style={{ marginBottom: 12 }} /> : (
              <Select
                value={panelModelId || undefined}
                onChange={setPanelModelId}
                style={{ width: '100%', marginBottom: 4 }}
                placeholder={panelModels.length === 0 ? `未配置${genType === 'video' ? '视频' : '图片'}模型` : '选择模型'}
                allowClear
                disabled={panelModels.length === 0}
              >
                {panelModels.map((m: any) => (
                  <Select.Option key={m.id} value={m.id}>
                    {m.name}（{(m.config || {}).model || m.name}）
                  </Select.Option>
                ))}
              </Select>
            )}
            {panelModels.length === 0 && !panelModelsLoading && (
              <Text type="warning" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                未配置可用{genType === 'video' ? '视频' : '图片'}模型，请到「后台管理 → 配置模型」添加
              </Text>
            )}

            {/* 创作模式（仅视频时显示） */}
            {genType === 'video' && (
              <>
                <Text style={{ display: 'block', marginBottom: 4 }}>* 创作模式</Text>
                <Tabs activeTab={mode} onChange={(v) => setMode(v as CreationMode)} size="small" style={{ marginBottom: 12 }}>
                  <TabPane key="image_to_video" title="图片生成视频" />
                  <TabPane key="first_last_frame" title="首尾帧生成视频" />
                  <TabPane key="fusion" title="融合生成视频" />
                </Tabs>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{MODE_LABELS[mode]}</Text>
              </>
            )}

            {/* 镜头类型 */}
            <Text style={{ display: 'block', marginBottom: 4 }}>镜头类型</Text>
            <Select value={shotType} onChange={setShotType} style={{ width: '100%', marginBottom: 12 }}>
              {SHOT_TYPES.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>

            {/* 元素 */}
            <Text style={{ display: 'block', marginBottom: 4 }}>元素 (角色/场景/物品/姿态/特效/音频/视频参考)</Text>
            <Space wrap size="small" style={{ marginBottom: 6 }}>
              {ELEMENT_TYPES.map(et => (
                <Button key={et.key} size="small" icon={<IconPlus />} onClick={() => addElement(et.key)}>{et.label}</Button>
              ))}
            </Space>
            {elements.map((el, idx) => {
              const isFromLib = LIB_ELEMENT_TYPES.includes(el.type)
              const hasResource = !!el.resource_id
              const urlField = MEDIA_URL_FIELD[el.type] || 'image_url'
              const urlValue = (el as any)[urlField] || ''
              const urlPlaceholder = urlField === 'audio_url' ? '参考音频URL'
                : urlField === 'video_url' ? '参考视频URL' : '参考图URL'
              return (
                <Row key={idx} gutter={8} style={{ marginBottom: 4, alignItems: 'center' }}>
                  <Col span={5}>
                    <Tag color={hasResource ? 'arcoblue' : undefined}>
                      {ELEMENT_TYPES.find(t => t.key === el.type)?.label}
                      {hasResource && ' ·库'}
                    </Tag>
                  </Col>
                  <Col span={isFromLib ? 9 : 11}>
                    <Input
                      size="small"
                      placeholder="名称"
                      value={el.name}
                      onChange={(v) => updateElement(idx, 'name', v)}
                      readOnly={hasResource}
                    />
                  </Col>
                  <Col span={isFromLib ? 4 : 6}>
                    {hasResource ? (
                      <span style={{ fontSize: 11, color: 'rgb(var(--success-6))' }}>✓ 已关联</span>
                    ) : (
                      <Input size="small" placeholder={urlPlaceholder} value={urlValue} onChange={(v) => updateElement(idx, urlField, v)} />
                    )}
                  </Col>
                  <Col span={isFromLib ? 4 : 2} style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
                    {isFromLib && (
                      <Button
                        size="small"
                        type="text"
                        icon={el.type === 'audio' ? <IconSound /> : el.type === 'video' ? <IconVideoCamera /> : <IconImage />}
                        title={hasResource ? '重新从素材库选择' : '从素材库选择'}
                        onClick={() => setPickerType(el.type as 'character' | 'scene' | 'prop' | 'audio' | 'video')}
                      />
                    )}
                    <Button size="small" icon={<IconDelete />} status="danger" onClick={() => removeElement(idx)} />
                  </Col>
                </Row>
              )
            })}

            {/* 描述（支持 @引用） */}
            <Space style={{ marginTop: 8, marginBottom: 4 }}>
              <Text>* 描述</Text>
              <Button size="mini" type="text" icon={<IconBulb />} onClick={() => setPrompt('请描述角色动作、表情、场景氛围、镜头运动...')}>一键填入提示词框架</Button>
            </Space>
            <div style={{ marginBottom: 12 }}>
              <PromptEditorLite
                value={prompt}
                onChange={setPrompt}
                projectId={projectId}
                placeholder="结合元素描述如何融合生成。输入 @ 可引用角色/场景/道具，例如 @沈如姬 站在 @咖啡厅 上"
                minHeight={100}
              />
            </div>

            {/* 尺寸+数量 */}
            <Row gutter={16} style={{ marginBottom: 12 }}>
              <Col span={12}>
                <Text style={{ display: 'block', marginBottom: 4 }}>* 图像尺寸</Text>
                <Radio.Group value={size} onChange={setSize}>
                  {ASPECT_RATIOS.map(r => <Radio key={r.value} value={r.value}>{r.value}</Radio>)}
                </Radio.Group>
              </Col>
              <Col span={12}>
                <Text style={{ display: 'block', marginBottom: 4 }}>* 生成数量</Text>
                <Radio.Group value={count} onChange={(v) => setCount(v)}>
                  {[1,2,3,4,5].map(n => <Radio key={n} value={n}>{n}</Radio>)}
                </Radio.Group>
              </Col>
            </Row>

            {/* 质量+水印 */}
            <Row gutter={16} style={{ marginBottom: 12 }}>
              <Col span={14}>
                <Text style={{ display: 'block', marginBottom: 4 }}>生成质量</Text>
                <Radio.Group value={quality} onChange={(v) => setQuality(v)}>
                  <Radio value="hd">hd（高质量·约20秒）</Radio>
                  <Radio value="standard">standard（快速·约8秒）</Radio>
                </Radio.Group>
              </Col>
              <Col span={10}>
                <Text style={{ display: 'block', marginBottom: 4 }}>水印</Text>
                <Switch checked={watermark} onChange={setWatermark} />
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{watermark ? '添加' : '不添加'}</Text>
              </Col>
            </Row>

            <Button type="primary" long loading={submitting} disabled={!panelModelId} onClick={handleGenerate}>
              {submitting ? '生成中...' : (panelModelId ? `提交任务（消耗${count}积分）` : '请先选择模型')}
            </Button>
            <Button long style={{ marginTop: 8 }} icon={<IconPlus />} onClick={openCreateClip}>新建分镜</Button>
          </Card>

          {/* 分镜列表（可编辑/删除） */}
          {clips.length > 0 && (
            <Card
              title={<span>分镜列表 ({clips.length})</span>}
              size="small"
              style={{ marginTop: 12 }}
              extra={<Button size="mini" type="text" icon={<IconPlus />} onClick={openCreateClip}>添加</Button>}
            >
              {clips.map((c: any) => {
                // 生成中状态：DB 的 generating 状态 或 本地刚提交的
                const isGenerating = c.status === 'generating' || generatingClipIds.has(c.id)
                return (
                <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Space size={6} style={{ marginBottom: 4 }}>
                        <Text bold>#{c.sequence}</Text>
                        <Tag size="small" color={isGenerating ? 'orange' : (SCENE_STATUS[c.status]?.color || 'orange')}>
                          {isGenerating ? '生成中' : (SCENE_STATUS[c.status]?.label || c.status)}
                        </Tag>
                        {c.duration && <Tag size="small">{c.duration}s</Tag>}
                        {c.resolution && <Tag size="small" color="arcoblue">{c.resolution}</Tag>}
                        {c.size && <Tag size="small">{c.size}</Tag>}
                      </Space>
                      <div style={{ fontSize: 13, display: 'block', color: 'var(--color-text-2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <HighlightPrompt prompt={c.prompt} projectId={projectId} fontSize={13} ellipsis style={{ color: 'var(--color-text-2)' }} />
                      </div>
                      {/* 已生成视频：显示视频缩略图（可点击预览） */}
                      {c.generated_video_url && !isGenerating && (
                        <div
                          style={{ marginTop: 6, position: 'relative', width: 120, height: 68, borderRadius: 4, overflow: 'hidden', cursor: 'pointer', background: 'var(--color-fill-3)' }}
                          onClick={(e) => { e.stopPropagation(); setPreviewMedia({ url: c.generated_video_url, isVideo: true }) }}
                        >
                          <video src={c.generated_video_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted preload="metadata" />
                          <IconPlayCircle style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: 24, color: 'rgba(255,255,255,0.8)' }} />
                        </div>
                      )}
                      {c.generated_video_url && !isGenerating && publishedUrls.has(c.generated_video_url) && (
                        <Tag size="small" color="green" style={{ marginTop: 4 }}>已发布画廊</Tag>
                      )}
                    </div>
                    <Space size={2}>
                      {c.generated_video_url && !isGenerating && (
                        publishedUrls.has(c.generated_video_url) ? (
                          <Button
                            size="mini"
                            type="text"
                            disabled
                            icon={<IconCheck style={{ color: 'rgb(var(--success-6))' }} />}
                            title="该视频已发布画廊，可在「作品画廊 → 我的作品」管理"
                          />
                        ) : (
                          <Button
                            size="mini"
                            type="text"
                            icon={<IconShareExternal />}
                            title="发布到作品展示"
                            onClick={() => setPublishTarget({
                              videoUrl: c.generated_video_url,
                              projectId,
                              episodeId,
                              defaultTitle: episode?.title ? `${episode.title} · 分镜#${c.sequence}` : `分镜#${c.sequence}`,
                              defaultTags: [],
                            })}
                          />
                        )
                      )}
                      <Button
                        size="mini"
                        type="primary"
                        icon={<IconVideoCamera />}
                        loading={isGenerating}
                        disabled={isGenerating}
                        onClick={() => openGenModal(c)}
                        title={isGenerating ? '生成中，请等待' : '生成视频'}
                      />
                      <Button size="mini" type="text" icon={<IconEdit />} onClick={() => openEditClip(c)} title="编辑" />
                      <Popconfirm title="确认删除该分镜？" onOk={() => handleDeleteClip(c.id)}>
                        <Button size="mini" type="text" status="danger" icon={<IconDelete />} title="删除" />
                      </Popconfirm>
                    </Space>
                  </div>
                </div>
                )
              })}
            </Card>
          )}
        </Col>

        {/* 右侧: 素材成果区 */}
        <Col span={11}>
          <Card size="small">
            <Tabs activeTab={matTab} onChange={setMatTab} size="small">
              {MATERIAL_TABS.map(t => (
                <TabPane key={t.key} title={<span>{t.icon} {t.label}</span>} />
              ))}
            </Tabs>
            <div style={{ marginTop: 8 }}>
              {renderMaterials()}
            </div>
          </Card>
        </Col>
      </Row>

      {/* 素材库选择器：添加角色/场景/物品时弹出，从企业素材库查找同步 */}
      {pickerType && projectId && (
        <MaterialPickerModal
          visible={!!pickerType}
          classType={pickerType}
          projectId={projectId}
          onSelect={handlePicked}
          onCancel={() => setPickerType(null)}
        />
      )}

      {/* 发布分镜成片到作品展示 */}
      <PublishWorkModal
        target={publishTarget}
        onCancel={() => setPublishTarget(null)}
        onPublished={() => {
          if (publishTarget?.videoUrl) {
            setPublishedUrls(s => new Set(s).add(publishTarget.videoUrl))
          }
        }}
      />

      {/* 分镜新建/编辑弹窗（支持 @引用提示词 + 分辨率） */}
      <Modal
        title={editingClip ? `编辑分镜 #${editingClip.sequence}` : '新建分镜'}
        visible={clipModalVisible}
        onCancel={() => setClipModalVisible(false)}
        onOk={handleSaveClip}
        confirmLoading={clipSaving}
        okText={editingClip ? '保存' : '添加'}
        cancelText="取消"
        style={{ width: 680, top: 30 }}
      >
        {/* 内容区限高内滚：引用资源多/提示词长时，编辑区始终可见，不顶出屏幕 */}
        <div style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
        {/* 已生成视频预览（编辑已有分镜时显示） */}
        {editingClip?.generated_video_url && (
          <div style={{ marginBottom: 16 }}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>已生成视频</Text>
            <video
              src={editingClip.generated_video_url}
              controls
              style={{ width: '100%', maxHeight: 240, borderRadius: 6, background: '#000' }}
            />
          </div>
        )}
        <Text style={{ display: 'block', marginBottom: 4 }}>提示词（输入 @ 可引用角色/场景/道具/音效/视频）</Text>
        <PromptEditorLite
          value={clipPrompt}
          onChange={setClipPrompt}
          projectId={projectId}
          placeholder="例如：@沈如姬 端坐沙发右侧，@林薇薇 斜靠沙发左侧，远景，暖棕暗金色调"
          minHeight={140}
        />
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={8}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>镜头类型</Text>
            <Select value={clipShotType} onChange={setClipShotType} style={{ width: '100%' }} size="small">
              {SHOT_TYPES.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>
          </Col>
          <Col span={5}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>时长（秒）</Text>
            <InputNumber value={clipDuration} onChange={(v) => setClipDuration(v || 5)} min={1} max={60} style={{ width: '100%' }} size="small" />
          </Col>
          <Col span={5}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>画面比例</Text>
            <Select value={clipSize} onChange={setClipSize} style={{ width: '100%' }} size="small">
              {ASPECT_RATIOS.map(r => <Select.Option key={r.value} value={r.value}>{r.label}</Select.Option>)}
            </Select>
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>分辨率</Text>
            <Select value={clipResolution} onChange={setClipResolution} style={{ width: '100%' }} size="small">
              {RESOLUTIONS.map(r => <Select.Option key={r} value={r}>{r}</Select.Option>)}
            </Select>
          </Col>
        </Row>
        <Row gutter={16} style={{ marginTop: 12 }}>
          <Col span={14}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>生成质量</Text>
            <Radio.Group value={clipQuality} onChange={(v) => setClipQuality(v)} size="small">
              <Radio value="hd">hd（高质量）</Radio>
              <Radio value="standard">standard（快速）</Radio>
            </Radio.Group>
          </Col>
          <Col span={10}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>水印</Text>
            <Switch size="small" checked={clipWatermark} onChange={setClipWatermark} />
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{clipWatermark ? '添加' : '不添加'}</Text>
          </Col>
        </Row>
        </div>
      </Modal>

      {/* 单镜生成弹窗：选模型/模式/参数 */}
      <Modal
        title={genClip ? `生成分镜 #${genClip.sequence}` : '生成分镜'}
        visible={genModalVisible}
        onCancel={() => setGenModalVisible(false)}
        onOk={handleGenSubmit}
        confirmLoading={genSubmitting}
        okText={genSubmitting ? '生成中...' : '开始生成'}
        cancelText="取消"
      >
        {genClip && (
          <div>
            {/* 已生成视频预览（如果该分镜之前已生成过） */}
            {genClip.generated_video_url && (
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>当前已生成视频（重新生成将覆盖）</Text>
                <video
                  src={genClip.generated_video_url}
                  controls
                  style={{ width: '100%', maxHeight: 200, borderRadius: 6, background: '#000' }}
                />
              </div>
            )}
            {/* 分镜提示词预览（只读） */}
            <div style={{ marginBottom: 12, padding: 10, background: 'var(--color-fill-2)', borderRadius: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>分镜提示词（@引用会自动展开）</Text>
              <div style={{ fontSize: 13, marginTop: 4, maxHeight: 60, overflow: 'auto', color: 'var(--color-text-2)' }}>
                <HighlightPrompt prompt={genClip.prompt} projectId={projectId} fontSize={13} style={{ color: 'var(--color-text-2)' }} />
              </div>
            </div>
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Text style={{ display: 'block', marginBottom: 4 }}>生成模型</Text>
                {genModelsLoading ? <Spin size={20} /> : (
                  <Select value={genModelId || undefined} onChange={setGenModelId} style={{ width: '100%' }} placeholder="系统默认（最高优先级）" allowClear>
                    {genModels.map((m: any) => (
                      <Select.Option key={m.id} value={m.id}>
                        {m.name}（{(m.config || {}).model || m.name}）
                      </Select.Option>
                    ))}
                  </Select>
                )}
              </Col>
              <Col span={12}>
                <Text style={{ display: 'block', marginBottom: 4 }}>生成模式</Text>
                <Select value={genMode} onChange={setGenMode} style={{ width: '100%' }}>
                  <Select.Option value="image_to_video">图生视频（首帧图片 → 视频）</Select.Option>
                  <Select.Option value="first_last_frame">首尾帧生成（首帧 + 尾帧 → 视频）</Select.Option>
                  <Select.Option value="fusion">融合生成（分镜 @引用资源图 → 参考生视频/图，按模型自动适配）</Select.Option>
                </Select>
              </Col>
            </Row>
            {/* 首尾帧模式：输入首帧/尾帧图片 URL */}
            {genMode === 'first_last_frame' && (
              <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
                <Col span={12}>
                  <Text style={{ display: 'block', marginBottom: 4 }}>首帧图片 URL（必填）</Text>
                  <Input
                    placeholder="https://... 或 /uploads/image/..."
                    value={genFirstFrame}
                    onChange={setGenFirstFrame}
                    allowClear
                  />
                </Col>
                <Col span={12}>
                  <Text style={{ display: 'block', marginBottom: 4 }}>尾帧图片 URL（可选）</Text>
                  <Input
                    placeholder="https://... 或 /uploads/image/..."
                    value={genLastFrame}
                    onChange={setGenLastFrame}
                    allowClear
                  />
                </Col>
              </Row>
            )}
            {/* 图生视频模式：可选首帧图片 */}
            {genMode === 'image_to_video' && (
              <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
                <Col span={24}>
                  <Text style={{ display: 'block', marginBottom: 4 }}>首帧图片 URL（可选，留空则纯文生视频）</Text>
                  <Input
                    placeholder="https://... 或 /uploads/image/..."
                    value={genFirstFrame}
                    onChange={setGenFirstFrame}
                    allowClear
                  />
                </Col>
              </Row>
            )}
            <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
              <Col span={6}>
                <Text style={{ display: 'block', marginBottom: 4 }}>画面比例</Text>
                <Select value={genSize} onChange={setGenSize}>
                  {ASPECT_RATIOS.map(r => <Select.Option key={r.value} value={r.value}>{r.label}</Select.Option>)}
                </Select>
              </Col>
              <Col span={6}>
                <Text style={{ display: 'block', marginBottom: 4 }}>时长（秒）</Text>
                <InputNumber min={2} max={60} value={genDuration} onChange={(v) => setGenDuration(v || 5)} style={{ width: '100%' }} />
              </Col>
              <Col span={6}>
                <Text style={{ display: 'block', marginBottom: 4 }}>分辨率</Text>
                <Select value={genResolution} onChange={setGenResolution}>
                  {RESOLUTIONS.map(r => <Select.Option key={r} value={r}>{r}</Select.Option>)}
                </Select>
              </Col>
              <Col span={6}>
                <Text style={{ display: 'block', marginBottom: 4 }}>质量</Text>
                <Select value={genQuality} onChange={(v) => setGenQuality(v)}>
                  <Select.Option value="hd">hd（高质量）</Select.Option>
                  <Select.Option value="standard">standard（快速）</Select.Option>
                </Select>
              </Col>
            </Row>
            <div style={{ marginTop: 8 }}>
              <Switch checked={genWatermark} onChange={setGenWatermark} />
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>添加水印</Text>
            </div>
          </div>
        )}
      </Modal>

      {/* Agent 向导（剧本驱动 4 阶段，对标巨日禄） */}
      {projectId && episodeId && (
        <WizardAgentModal
          visible={wizardVisible}
          projectId={projectId}
          episodeId={episodeId}
          onCancel={() => setWizardVisible(false)}
          onCompleted={loadAll}
        />
      )}

      {/* 媒体预览弹窗（素材区点击查看视频/图片大图） */}
      <Modal
        visible={!!previewMedia}
        onCancel={() => setPreviewMedia(null)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw', padding: 0 }}
      >
        {previewMedia?.isVideo ? (
          <video src={previewMedia.url} controls autoPlay
            style={{ maxWidth: '85vw', maxHeight: '80vh' }} />
        ) : (
          <img src={previewMedia?.url} alt="预览"
            style={{ maxWidth: '85vw', maxHeight: '80vh', objectFit: 'contain' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        )}
      </Modal>
    </div>
  )
}

export default EpisodeDetailPage
