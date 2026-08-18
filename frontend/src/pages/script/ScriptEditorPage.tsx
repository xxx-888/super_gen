/**
 * ScriptEditorPage - 剧本编辑器
 *
 * 功能：
 *  - 剧本内容编辑、保存
 *  - @引用自动补全：输入 @ 弹出角色/场景/道具/音效候选，选择后插入 @{type:uuid}
 *  - AI 解析生成分镜（带可选项开关：角色/场景/物品/音效，默认开启）
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  Card, Button, Input, Message, Spin, Typography, Space, Divider, Tag, Result,
  Modal, Switch, Empty, Popconfirm, Select, Checkbox,
} from '@arco-design/web-react'
import {
  IconSave, IconThunderbolt, IconBackward, IconCheckCircle, IconDelete,
  IconUserGroup, IconHome, IconTool, IconNotification, IconClose,
  IconVideoCamera, IconUser, IconLocation, IconGift, IconMessage,
  IconUpload,
} from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { scriptService, resourceService, creationService, taskService } from '@/api/services'
import { renderPromptText, truncatePromptText } from '@/utils/prompt'
import { getTaskPollTimeout } from '@/hooks/useSiteConfig'

const { Title, Text, Paragraph } = Typography

// @引用类型元信息（与后端 prompt_builder 的 type 对齐）
const TYPE_META: Record<string, { label: string; color: string }> = {
  character: { label: '角色', color: '#722ED1' },
  scene_bg: { label: '场景', color: '#00B42A' },
  prop: { label: '道具', color: '#FF7D00' },
  audio: { label: '音效', color: '#86909C' },
  video: { label: '视频', color: '#165DFF' },
}

const ScriptEditorPage: React.FC = () => {
  const { projectId, scriptId } = useParams<{ projectId: string; scriptId: string }>()
  const navigate = useNavigate()
  const textareaRef = useRef<any>(null)

  const [script, setScript] = useState<any>(null)
  const [content, setContent] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 资源（用于 @ 引用候选）
  const [resources, setResources] = useState<Record<string, any[]>>({
    character: [], scene_bg: [], prop: [], audio: [], video: [],
  })
  const [resourcesLoaded, setResourcesLoaded] = useState(false)

  // @ 引用补全状态
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionEnd, setMentionEnd] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)

  // AI 解析选项弹窗
  const [parseModalVisible, setParseModalVisible] = useState(false)
  const [parseOpts, setParseOpts] = useState({
    generate_characters: true,
    generate_scenes: true,
    generate_props: true,
    generate_audio: true,
  })
  const [llmModels, setLlmModels] = useState<any[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [promptTemplates, setPromptTemplates] = useState<any[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')

  // 加载后台配置的 LLM 模型列表
  const loadLLMModels = async () => {
    setModelsLoading(true)
    try {
      const res: any = await creationService.models.list({ type: 'llm' })
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setLlmModels(list)
      if (list.length && !selectedModelId) setSelectedModelId(list[0].id)
    } catch { /* 非管理员可能无权限，忽略 */ }
    finally { setModelsLoading(false) }
  }

  // 加载剧本解析类目的提示词模板
  const loadPromptTemplates = async () => {
    try {
      const res: any = await creationService.promptTemplates.list({ category: 'script_parse' })
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setPromptTemplates(list)
      // 默认选中 is_default 的，否则留空（走后端内置默认）
      const def = list.find((t: any) => t.is_default)
      setSelectedTemplateId(def?.id || '')
    } catch { /* 非管理员或无模板，忽略，后端会用内置默认 */ }
  }

  // 打开解析弹窗时加载模型列表
  useEffect(() => {
    if (parseModalVisible) {
      loadLLMModels()
      loadPromptTemplates()
    }
  }, [parseModalVisible])

  useEffect(() => {
    if (!scriptId) return
    loadScript()
    if (projectId) loadResources()
  }, [scriptId, projectId])

  const loadScript = async () => {
    try {
      const data: any = await scriptService.get(scriptId!)
      setScript(data)
      setContent(data.content || '')
      setTitle(data.title || '')
      // 加载后检查是否有进行中的解析任务（刷新/切页回来可恢复）
      checkParsingTask()
    } catch {
      // 拦截器已提示
    } finally {
      setLoading(false)
    }
  }

  /** 检查当前剧本是否有进行中/刚完成的 script_parse 任务，恢复解析状态 */
  const checkParsingTask = async () => {
    if (!scriptId || !projectId) return
    try {
      // 查该项目的 script_parse 任务（按创建时间倒序，最新在前）
      const res: any = await taskService.list({ project_id: projectId, type: 'script_parse' })
      const tasks = Array.isArray(res) ? res : (res?.data ?? [])
      // 找到属于当前剧本的任务（input_data.script_id 匹配）
      const mine = tasks.filter((t: any) => {
        const sid = t.input_data?.script_id
        return sid && String(sid) === String(scriptId)
      })
      if (mine.length === 0) return
      const latest = mine[0]  // 最新一条（已按 created_at desc 排序）
      const parseTaskId = latest.meta?.parse_task_id
      if (latest.status === 'processing' && parseTaskId) {
        // 进行中：恢复解析状态 + 继续轮询
        setParsing(true)
        setParsingTaskId(parseTaskId)
        Message.info({ content: '该剧本正在解析中，已恢复进度跟踪', duration: 3 })
        pollParseStatus(parseTaskId, (parseData) => {
          setParsing(false)
          setParsingTaskId(null)
          setParseResult(parseData)
          Message.success(`解析完成：${parseData.characters?.length || 0} 角色，${parseData.scenes?.length || 0} 场景，${parseData.shots?.length || 0} 分镜。请确认后入库。`)
        }, (err) => {
          setParsing(false)
          setParsingTaskId(null)
          Message.error(err)
        })
      }
    } catch { /* 静默：查询失败不阻断编辑 */ }
  }

  const loadResources = async () => {
    try {
      const [character, scene_bg, prop, audio, video] = await Promise.all([
        resourceService.characters.list(projectId!),
        resourceService.sceneBg.list(projectId!),
        resourceService.props.list(projectId!),
        resourceService.audio.list(projectId!),
        resourceService.video.list(projectId!),
      ])
      setResources({
        character: Array.isArray(character) ? character : [],
        scene_bg: Array.isArray(scene_bg) ? scene_bg : [],
        prop: Array.isArray(prop) ? prop : [],
        audio: Array.isArray(audio) ? audio : [],
        video: Array.isArray(video) ? video : [],
      })
    } catch {
      // 资源加载失败不阻断编辑
    } finally {
      setResourcesLoaded(true)
    }
  }

  // 所有候选（扁平化 + 过滤）
  const suggestions = React.useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.trim().toLowerCase()
    const list: any[] = []
    for (const type of Object.keys(resources)) {
      for (const item of resources[type]) {
        const name = item.name || ''
        if (!q || name.toLowerCase().includes(q)) {
          list.push({ type, id: item.id, name })
        }
      }
    }
    return list.slice(0, 50)
  }, [mentionQuery, resources])

  // 检测 @ 引用
  const detectMention = (text: string, pos: number) => {
    const before = text.slice(0, pos)
    const match = before.match(/(^|\s)@([\w一-龥]*)$/)
    if (match) {
      const start = match.index! + (match[1] ? match[1].length : 0)
      setMentionStart(start)
      setMentionEnd(pos)
      setMentionQuery(match[2])
      setMentionIndex(0)
    } else {
      setMentionQuery(null)
      setMentionStart(null)
      setMentionEnd(null)
    }
  }

  const handleContentChange = (val: string, e?: any) => {
    setContent(val)
    const pos = e?.target?.selectionStart ?? val.length
    detectMention(val, pos)
  }

  const insertMention = (item: any) => {
    if (mentionStart === null || mentionEnd === null) return
    // 插入 @中文名称（用户可读），后端 prompt_builder 按名称解析展开
    const insert = `@${item.name} `
    const next = content.slice(0, mentionStart) + insert + content.slice(mentionEnd)
    setContent(next)
    const caret = mentionStart + insert.length
    setMentionQuery(null)
    setMentionStart(null)
    setMentionEnd(null)
    // 恢复光标
    requestAnimationFrame(() => {
      const dom = textareaRef.current?.dom || textareaRef.current?.textareaRef?.current
      if (dom) {
        dom.focus()
        dom.setSelectionRange(caret, caret)
      }
    })
  }

  const handleKeyDown = (e: any) => {
    if (mentionQuery === null || suggestions.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (e.nativeEvent) e.nativeEvent.stopImmediatePropagation()
      if (e.key === 'ArrowDown') {
        setMentionIndex((i) => (i + 1) % suggestions.length)
      } else if (e.key === 'ArrowUp') {
        setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
      } else if (e.key === 'Enter') {
        insertMention(suggestions[mentionIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setMentionQuery(null)
      setMentionStart(null)
      setMentionEnd(null)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await scriptService.update(scriptId!, { title, content })
      Message.success('保存成功')
      loadScript()
    } catch {
      // 拦截器已提示
    } finally {
      setSaving(false)
    }
  }

  // 文件上传：提取文档 → AI 清理+分集 → 填入当前编辑器
  // 轮询上传 AI 处理状态（超时上限跟随后台「系统设置」的 task_poll_timeout_seconds）
  const pollUploadStatus = (taskId: string): Promise<any> => {
    return new Promise((resolve) => {
      const intervalSec = 5
      const maxAttempts = Math.ceil(getTaskPollTimeout() / intervalSec) + 10
      let attempts = 0
      const poll = async () => {
        attempts++
        try {
          const res: any = await scriptService.uploadStatus(taskId)
          const data = res?.data ?? res
          if (data.status === 'completed') { resolve(data.result); return }
          if (data.status === 'failed') { resolve(null); return }
        } catch { /* 继续 */ }
        if (attempts >= maxAttempts) { resolve(null); return }
        setTimeout(poll, intervalSec * 1000)
      }
      poll()
    })
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res: any = await scriptService.upload(file, projectId)
      const data = res?.data ?? res
      const taskId = data?.task_id

      let processed = null
      if (taskId) {
        // 异步模式：轮询 AI 处理
        Message.loading({ content: '正在 AI 智能处理...', duration: 0 })
        processed = await pollUploadStatus(taskId)
        Message.clear()
      }

      if (processed && Array.isArray(processed.episodes)) {
        const eps = processed.episodes
        if (eps.length === 1) {
          // 单集：直接填入清理后的内容
          setContent(eps[0].content)
          if (eps[0].title) setTitle(eps[0].title)
          const removed = processed.removed_lines?.length || 0
          Message.success(`已导入并清理${removed ? `（去除 ${removed} 行水印）` : ''}，共 ${eps[0].content.length} 字`)
        } else {
          // 多集：合并填入当前编辑器
          const merged = eps.map((ep: any) => `# ${ep.title}\n\n${ep.content}`).join('\n\n---\n\n')
          setContent(merged)
          if (data.title) setTitle(data.title)
          Message.info(`识别出 ${eps.length} 集，已合并填入`)
        }
      } else if (data?.content) {
        // AI 降级：填入原始内容
        setContent(data.content)
        if (data.title) setTitle(data.title)
        Message.success(`已导入「${data.filename || file.name}」，共 ${data.content.length} 字`)
      }
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '文件解析失败')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const openParseModal = () => {
    if (!content.trim()) {
      Message.warning('请先输入剧本内容')
      return
    }
    setParseModalVisible(true)
  }

  const handleDelete = async () => {
    try {
      const res: any = await scriptService.delete(scriptId!)
      const d = res?.data ?? res
      const ep = d?.deleted_episodes || 0
      const sc = d?.deleted_scenes || 0
      Message.success(`剧本已删除${ep || sc ? `（同时删除 ${ep} 个片段、${sc} 个分镜）` : ''}`)
      navigate(`/projects/${projectId}`)
    } catch {
      // 拦截器已提示
    }
  }

  const [parseResult, setParseResult] = useState<any>(null)  // LLM 解析预览结果
  /** 进行中的解析任务 ID（gen_task_tracker 的内存 task_id），用于刷新页面后恢复轮询 */
  const [parsingTaskId, setParsingTaskId] = useState<string | null>(null)

  // 轮询解析状态（超时上限跟随后台「系统设置」的 task_poll_timeout_seconds）
  const pollParseStatus = async (taskId: string, onDone: (result: any) => void, onError: (err: string) => void) => {
    const intervalSec = 5
    const maxAttempts = Math.ceil(getTaskPollTimeout() / intervalSec) + 10
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, intervalSec * 1000))
      try {
        const res: any = await scriptService.parseStatus(scriptId!, taskId)
        const task = res?.data ?? res
        if (task.status === 'completed' && task.result) {
          onDone(task.result)
          return
        }
        if (task.status === 'failed') {
          onError(task.error || '解析失败')
          return
        }
      } catch { /* 网络错误继续轮询 */ }
    }
    const mins = Math.round((maxAttempts * intervalSec) / 60)
    onError(`解析超时（约 ${mins} 分钟），请尝试缩短剧本或使用更快的模型`)
  }

  const handleParseConfirm = async () => {
    if (!content.trim()) { Message.warning('请先输入剧本内容'); return }
    if (parsing) { Message.warning('该剧本正在解析中，请勿重复提交'); return }
    setParsing(true)
    try {
      await scriptService.update(scriptId!, { title, content })
      const opts = { ...parseOpts, engine: 'llm', model_id: selectedModelId || undefined, template_id: selectedTemplateId || undefined }
      const res: any = await scriptService.parse(scriptId!, opts)
      const result = res?.data ?? res

      if (result.task_id) {
        // LLM 异步模式：关闭弹窗，记录 task_id，轮询状态
        setParsingTaskId(result.task_id)
        setParseModalVisible(false)
        Message.info('正在解析剧本，请稍候...')
        pollParseStatus(result.task_id, (parseData) => {
          setParsing(false)
          setParsingTaskId(null)
          setParseResult(parseData)
          Message.success(`解析完成：${parseData.characters?.length || 0} 角色，${parseData.scenes?.length || 0} 场景，${parseData.shots?.length || 0} 分镜。请确认后入库。`)
        }, (err) => {
          setParsing(false)
          setParsingTaskId(null)
          Message.error(err)
        })
      } else if (result.preview) {
        // 正则模式同步返回预览
        setParsing(false)
        setParseResult(result)
        setParseModalVisible(false)
        Message.success(`解析完成：${result.characters?.length || 0} 角色，${result.scenes?.length || 0} 场景，${result.shots?.length || 0} 分镜。请确认后入库。`)
      } else {
        // 正则模式直接完成
        setParsing(false)
        Message.success(`解析完成：${result.scenes?.length || 0} 个分镜`)
        setParseModalVisible(false)
        navigate(`/projects/${projectId}/episodes`)
      }
    } catch (e: any) {
      setParsing(false)
      const detail = e?.response?.data?.detail || e?.message || ''
      // 后端重复解析拦截（409）：提示用户已在解析中
      if (e?.response?.status === 409 || /正在解析|重复/i.test(detail)) {
        Message.warning(detail || '该剧本正在解析中，请勿重复提交')
        // 尝试恢复进度跟踪
        checkParsingTask()
      } else {
        Message.error(detail || '解析失败，请检查剧本内容')
      }
    }
  }

  // 确认入库
  const [confirming, setConfirming] = useState(false)
  const [shotsSelectedTick, setShotsSelectedTick] = useState(0)  // 触发分镜选择重渲染

  // 分镜全选/反选
  const allShotsChecked = (parseResult?.shots || []).length > 0 && (parseResult?.shots || []).every((s: any) => s.selected !== false)
  const someShotsChecked = (parseResult?.shots || []).some((s: any) => s.selected !== false)
  const toggleAllShots = (checked: boolean) => {
    if (!parseResult?.shots) return
    parseResult.shots.forEach((s: any) => { s.selected = checked })
    setShotsSelectedTick(t => t + 1)
  }
  const toggleShot = (s: any, checked: boolean) => {
    s.selected = checked
    setShotsSelectedTick(t => t + 1)
  }

  // 跳转到片段管理（统一的分镜编辑入口）：先查该剧本对应的 episodeId
  const goToEpisode = async () => {
    if (!scriptId || !projectId) return
    try {
      const res: any = await scriptService.getEpisode(scriptId)
      const eid = res?.episode_id || (res?.data?.episode_id)
      if (eid) {
        navigate(`/projects/${projectId}/episodes/${eid}`)
      } else {
        navigate(`/projects/${projectId}/episodes`)
      }
    } catch {
      // 剧本尚未解析入库，去片段管理列表页
      navigate(`/projects/${projectId}/episodes`)
    }
  }

  const handleConfirmParse = async () => {
    if (!parseResult || !scriptId) return
    setConfirming(true)
    try {
      const res: any = await scriptService.confirmParse(scriptId, {
        characters: parseResult.characters,
        scenes: parseResult.scenes,
        props: parseResult.props,
        shots: parseResult.shots,
      })
      const r = res?.data ?? res
      const ac = r.auto_created || {}
      Message.success({
        content: `入库完成：${ac.characters || 0} 角色，${ac.scenes || 0} 场景，${ac.props || 0} 物品，${ac.shots || 0} 分镜`,
        duration: 5000,
      })
      setParseResult(null)
      // 引导下一步
      Modal.info({
        title: '入库完成',
        content: (
          <div style={{ lineHeight: 2 }}>
            <div>角色/场景/物品已创建到<strong>资源管理</strong></div>
            <div>分镜已创建并关联到<strong>片段管理</strong>（{r.episode_title}）</div>
            <div style={{ marginTop: 12, color: 'var(--color-text-3)', fontSize: 13 }}>建议按以下顺序操作：</div>
            <div>1️⃣ 去<strong>资源管理</strong>给角色/场景 AI 生图</div>
            <div>2️⃣ 去<strong>片段管理</strong>查看分镜、生成视频</div>
          </div>
        ),
        okText: '去片段管理查看分镜',
        cancelText: '去资源管理生图',
        onOk: () => navigate(`/projects/${projectId}/episodes/${r.episode_id}`),
        onCancel: () => navigate(`/projects/${projectId}/resources?tab=characters`),
      })
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || '入库失败')
    } finally {
      setConfirming(false)
    }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} tip="加载中..." /></div>
  if (!script) return <Result status="404" title="剧本不存在" extra={<Button onClick={() => navigate(`/projects/${projectId}`)}>返回项目</Button>} />

  return (
    <div style={{ width: '100%', maxWidth: 1200, margin: '0 auto' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Button icon={<IconBackward />} onClick={() => navigate(`/projects/${projectId}`)} type="text" />
          <Input
            value={title}
            onChange={setTitle}
            placeholder="剧本标题"
            style={{ width: 300, fontWeight: 600, fontSize: 16 }}
          />
        </Space>
        <Space>
          {/* 隐藏的文件上传 input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.pdf,.docx"
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />
          <Button icon={<IconUpload />} loading={uploading} onClick={() => fileInputRef.current?.click()}>
            导入文件
          </Button>
          <Button icon={<IconSave />} loading={saving} onClick={handleSave}>保存</Button>
          <Popconfirm title="确认删除该剧本？关联的片段、分镜将一并删除，操作不可恢复" onOk={handleDelete}>
            <Button status="danger" icon={<IconDelete />}>删除</Button>
          </Popconfirm>
          <Button type="primary" icon={<IconThunderbolt />} loading={parsing} onClick={openParseModal}>
            AI 解析生成分镜
          </Button>
        </Space>
      </div>

      {/* 解析状态：与片段管理数据对齐（分镜/角色/场景/物品） */}
      {script.parsed_data && (() => {
        const pd = script.parsed_data
        // 兼容新旧格式：新格式用 shots/characters/scenes/props；旧格式用 scenes(分镜)/extracted_characters
        const shotCount = pd.shots?.length ?? pd.scenes?.length ?? 0
        const charCount = pd.characters?.length ?? pd.extracted_characters?.length ?? 0
        const sceneCount = pd.shots && pd.scenes ? pd.scenes.length : 0  // 新格式才有独立场景数
        const propCount = pd.props?.length ?? 0
        return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <IconCheckCircle style={{ color: 'rgb(var(--success-6))', fontSize: 18 }} />
              <Text>剧本已解析{pd.confirmed ? '并入库' : ''}</Text>
              {shotCount > 0 && <Tag color="green" size="small"><IconVideoCamera /> {shotCount} 分镜</Tag>}
              {charCount > 0 && <Tag color="purple" size="small"><IconUser /> {charCount} 角色</Tag>}
              {sceneCount > 0 && <Tag color="cyan" size="small"><IconLocation /> {sceneCount} 场景</Tag>}
              {propCount > 0 && <Tag color="orange" size="small"><IconGift /> {propCount} 物品</Tag>}
              <Button type="text" size="small" onClick={goToEpisode}>
                查看分镜 →
              </Button>
            </div>
          </Card>
        )
      })()}

      {/* 编辑器 + @ 引用提示 */}
      <Card title="剧本内容">
        <div style={{ position: 'relative' }}>
          <Input.TextArea
            ref={textareaRef}
            value={content}
            onChange={handleContentChange}
            onKeyDown={handleKeyDown}
            placeholder={"在此输入或粘贴剧本内容...&#10;&#10;输入 @ 可引用本项目中的角色/场景/道具/音效，例如：@沈如姬、@咖啡厅&#10;&#10;示例：&#10;场景一：城市街道 - 白天&#10;小明走在繁华的街道上，手里拿着一封信。"}
            style={{ minHeight: 400, fontFamily: 'monospace', fontSize: 14, lineHeight: 1.8 }}
            showWordLimit
            maxLength={50000}
          />

          {/* @ 引用候选下拉 */}
          {mentionQuery !== null && (
            <div
              style={{
                position: 'absolute', bottom: 12, left: 12, right: 12,
                maxHeight: 240, overflowY: 'auto',
                background: 'var(--color-bg-1)',
                border: '1px solid var(--color-border)',
                borderRadius: 8, boxShadow: 'var(--shadow-3)',
                zIndex: 20, padding: 6,
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--color-text-3)', padding: '4px 8px' }}>
                @ 引用 — 角色 / 场景 / 道具 / 音效（↑↓ 选择，Enter 插入，Esc 关闭）
              </div>
              {suggestions.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center' }}><Empty description={resourcesLoaded ? '无匹配资源' : '加载中...'} /></div>
              ) : (
                suggestions.map((s, i) => {
                  const meta = TYPE_META[s.type] || { label: s.type, color: '#86909C' }
                  const isActive = i === mentionIndex
                  return (
                    <div
                      key={`${s.type}-${s.id}`}
                      ref={(el) => { if (isActive && el) el.scrollIntoView({ block: 'nearest' }) }}
                      onMouseDown={(e) => { e.preventDefault(); insertMention(s) }}
                      onMouseEnter={() => setMentionIndex(i)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                        background: isActive ? 'var(--color-fill-3)' : 'transparent',
                        borderLeft: isActive ? `3px solid ${meta.color}` : '3px solid transparent',
                        transition: 'background 0.1s',
                      }}
                    >
                      <span style={{
                        fontSize: 11, color: '#fff', background: meta.color,
                        padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap',
                        fontWeight: 500, minWidth: 36, textAlign: 'center',
                      }}>{meta.label}</span>
                      <span style={{
                        color: isActive ? 'rgb(var(--primary-6))' : 'var(--color-text-1)',
                        fontWeight: isActive ? 600 : 400,
                      }}>{s.name}</span>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>
      </Card>

      {/* LLM 解析预览面板（用户确认后入库） */}
      {parseResult && (
        <Card title="解析预览（确认后入库）" style={{ marginTop: 16 }}>
          {parseResult.source !== 'llm' && (
            <div style={{ color: 'var(--color-warning-6)', marginBottom: 12, fontSize: 13 }}>
              LLM 不可用，已降级为正则解析（质量较低，建议配置 LLM 模型后重新解析）
            </div>
          )}
          {parseResult.characters?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Text style={{ fontWeight: 600 }}>角色（{parseResult.characters.length}）</Text>
              <div style={{ marginTop: 8 }}>
                {parseResult.characters.map((c: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Checkbox defaultChecked onChange={(v) => { c.selected = v }} />
                    <div style={{ flex: 1 }}>
                      <Space size={6}><Text strong>{c.name}</Text>{c.exists && <Tag size="small" color="arcoblue">已入库</Tag>}</Space>
                      {c.appearance_prompt && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{c.appearance_prompt}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {parseResult.scenes?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Text style={{ fontWeight: 600 }}>场景（{parseResult.scenes.length}）</Text>
              <div style={{ marginTop: 8 }}>
                {parseResult.scenes.map((s: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Checkbox defaultChecked onChange={(v) => { s.selected = v }} />
                    <div style={{ flex: 1 }}>
                      <Space size={6}><Text strong>{s.name}</Text>{s.exists && <Tag size="small" color="arcoblue">已入库</Tag>}</Space>
                      {s.prompt && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{renderPromptText(s.prompt)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {parseResult.props?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Text style={{ fontWeight: 600 }}>物品（{parseResult.props.length}）</Text>
              <div style={{ marginTop: 8 }}>
                {parseResult.props.map((p: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Checkbox defaultChecked onChange={(v) => { p.selected = v }} />
                    <div style={{ flex: 1 }}>
                      <Space size={6}><Text strong>{p.name}</Text>{p.exists && <Tag size="small" color="arcoblue">已入库</Tag>}</Space>
                      {p.description && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{p.description}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {parseResult.shots?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: 600 }}>分镜（{parseResult.shots.length} 个，已选 {(parseResult.shots as any[]).filter((s) => s.selected !== false).length}）</Text>
                <Checkbox
                  checked={allShotsChecked}
                  indeterminate={!allShotsChecked && someShotsChecked}
                  onChange={toggleAllShots}
                  style={{ fontSize: 13 }}
                >
                  全选
                </Checkbox>
              </div>
              <div style={{ marginTop: 8, maxHeight: 280, overflowY: 'auto' }}>
                {parseResult.shots.map((s: any, i: number) => (
                  <div key={i} data-tick={shotsSelectedTick} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--color-fill-2)' }}>
                    <Checkbox
                      checked={s.selected !== false}
                      onChange={(v) => toggleShot(s, v)}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Space size={6}>
                        <Text strong>#{s.sequence || i + 1}</Text>
                        {s.duration && <Tag size="small">{s.duration}s</Tag>}
                        {s.location && <Tag size="small" color="green"><IconLocation /> {s.location}</Tag>}
                        {s.shot_type && <Tag size="small" color="blue">{s.shot_type}</Tag>}
                      </Space>
                      {s.narration && (
                        <div style={{ fontSize: 12, color: 'var(--color-text-2)', marginTop: 4, display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                          <IconMessage style={{ flexShrink: 0, marginTop: 2 }} />
                          <span>{s.narration.length > 80 ? s.narration.slice(0, 80) + '...' : s.narration}</span>
                        </div>
                      )}
                      {s.prompt && (
                        <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 2, display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                          <IconVideoCamera style={{ flexShrink: 0, marginTop: 2 }} />
                          <span>{truncatePromptText(s.prompt, 80)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
            <Button onClick={() => setParseResult(null)}>取消</Button>
            <Button type="primary" loading={confirming} onClick={handleConfirmParse}>
              确认入库（仅入库勾选项）
            </Button>
          </div>
        </Card>
      )}

      {/* 警告信息 */}
      {script.parsed_data?.warnings?.length > 0 && (
        <Card title="解析警告" style={{ marginTop: 16 }}>
          {script.parsed_data.warnings.map((w: string, i: number) => (
            <div key={i} style={{ color: 'var(--color-warning-6)', marginBottom: 4 }}>⚠ {w}</div>
          ))}
        </Card>
      )}

      {/* AI 解析选项弹窗 */}
      <Modal
        title="AI 解析生成分镜"
        visible={parseModalVisible}
        onCancel={() => setParseModalVisible(false)}
        onOk={handleParseConfirm}
        confirmLoading={parsing}
        okText="开始解析"
        cancelText="取消"
      >
        <Paragraph style={{ color: 'var(--color-text-3)', marginBottom: 16 }}>
          AI 将理解剧本并智能拆分分镜、提取角色/场景/道具，请选择模型和自动生成的资源类型：
        </Paragraph>
        {/* LLM 模型选择 */}
        <div style={{ marginBottom: 16, padding: 12, background: 'var(--color-fill-2)', borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>解析模型</div>
          {modelsLoading ? <Spin size={20} /> :
           llmModels.length === 0 ? (
            <Text type="warning" style={{ fontSize: 13 }}>
              后台未配置 LLM 模型，将使用环境变量默认模型。
              请到「后台管理 → 配置模型」添加 type=大语言模型 的记录。
            </Text>
           ) : (
            <Select value={selectedModelId} onChange={setSelectedModelId} style={{ width: '100%' }}>
              {llmModels.map((m: any) => (
                <Select.Option key={m.id} value={m.id}>
                  {m.name}（{m.config?.model || m.name}）
                  {m.priority ? ` · 优先级${m.priority}` : ''}
                </Select.Option>
              ))}
            </Select>
          )}
        </div>
        {/* 提示词模板选择（可选，用于调试不同模板的解析效果） */}
        {promptTemplates.length > 0 && (
          <div style={{ marginBottom: 16, padding: 12, background: 'var(--color-fill-2)', borderRadius: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>提示词模板（可选）</div>
            <Select
              value={selectedTemplateId || undefined}
              onChange={(v) => setSelectedTemplateId(v || '')}
              style={{ width: '100%' }}
              placeholder="使用默认模板（后台配置或内置）"
              allowClear
            >
              {promptTemplates.map((t: any) => (
                <Select.Option key={t.id} value={t.id}>
                  {t.name}（{t.mode}{t.is_default ? ' · 默认' : ''}）
                </Select.Option>
              ))}
            </Select>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              可到「后台管理 → 提示词模板」配置不同模板，对比解析效果
            </Text>
          </div>
        )}
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          {([
            ['generate_characters', '生成角色', '从剧本中提取并生成角色设定'],
            ['generate_scenes', '生成场景', '生成场景背景与分镜画面描述'],
            ['generate_props', '生成道具', '提取关键道具并生成视觉设定'],
            ['generate_audio', '生成音效', '为分镜建议匹配的音效/配乐'],
          ] as [keyof typeof parseOpts, string, string][]).map(([key, label, desc]) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--color-text-1)' }}>{label}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-3)' }}>{desc}</div>
              </div>
              <Switch checked={parseOpts[key]} onChange={(v) => setParseOpts((o) => ({ ...o, [key]: v }))} />
            </div>
          ))}
        </Space>
      </Modal>
    </div>
  )
}

export default ScriptEditorPage
