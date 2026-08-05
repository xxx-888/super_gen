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
  Empty, Spin, Grid, Tabs, Drawer, Modal, Form, InputNumber, Popconfirm, Switch,
} from '@arco-design/web-react'
import {
  IconVideoCamera, IconImage, IconLeft, IconPlus, IconDelete, IconBulb,
  IconSound, IconRobot, IconEdit, IconStar, IconThunderbolt, IconRefresh, IconPlayCircle,
} from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { episodeService, creationService, taskService } from '@/api/services'
import { useTeamStore, useCreditStore } from '@/stores'
import { GenElementInput, CreationMode, SHOT_TYPES } from '@/types'
import MaterialPickerModal, { MaterialPickResult } from '@/components/material/MaterialPickerModal'
import AgentPanel from '@/components/agent/AgentPanel'
import WizardAgentModal from '@/components/agent/WizardAgentModal'
import PromptEditorLite from '@/components/editor/PromptEditorLite'
import { SCENE_STATUS } from '@/utils/statusLabels'

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
]

const SIZES = ['16:9', '9:16', '4:3', '3:4']
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

  // 定时刷新（10秒）：同步其他用户的生成状态变化（generating→completed/failed）
  useEffect(() => {
    const timer = setInterval(() => loadAll(), 10000)
    return () => clearInterval(timer)
  }, [loadAll])

  const addElement = (type: string) => {
    // 角色/场景/物品：从素材库选择（找不到可新建）；姿态/特效：直接加空行
    if (type === 'character' || type === 'scene' || type === 'prop') {
      setPickerType(type as 'character' | 'scene' | 'prop')
    } else {
      setElements([...elements, { type: type as any, name: '', image_url: '' }])
    }
  }
  const removeElement = (idx: number) => setElements(elements.filter((_, i) => i !== idx))
  const updateElement = (idx: number, field: string, value: string) =>
    setElements(elements.map((e, i) => i === idx ? { ...e, [field]: value } : e))

  // 素材库选择器：选中后同步到项目资源并回填为新元素
  const [pickerType, setPickerType] = useState<'character' | 'scene' | 'prop' | null>(null)
  // Agent 模式抽屉（快速单次生成）
  const [agentVisible, setAgentVisible] = useState(false)
  // Agent 向导（剧本驱动 4 阶段，对标巨日禄）
  const [wizardVisible, setWizardVisible] = useState(false)
  const handlePicked = (result: MaterialPickResult) => {
    setElements([...elements, {
      type: result.type as any,
      name: result.name,
      image_url: result.image_url || '',
      resource_id: result.resource_id,
      material_id: result.material_id || undefined,
    }])
    setPickerType(null)
    Message.success(`已添加${result.type === 'character' ? '角色' : result.type === 'scene' ? '场景' : '物品'}：${result.name}`)
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
        elements: elements.filter(e => e.name).map(e => ({ type: e.type, name: e.name, image_url: e.image_url || undefined })),
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

  const handleOneClickRender = async () => {
    if (!svc) return
    setRendering(true)
    try {
      const res: any = await svc.oneClickRender(episodeId!)
      const r = res?.data ?? res
      if (r.credits_consumed > 0) Message.success(`一键成片完成! 消耗${r.credits_consumed}积分`)
      else Message.info(r.message || '该集暂无分镜')
      loadBalance(); loadAll()
    } catch (e: any) { Message.error(e?.message || '失败') }
    finally { setRendering(false) }
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

  // 轮询单镜生成任务状态（3秒间隔，最多 4 分钟）
  const pollClipGen = (taskId: string, clipId: string) => {
    const maxAttempts = 120  // 120 × 3秒 = 6 分钟（MiniMax 视频生成可能需要 2-3 分钟）
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
        Message.warning('生成超时（6 分钟），请稍后在视频预览页查看结果')
      }
    }, 3000)
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
                        <video src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted preload="metadata" />
                        <IconPlayCircle style={{ position: 'absolute', fontSize: 32, color: 'rgba(255,255,255,0.8)' }} />
                      </>
                    ) : (
                      <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
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
          <Button icon={<IconRobot />} onClick={() => setAgentVisible(true)}>
            快速生成
          </Button>
          <Button type="primary" icon={<IconVideoCamera />} loading={rendering} onClick={handleOneClickRender}>
            一键成片
          </Button>
        </Space>
      </div>

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
            <Text style={{ display: 'block', marginBottom: 4 }}>元素 (角色/场景/物品/姿态/特效)</Text>
            <Space wrap size="small" style={{ marginBottom: 6 }}>
              {ELEMENT_TYPES.map(et => (
                <Button key={et.key} size="small" icon={<IconPlus />} onClick={() => addElement(et.key)}>{et.label}</Button>
              ))}
            </Space>
            {elements.map((el, idx) => {
              const isFromLib = el.type === 'character' || el.type === 'scene' || el.type === 'prop'
              const hasResource = !!el.resource_id
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
                      <Input size="small" placeholder="参考图URL" value={el.image_url} onChange={(v) => updateElement(idx, 'image_url', v)} />
                    )}
                  </Col>
                  <Col span={isFromLib ? 4 : 2} style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
                    {isFromLib && (
                      <Button
                        size="small"
                        type="text"
                        icon={<IconImage />}
                        title={hasResource ? '重新从素材库选择' : '从素材库选择'}
                        onClick={() => setPickerType(el.type as 'character' | 'scene' | 'prop')}
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
                  {SIZES.map(s => <Radio key={s} value={s}>{s}</Radio>)}
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
                      <Text style={{ fontSize: 13, display: 'block', color: 'var(--color-text-2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.prompt}
                      </Text>
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
                    </div>
                    <Space size={2}>
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

      {/* Agent 模式抽屉：自然语言目标 → 自动编排生成 */}
      <Drawer
        title={<span><IconRobot /> Agent 模式</span>}
        visible={agentVisible}
        onCancel={() => setAgentVisible(false)}
        width={480}
        footer={null}
      >
        {projectId && episodeId && (
          <AgentPanel
            projectId={projectId}
            episodeId={episodeId}
            onCompleted={loadAll}
          />
        )}
      </Drawer>

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
        <Text style={{ display: 'block', marginBottom: 4 }}>提示词（输入 @ 可引用角色/场景/道具）</Text>
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
              {SIZES.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
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
                {genClip.prompt}
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
                  <Select.Option value="fusion">融合生成（文本直接生视频）</Select.Option>
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
                  <Select.Option value="16:9">16:9 横屏</Select.Option>
                  <Select.Option value="9:16">9:16 竖屏</Select.Option>
                  <Select.Option value="4:3">4:3</Select.Option>
                  <Select.Option value="3:4">3:4</Select.Option>
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
