/**
 * ResourceManagePage - 资源管理
 *
 * Tab 切换：角色 / 场景背景 / 道具 / 音频
 * 每种资源支持：列表展示、创建、编辑、删除
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, Button, Modal, Form, Input, Message, Table, Spin, Tabs, Typography, Tag, Popconfirm, Empty, Select, Switch, Radio, Grid, Pagination, Upload, Space } from '@arco-design/web-react'
import { IconPlus, IconEdit, IconDelete, IconImage, IconUpload, IconStorage, IconExport, IconVideoCamera, IconSound } from '@arco-design/web-react/icon'
import { useParams, useSearchParams } from 'react-router-dom'
import { resourceService, materialLibraryService, projectService, creationService, uploadService } from '@/api/services'
import { useTeamStore } from '@/stores'
import { IMAGE_RATIOS } from '@/types'
import MaterialPickerModal from '@/components/material/MaterialPickerModal'
import { getTaskPollTimeout } from '@/hooks/useSiteConfig'

const { Row, Col } = Grid

const { Title, Text } = Typography
const { TabPane } = Tabs

// ==================== 通用资源管理 Hook ====================
function useResource<T>(service: any, projectId: string | undefined, enabled: boolean = true) {
  const [list, setList] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<T | null>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const data: any = await service.list(projectId)
      setList(Array.isArray(data) ? data : [])
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }

  // 只在 enabled（对应 tab 激活）时才加载
  useEffect(() => { if (enabled) load() }, [projectId, enabled])

  const openCreate = () => { setEditingItem(null); form.resetFields(); setModalVisible(true) }
  const openEdit = (item: T) => { setEditingItem(item); form.setFieldsValue(item); setModalVisible(true) }

  const handleSave = async (fields: Record<string, any>) => {
    setSaving(true)
    try {
      if (editingItem) {
        await service.update((editingItem as any).id, fields)
        Message.success('更新成功')
      } else {
        await service.create(projectId!, fields)
        Message.success('创建成功')
      }
      setModalVisible(false)
      load()
    } catch { /* 拦截器提示 */ } finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    await service.delete(id)
    Message.success('删除成功')
    load()
  }

  // 分页 + 搜索状态
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(12)
  const [search, setSearch] = useState('')
  // 按名称/描述过滤
  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter((item: any) =>
      (item.name || '').toLowerCase().includes(q) ||
      (item.description || '').toLowerCase().includes(q) ||
      (item.prompt || '').toLowerCase().includes(q),
    )
  }, [list, search])
  // 过滤后列表变化时，如果当前页超出范围则回到第1页
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredList.length / pageSize))
    if (page > maxPage) setPage(1)
  }, [filteredList.length, pageSize, page])

  return { list: filteredList, total: list.length, loading, modalVisible, editingItem, form, saving, openCreate, openEdit, handleSave, handleDelete, setModalVisible, reload: load, page, setPage, pageSize, setPageSize, search, setSearch }
}

// ==================== 主组件 ====================
const ResourceManagePage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  // 从 URL ?tab= 参数初始化（支持从项目详情跳转直达指定 tab）
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'characters')

  // 角色
  const charMgr = useResource(resourceService.characters, projectId, activeTab === 'characters')
  // 场景背景
  const bgMgr = useResource(resourceService.sceneBg, projectId, activeTab === 'scenes-bg')
  // 道具
  const propMgr = useResource(resourceService.props, projectId, activeTab === 'props')
  // 音频
  const audioMgr = useResource(resourceService.audio, projectId, activeTab === 'audio')
  // 视频（参考视频）
  const videoMgr = useResource(resourceService.video, projectId, activeTab === 'videos')

  // 视频文件上传（参考视频：先传 /upload/video 拿 URL，再建视频资产）
  const [videoUploading, setVideoUploading] = useState(false)
  const handleVideoUpload = async (file: File) => {
    if (!projectId) return
    setVideoUploading(true)
    try {
      const res: any = await uploadService.video(file)
      const url = res?.url || res?.data?.url
      if (!url) throw new Error('上传返回缺少 url')
      await resourceService.video.create(projectId, {
        name: file.name.replace(/\.[^.]+$/, ''),
        url,
      })
      Message.success('视频已上传')
      videoMgr.reload()
    } catch { /* 拦截器提示 */ } finally { setVideoUploading(false) }
  }

  // 同步到素材库
  const { currentOrg } = useTeamStore()
  // 用项目真实所属 org_id（避免 currentOrg 与项目归属不一致导致素材同步到错误团队）
  const [projectOrgId, setProjectOrgId] = useState<string | null>(null)
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    projectService.get(projectId)
      .then((res: any) => { if (!cancelled) setProjectOrgId((res?.data ?? res)?.org_id ?? null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId])
  const [syncing, setSyncing] = useState<string | null>(null)
  // 已同步到素材库的 url 集合（按当前 tab 的 class_type 拉取），用于标记/禁用重复同步
  const [syncedUrls, setSyncedUrls] = useState<Set<string>>(new Set())
  // 业务类型 → 素材库 class_type
  const typeToClassType = (t: 'characters' | 'sceneBg' | 'props') =>
    t === 'characters' ? 'character' : t === 'sceneBg' ? 'scene' : 'prop'
  // tab → 业务类型
  const tabToType = (tab: string): 'characters' | 'sceneBg' | 'props' | null =>
    tab === 'characters' ? 'characters' : tab === 'scenes-bg' ? 'sceneBg' : tab === 'props' ? 'props' : null

  const loadSyncedUrls = useCallback(async (classType: string) => {
    const orgId = projectOrgId ?? currentOrg?.id
    if (!orgId) { setSyncedUrls(new Set()); return }
    try {
      const res: any = await materialLibraryService(orgId).listUrls(classType)
      const urls = (res?.data ?? res)?.urls ?? []
      setSyncedUrls(new Set(Array.isArray(urls) ? urls : []))
    } catch {
      setSyncedUrls(new Set())
    }
  }, [projectOrgId, currentOrg?.id])

  // 切换 tab 时刷新该类目的「已同步」集合
  useEffect(() => {
    const t = tabToType(activeTab)
    if (t) loadSyncedUrls(typeToClassType(t))
  }, [activeTab, loadSyncedUrls])

  const handleSyncToLibrary = async (item: any, type: 'characters' | 'sceneBg' | 'props') => {
    const orgId = projectOrgId ?? currentOrg?.id
    if (!orgId) { Message.warning('请先切换到某个团队'); return }
    if (!item.image_url) { Message.warning('请先为该资源生成图片'); return }
    // 前端预检：已同步则直接提示，避免无谓请求
    if (syncedUrls.has(item.image_url)) {
      Message.warning(`「${item.name}」已在素材库中，无需重复同步`)
      return
    }
    const classType = typeToClassType(type)
    const meta: Record<string, any> = {}
    if (item.appearance_prompt) meta.appearance_prompt = item.appearance_prompt
    if (item.prompt) meta.prompt = item.prompt
    if (item.description) meta.description = item.description
    setSyncing(item.id)
    try {
      await materialLibraryService(orgId).fromUrl({
        url: item.image_url,
        name: item.name,
        category: 'image',
        class_type: classType,
        meta,
      })
      Message.success(`已同步「${item.name}」到企业素材库`)
      setSyncedUrls(prev => new Set(prev).add(item.image_url)) // 标记为已同步
    } catch (e: any) {
      const status = e?.response?.status
      const detail = e?.response?.data?.detail
      if (status === 409) {
        // 后端确认重复：标记为已同步，提示友好
        setSyncedUrls(prev => new Set(prev).add(item.image_url))
        Message.warning(detail || '该资源已在素材库中，无需重复同步')
      } else {
        Message.error(detail || '同步失败')
      }
    } finally {
      setSyncing(null)
    }
  }

  // 素材库导入弹窗（character/scene/prop/audio/video 共用）
  const [pickerType, setPickerType] = useState<'character' | 'scene' | 'prop' | 'audio' | 'video' | null>(null)
  const handleImportFromLibrary = async (result: { resource_id: string; type: string }) => {
    setPickerType(null)
    Message.success('已从素材库导入')
    // 刷新对应 tab 的列表
    if (result.type === 'character') charMgr.reload()
    else if (result.type === 'scene') bgMgr.reload()
    else if (result.type === 'prop') propMgr.reload()
    else if (result.type === 'audio') audioMgr.reload()
    else if (result.type === 'video') videoMgr.reload()
  }
  // AI 生图（单个/批量共用一套选项）
  const [generating, setGenerating] = useState<string | null>(null)
  // 生图选项弹窗
  const [genOptVisible, setGenOptVisible] = useState(false)
  const [genOptTarget, setGenOptTarget] = useState<{ type: 'characters' | 'sceneBg' | 'props'; id?: string; mgr: any; isBatch: boolean } | null>(null)
  const [genSize, setGenSize] = useState<string>('16:9')
  const [genQuality, setGenQuality] = useState<'hd' | 'standard'>('hd')
  const [genWatermark, setGenWatermark] = useState(false)
  const [genModel, setGenModel] = useState<string>('')
  // 动态加载可用的文生图模型（替代硬编码列表）
  const [imageModels, setImageModels] = useState<any[]>([])
  useEffect(() => {
    creationService.models.list({ type: 'text_to_image' }).then((res: any) => {
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setImageModels(list)
    }).catch(() => {})
  }, [])

  // 打开生图选项弹窗（单条）
  const openGenModal = (type: 'characters' | 'sceneBg' | 'props', id: string, mgr: any) => {
    // 按类型设默认尺寸
    setGenSize(type === 'props' ? '1:1' : '16:9')
    setGenQuality('hd')
    setGenWatermark(false)
    setGenModel('')
    setGenOptTarget({ type, id, mgr, isBatch: false })
    setGenOptVisible(true)
  }

  // 打开生图选项弹窗（批量）
  const openBatchGenModal = (type: 'characters' | 'sceneBg' | 'props', mgr: any) => {
    setGenSize(type === 'props' ? '1:1' : '16:9')
    setGenQuality('standard')  // 批量默认用快速
    setGenWatermark(false)
    setGenModel('')
    setGenOptTarget({ type, mgr, isBatch: true })
    setGenOptVisible(true)
  }

  // 轮询生图任务状态（超时上限跟随后台「系统设置」的 task_poll_timeout_seconds）
  const pollGenStatus = async (taskId: string, onDone: (success: boolean, error?: string) => void) => {
    const intervalSec = 3
    // +10 次冗余：确保前端不会比后端先放弃
    const maxAttempts = Math.ceil(getTaskPollTimeout() / intervalSec) + 10
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, intervalSec * 1000))
      try {
        const res: any = await resourceService.generateStatus(taskId)
        const task = res?.data ?? res
        if (task.status === 'completed') { onDone(true); return }
        if (task.status === 'failed') { onDone(false, task.error); return }
        // processing → 继续轮询
      } catch { /* 忽略网络错误，继续轮询 */ }
    }
    const mins = Math.round((maxAttempts * intervalSec) / 60)
    onDone(false, `生成超时（约 ${mins} 分钟）`)
  }

  // 确认生图（执行）
  const handleGenerateImage = async () => {
    if (!genOptTarget) return
    const { type, id, mgr, isBatch } = genOptTarget
    const options: any = { quality: genQuality, watermark_enabled: genWatermark }
    if (genSize) options.size = genSize
    if (genModel) options.model = genModel
    setGenOptVisible(false)

    if (isBatch) {
      // 批量：并发提交所有，然后等全部完成。
      // 已有图片的项也纳入（一键批量=补齐+重新生成），仅跳过正在生成中的
      const items = mgr.list.filter((r: any) => r.meta?.gen_status !== 'generating')
      if (items.length === 0) { Message.info('没有可生成的项（均在生成中，请稍候）'); return }
      const regenCount = items.filter((r: any) => r.image_url).length
      Message.info(`开始批量生成 ${items.length} 项${regenCount > 0 ? `（其中 ${regenCount} 项已有图片，将重新生成）` : ''}...`)
      setGenerating('batch')
      // 并发提交所有
      const taskIds: Array<{ id: string; taskId: string }> = []
      let submitFail = 0
      for (const item of items) {
        try {
          const res: any = await resourceService[type].generateImage(item.id, options)
          const taskId = res?.data?.task_id ?? res?.task_id
          if (taskId) taskIds.push({ id: item.id, taskId })
          else submitFail++
        } catch (e: any) {
          submitFail++
        }
      }
      // 并发轮询所有任务
      let ok = 0
      await Promise.all(taskIds.map(({ taskId }) =>
        new Promise<void>((resolve) => {
          pollGenStatus(taskId, (success) => { if (success) ok++; resolve() })
        })
      ))
      const failNote = submitFail > 0 ? `，提交失败 ${submitFail}（可能正在生成中）` : ''
      Message.success(`批量完成: ${ok}/${taskIds.length}（共提交 ${taskIds.length}/${items.length}${failNote}）`)
      setGenerating(null)
      mgr.reload()
    } else {
      // 单条：提交 → 轮询
      setGenerating(id || null)
      Message.info('生成已提交，请稍候...')
      try {
        const res: any = await resourceService[type].generateImage(id!, options)
        const taskId = res?.data?.task_id ?? res?.task_id
        if (!taskId) { Message.success('AI 生图完成'); mgr.reload(); setGenerating(null); return }
        // 轮询
        pollGenStatus(taskId, (success, error) => {
          if (success) {
            Message.success('AI 生图完成')
            mgr.reload()
          } else {
            Message.error(error || '生图失败')
          }
          setGenerating(null)
        })
      } catch (e: any) {
        Message.error(e?.response?.data?.detail || '提交失败')
        setGenerating(null)
      }
    }
  }

  // 角色列
  const charColumns = [
    { title: '名称', dataIndex: 'name', width: 120 },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: '外观提示词', dataIndex: 'appearance_prompt', ellipsis: true },
    { title: '状态', dataIndex: 'image_url', width: 90, render: (v: string) => v ? <Tag color="green" size="small">已生成</Tag> : <Tag color="orange" size="small">待生成</Tag> },
    { title: '操作', width: 180, render: (_: any, row: any) => (
      <span style={{ display: 'flex', gap: 4 }}>
        <Button size="mini" icon={<IconImage />} loading={generating === row.id} onClick={() => openGenModal('characters', row.id, charMgr)}>AI生图</Button>
        <Button size="mini" icon={<IconEdit />} onClick={() => charMgr.openEdit(row)} />
        <Popconfirm title="确认删除？" onOk={() => charMgr.handleDelete(row.id)}>
          <Button size="mini" icon={<IconDelete />} status="danger" />
        </Popconfirm>
      </span>
    )},
  ]

  // 场景背景列
  const bgColumns = [
    { title: '名称', dataIndex: 'name', width: 120 },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: '提示词', dataIndex: 'prompt', ellipsis: true },
    { title: '状态', dataIndex: 'image_url', width: 90, render: (v: string) => v ? <Tag color="green" size="small">已生成</Tag> : <Tag color="orange" size="small">待生成</Tag> },
    { title: '操作', width: 180, render: (_: any, row: any) => (
      <span style={{ display: 'flex', gap: 4 }}>
        <Button size="mini" icon={<IconImage />} loading={generating === row.id} onClick={() => openGenModal('sceneBg', row.id, bgMgr)}>AI生图</Button>
        <Button size="mini" icon={<IconEdit />} onClick={() => bgMgr.openEdit(row)} />
        <Popconfirm title="确认删除？" onOk={() => bgMgr.handleDelete(row.id)}>
          <Button size="mini" icon={<IconDelete />} status="danger" />
        </Popconfirm>
      </span>
    )},
  ]

  // 道具列（同场景背景结构）
  const propColumns = [
    { title: '名称', dataIndex: 'name', width: 120 },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: '提示词', dataIndex: 'prompt', ellipsis: true },
    { title: '状态', dataIndex: 'image_url', width: 90, render: (v: string) => v ? <Tag color="green" size="small">已生成</Tag> : <Tag color="orange" size="small">待生成</Tag> },
    { title: '操作', width: 180, render: (_: any, row: any) => (
      <span style={{ display: 'flex', gap: 4 }}>
        <Button size="mini" icon={<IconImage />} loading={generating === row.id} onClick={() => openGenModal('props', row.id, propMgr)}>AI生图</Button>
        <Button size="mini" icon={<IconEdit />} onClick={() => propMgr.openEdit(row)} />
        <Popconfirm title="确认删除？" onOk={() => propMgr.handleDelete(row.id)}>
          <Button size="mini" icon={<IconDelete />} status="danger" />
        </Popconfirm>
      </span>
    )},
  ]

  // 音频列
  const audioColumns = [
    { title: '名称', dataIndex: 'name', width: 120 },
    { title: '类型', dataIndex: 'type', width: 80, render: (v: string) => {
      const m: Record<string,string> = { dialogue: '对白', music: '音乐', sfx: '音效', narration: '旁白' }
      return <Tag size="small">{m[v] || v}</Tag>
    }},
    { title: '试听', dataIndex: 'url', width: 220, render: (v: string, row: any) => v ? (
      <audio src={v} controls preload="none" style={{ width: 200, height: 32 }} />
    ) : <Text type="secondary" style={{ fontSize: 12 }}>无音频</Text> },
    { title: '内容', dataIndex: 'content', ellipsis: true },
    { title: '时长', dataIndex: 'duration', width: 80, render: (v: number) => v ? `${v}s` : '-' },
    { title: '操作', width: 120, render: (_: any, row: any) => (
      <span style={{ display: 'flex', gap: 8 }}>
        <Button size="small" icon={<IconEdit />} onClick={() => audioMgr.openEdit(row)} />
        <Popconfirm title="确认删除？" onOk={() => audioMgr.handleDelete(row.id)}>
          <Button size="small" icon={<IconDelete />} status="danger" />
        </Popconfirm>
      </span>
    )},
  ]

  // 视频列（参考视频）
  const videoColumns = [
    { title: '预览', dataIndex: 'url', width: 100, render: (_: any, row: any) => (
      <div
        style={{ cursor: 'pointer', position: 'relative', width: 72, height: 44 }}
        onClick={() => row.url && setPreviewVideo(row.url)}
        title="点击播放"
      >
        {row.thumbnail_url
          ? <img src={row.thumbnail_url} style={{ width: 72, height: 44, objectFit: 'cover', borderRadius: 4 }} />
          : <video src={row.url} muted preload="metadata" style={{ width: 72, height: 44, objectFit: 'cover', borderRadius: 4, background: '#000', display: 'block' }} />}
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 12, background: 'rgba(0,0,0,0.25)', borderRadius: 4, pointerEvents: 'none',
        }}>▶</div>
      </div>
    )},
    { title: '名称', dataIndex: 'name', width: 140 },
    { title: '类型', dataIndex: 'type', width: 90, render: (v: string) => {
      const m: Record<string,string> = { reference: '参考视频', shot: '镜头素材', 'b-roll': '空镜' }
      return <Tag size="small">{m[v] || v}</Tag>
    }},
    { title: '描述', dataIndex: 'content', ellipsis: true },
    { title: '时长', dataIndex: 'duration', width: 80, render: (v: number) => v ? `${v}s` : '-' },
    { title: '操作', width: 120, render: (_: any, row: any) => (
      <span style={{ display: 'flex', gap: 8 }}>
        <Button size="small" icon={<IconEdit />} onClick={() => videoMgr.openEdit(row)} />
        <Popconfirm title="确认删除？" onOk={() => videoMgr.handleDelete(row.id)}>
          <Button size="small" icon={<IconDelete />} status="danger" />
        </Popconfirm>
      </span>
    )},
  ]

  // 图片预览（点击卡片图片看大图）
  const [previewImg, setPreviewImg] = useState<string | null>(null)
  // 视频播放预览（视频管理表格点击）
  const [previewVideo, setPreviewVideo] = useState<string | null>(null)

  // AI 生成音频（TTS）
  const [audioGenVisible, setAudioGenVisible] = useState(false)
  const [audioGenLoading, setAudioGenLoading] = useState(false)
  const [audioGenForm] = Form.useForm()
  const handleAudioGenerate = async () => {
    const fields = await audioGenForm.validate()
    setAudioGenLoading(true)
    try {
      await resourceService.audio.generate(projectId!, {
        name: fields.name, text: fields.text,
        type: fields.type || 'dialogue', voice: fields.voice || undefined,
      })
      Message.success('音频已生成')
      setAudioGenVisible(false)
      audioGenForm.resetFields()
      audioMgr.reload()
    } catch { /* 拦截器提示（如未配置 TTS 模型） */ } finally { setAudioGenLoading(false) }
  }

  // 通用资源卡片网格渲染（角色/场景/道具共用）
  const renderResourceGrid = (
    mgr: any,
    type: 'characters' | 'sceneBg' | 'props',
    label: string,
  ) => {
    if (mgr.loading) return <Spin />
    if (mgr.list.length === 0 && !mgr.search) return <Empty description={`暂无${label}，点击上方按钮创建或导入`} style={{ marginTop: 40 }} />
    // 客户端分页切片
    const start = (mgr.page - 1) * mgr.pageSize
    const pageItems = mgr.list.slice(start, start + mgr.pageSize)
    return (
      <>
      {/* 搜索框 */}
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <Input
          placeholder={`搜索${label}名称...`}
          value={mgr.search}
          onChange={mgr.setSearch}
          allowClear
          style={{ width: 220 }}
          size="small"
        />
      </div>
      {mgr.list.length === 0 ? <Empty description={`未找到匹配「${mgr.search}」的${label}`} style={{ marginTop: 40 }} /> : (
      <Row gutter={[12, 12]}>
        {pageItems.map((item: any) => (
          <Col key={item.id} xs={12} sm={8} md={6} lg={4}>
            <Card
              size="small"
              hoverable
              bodyStyle={{ padding: 8 }}
              cover={
                <div
                  style={{
                    position: 'relative', aspectRatio: '3/4',
                    background: 'var(--color-fill-3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden', cursor: item.image_url ? 'pointer' : 'default',
                  }}
                  onClick={() => item.image_url && setPreviewImg(item.image_url)}
                >
                  {item.image_url ? (
                    <img src={item.image_url} alt={item.name}
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                  ) : (
                    <div style={{ textAlign: 'center', color: 'var(--color-text-3)' }}>
                      <IconImage style={{ fontSize: 28 }} />
                      <div style={{ fontSize: 11, marginTop: 4 }}>未生成</div>
                    </div>
                  )}
                  {/* 状态角标 */}
                  <div style={{ position: 'absolute', top: 4, right: 4 }}>
                    {(() => {
                      const gs = item.meta?.gen_status
                      if (gs === 'generating') return <Tag size="small" color="arcoblue">生成中</Tag>
                      if (gs === 'failed') return <Tag size="small" color="red">失败</Tag>
                      if (item.image_url) return <Tag size="small" color="green">已生成</Tag>
                      return <Tag size="small" color="orange">待生成</Tag>
                    })()}
                  </div>
                  {/* 角色/主角标记 */}
                  {item.role && (
                    <div style={{ position: 'absolute', top: 4, left: 4 }}>
                      <Tag size="small" color="purple">{item.role}</Tag>
                    </div>
                  )}
                </div>
              }
            >
              <Text style={{ fontWeight: 600, fontSize: 13, display: 'block',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </Text>
              <div style={{ display: 'flex', gap: 2, marginTop: 4, justifyContent: 'space-between' }}>
                <Button size="mini" type="text" icon={<IconImage />}
                  loading={generating === item.id || item.meta?.gen_status === 'generating'}
                  disabled={item.meta?.gen_status === 'generating' && generating !== item.id}
                  onClick={() => openGenModal(type, item.id, mgr)}
                  title={item.meta?.gen_status === 'generating' ? '生成中...' : 'AI生图'} />
                <Button size="mini" type="text" icon={<IconExport />}
                  loading={syncing === item.id}
                  disabled={!item.image_url || syncedUrls.has(item.image_url)}
                  onClick={() => handleSyncToLibrary(item, type)}
                  title={!item.image_url ? '需先生成图片' : syncedUrls.has(item.image_url) ? '已在素材库中' : '同步到素材库'} />
                <Button size="mini" type="text" icon={<IconEdit />}
                  onClick={() => mgr.openEdit(item)} title="编辑" />
                <Popconfirm title="确认删除？" onOk={() => mgr.handleDelete(item.id)}>
                  <Button size="mini" type="text" status="danger" icon={<IconDelete />} title="删除" />
                </Popconfirm>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
      )}
      {mgr.list.length > mgr.pageSize && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
          <Pagination
            current={mgr.page}
            pageSize={mgr.pageSize}
            total={mgr.list.length}
            showTotal
            sizeOptions={[12, 24, 48]}
            onChange={(p, ps) => { mgr.setPage(p); mgr.setPageSize(ps) }}
          />
        </div>
      )}
      </>
    )
  }

  // 通用 Modal 渲染
  const renderModal = (mgr: any, title: string, fields: Array<{ name: string; label: string; type?: string; required?: boolean }>) => (
    <Modal
      title={mgr.editingItem ? `编辑${title}` : `创建${title}`}
      visible={mgr.modalVisible}
      onCancel={() => mgr.setModalVisible(false)}
      onOk={() => mgr.form.validate().then(mgr.handleSave)}
      confirmLoading={mgr.saving}
      okText="保存"
      cancelText="取消"
    >
      <Form form={mgr.form} layout="vertical">
        {fields.map((f) => (
          <Form.Item key={f.name} field={f.name} label={f.label} rules={
            f.name === 'name'
              ? [
                  { required: true, message: `请输入${f.label}` },
                  {
                    validator: (val: string | undefined, callback: (msg?: string) => void) => {
                      const v = (val || '').trim()
                      if (!v) { callback(); return }
                      // 前端本地校验：同一项目下同名不可重复（排除自身）
                      const dup = mgr.list.find((item: any) =>
                        item.name === v && (!mgr.editingItem || item.id !== mgr.editingItem.id)
                      )
                      if (dup) {
                        callback(`该项目下已存在同名${title}「${v}」，名称不可重复`)
                      } else {
                        callback()
                      }
                    },
                  },
                ]
              : f.required ? [{ required: true, message: `请输入${f.label}` }] : []
          }>
            {f.type === 'textarea' ? <Input.TextArea rows={3} /> : <Input />}
          </Form.Item>
        ))}
      </Form>
    </Modal>
  )

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>资源管理</Title>
      <Tabs activeTab={activeTab} onChange={(k: string) => setActiveTab(k)}>
        {/* 角色 */}
        <TabPane key="characters" title="角色管理">
          <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
            <Button type="primary" icon={<IconPlus />} onClick={charMgr.openCreate}>创建角色</Button>
            <Button icon={<IconStorage />} onClick={() => setPickerType('character')}>从素材库导入</Button>
            <Button icon={<IconImage />} onClick={() => openBatchGenModal('characters', charMgr)}>AI一键批量生成</Button>
          </div>
          {renderResourceGrid(charMgr, 'characters', '角色')}
          {renderModal(charMgr, '角色', [
            { name: 'name', label: '名称', required: true },
            { name: 'description', label: '描述', type: 'textarea' },
            { name: 'appearance_prompt', label: '外观提示词（用于文生图）', type: 'textarea' },
          ])}
        </TabPane>

        {/* 场景背景 */}
        <TabPane key="scenes-bg" title="场景管理">
          <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
            <Button type="primary" icon={<IconPlus />} onClick={bgMgr.openCreate}>创建场景</Button>
            <Button icon={<IconStorage />} onClick={() => setPickerType('scene')}>从素材库导入</Button>
            <Button icon={<IconImage />} onClick={() => openBatchGenModal('sceneBg', bgMgr)}>AI一键批量生成</Button>
          </div>
          {renderResourceGrid(bgMgr, 'sceneBg', '场景')}
          {renderModal(bgMgr, '场景背景', [
            { name: 'name', label: '名称', required: true },
            { name: 'description', label: '描述', type: 'textarea' },
            { name: 'prompt', label: '提示词', type: 'textarea' },
          ])}
        </TabPane>

        {/* 道具 */}
        <TabPane key="props" title="物品管理">
          <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
            <Button type="primary" icon={<IconPlus />} onClick={propMgr.openCreate}>创建道具</Button>
            <Button icon={<IconStorage />} onClick={() => setPickerType('prop')}>从素材库导入</Button>
            <Button icon={<IconImage />} onClick={() => openBatchGenModal('props', propMgr)}>AI一键批量生成</Button>
          </div>
          {renderResourceGrid(propMgr, 'props', '物品')}
          {renderModal(propMgr, '道具', [
            { name: 'name', label: '名称', required: true },
            { name: 'description', label: '描述', type: 'textarea' },
            { name: 'prompt', label: '提示词', type: 'textarea' },
          ])}
        </TabPane>

        {/* 音频 */}
        <TabPane key="audio" title="音效管理">
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <Button type="primary" icon={<IconPlus />} onClick={audioMgr.openCreate}>创建音频</Button>
              <Button icon={<IconSound />} onClick={() => setAudioGenVisible(true)}>AI 生成音频</Button>
              <Button icon={<IconStorage />} onClick={() => setPickerType('audio')}>从素材库导入</Button>
            </Space>
            <Input
              placeholder="搜索音效名称..."
              value={audioMgr.search}
              onChange={audioMgr.setSearch}
              allowClear
              style={{ width: 220 }}
              size="small"
            />
          </div>
          {audioMgr.loading ? <Spin /> : (
            <Table columns={audioColumns} data={audioMgr.list} rowKey="id" pagination={{ pageSize: 10 }} />
          )}
          {/* AI 生成音频弹窗 */}
          <Modal
            title="AI 生成音频（语音合成）"
            visible={audioGenVisible}
            onCancel={() => setAudioGenVisible(false)}
            onOk={handleAudioGenerate}
            confirmLoading={audioGenLoading}
            okText="生成"
            cancelText="取消"
          >
            <Form form={audioGenForm} layout="vertical" initialValues={{ type: 'dialogue' }}>
              <Form.Item field="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
                <Input placeholder="如：宋月独白-第一集" />
              </Form.Item>
              <Form.Item field="type" label="类型">
                <Select>
                  <Select.Option value="dialogue">对白</Select.Option>
                  <Select.Option value="narration">旁白</Select.Option>
                  <Select.Option value="sfx">音效</Select.Option>
                  <Select.Option value="music">音乐</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item field="text" label="合成文本" rules={[{ required: true, message: '请输入要合成的文本' }]}>
                <Input.TextArea rows={4} placeholder="要转成语音的文本内容" />
              </Form.Item>
              <Form.Item field="voice" label="音色（可选）">
                <Input placeholder="留空用模型默认音色；如 FunAudioLLM/CosyVoice2-0.5B:alex" />
              </Form.Item>
            </Form>
          </Modal>
          <Modal
            title={audioMgr.editingItem ? '编辑音频' : '创建音频'}
            visible={audioMgr.modalVisible}
            onCancel={() => audioMgr.setModalVisible(false)}
            onOk={() => audioMgr.form.validate().then(audioMgr.handleSave)}
            confirmLoading={audioMgr.saving}
            okText="保存"
            cancelText="取消"
          >
            <Form form={audioMgr.form} layout="vertical">
              <Form.Item field="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
                <Input />
              </Form.Item>
              <Form.Item field="type" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
                <Input placeholder="dialogue / music / sfx / narration" />
              </Form.Item>
              <Form.Item field="url" label="音频URL" rules={[{ required: true, message: '请输入URL' }]}>
                <Input placeholder="https://..." />
              </Form.Item>
              <Form.Item field="content" label="内容/台词">
                <Input.TextArea rows={3} />
              </Form.Item>
              <Form.Item field="duration" label="时长（秒）">
                <Input type="number" placeholder="5.0" />
              </Form.Item>
            </Form>
          </Modal>
        </TabPane>

        {/* 视频（参考视频） */}
        <TabPane key="videos" title="视频管理">
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <Upload
                accept="video/*"
                showUploadList={false}
                customRequest={(option: any) => { handleVideoUpload(option.file as File); option.onSuccess?.({}) }}
              >
                <Button type="primary" icon={<IconVideoCamera />} loading={videoUploading}>上传视频</Button>
              </Upload>
              <Button icon={<IconPlus />} onClick={videoMgr.openCreate}>按 URL 添加</Button>
              <Button icon={<IconStorage />} onClick={() => setPickerType('video')}>从素材库导入</Button>
            </Space>
            <Input
              placeholder="搜索视频名称..."
              value={videoMgr.search}
              onChange={videoMgr.setSearch}
              allowClear
              style={{ width: 220 }}
              size="small"
            />
          </div>
          {videoMgr.loading ? <Spin /> : (
            <Table columns={videoColumns} data={videoMgr.list} rowKey="id" pagination={{ pageSize: 10 }} />
          )}
          <Modal
            title={videoMgr.editingItem ? '编辑视频' : '添加视频'}
            visible={videoMgr.modalVisible}
            onCancel={() => videoMgr.setModalVisible(false)}
            onOk={() => videoMgr.form.validate().then(videoMgr.handleSave)}
            confirmLoading={videoMgr.saving}
            okText="保存"
            cancelText="取消"
          >
            <Form form={videoMgr.form} layout="vertical">
              <Form.Item field="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
                <Input />
              </Form.Item>
              <Form.Item field="type" label="类型" initialValue="reference">
                <Select>
                  <Select.Option value="reference">参考视频</Select.Option>
                  <Select.Option value="shot">镜头素材</Select.Option>
                  <Select.Option value="b-roll">空镜</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item field="url" label="视频URL" rules={[{ required: true, message: '请输入URL' }]}>
                <Input placeholder="https://... 或 /uploads/video/..." />
              </Form.Item>
              <Form.Item field="content" label="描述">
                <Input.TextArea rows={3} placeholder="视频内容描述（如：手持跟拍的夜市镜头）" />
              </Form.Item>
              <Form.Item field="duration" label="时长（秒）">
                <Input type="number" placeholder="5.0" />
              </Form.Item>
            </Form>
          </Modal>
        </TabPane>
      </Tabs>

      {/* 素材库导入弹窗（三类共用） */}
      {pickerType && projectId && (
        <MaterialPickerModal
          visible={!!pickerType}
          classType={pickerType}
          projectId={projectId}
          onSelect={handleImportFromLibrary}
          onCancel={() => setPickerType(null)}
        />
      )}

      {/* AI 生图选项弹窗（单条/批量共用） */}
      <Modal
        title={genOptTarget?.isBatch ? '批量 AI 生图设置' : 'AI 生图设置'}
        visible={genOptVisible}
        onCancel={() => setGenOptVisible(false)}
        onOk={handleGenerateImage}
        okText={genOptTarget?.isBatch ? '开始批量生成' : '开始生成'}
        cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>画面尺寸</Text>
          <Radio.Group value={genSize} onChange={setGenSize}>
            {IMAGE_RATIOS.map(r => <Radio key={r.value} value={r.value}>{r.value}</Radio>)}
          </Radio.Group>
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>生成模型</Text>
          <Select value={genModel || undefined} onChange={setGenModel} style={{ width: '100%' }}
            placeholder="系统默认（最高优先级）" allowClear
            notFoundContent="暂无可用模型，请在后台配置">
            {imageModels.map((m: any) => (
              <Select.Option key={m.id} value={m.id}>
                {m.name}（{(m.config || {}).model || m.name}）
              </Select.Option>
            ))}
          </Select>
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>生成质量</Text>
          <Radio.Group value={genQuality} onChange={(v) => setGenQuality(v)}>
            <Radio value="hd">hd（高质量·约20秒）</Radio>
            <Radio value="standard">standard（快速·约8秒）</Radio>
          </Radio.Group>
        </div>
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>水印</Text>
          <Switch checked={genWatermark} onChange={setGenWatermark} />
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            {genWatermark ? '添加水印' : '不添加（需已签署免责声明）'}
          </Text>
        </div>
      </Modal>

      {/* 图片大图预览 */}
      <Modal
        visible={!!previewImg}
        onCancel={() => setPreviewImg(null)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw', padding: 0 }}
      >
        {previewImg && (
          <img src={previewImg} alt="预览"
            style={{ width: '100%', maxHeight: '80vh', objectFit: 'contain', display: 'block' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}
      </Modal>

      {/* 视频播放预览 */}
      <Modal
        visible={!!previewVideo}
        onCancel={() => setPreviewVideo(null)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw', padding: 0 }}
      >
        {previewVideo && (
          <video
            src={previewVideo}
            controls
            autoPlay
            style={{ width: '100%', maxHeight: '80vh', background: '#000', display: 'block' }}
            onError={() => Message.error('视频加载失败（文件可能已被删除，请重新上传）')}
          />
        )}
      </Modal>
    </div>
  )
}

export default ResourceManagePage
