/**
 * EpisodeEditorPage - 视频在线剪辑器 v2（多轨道时间轴，剪映式交互）
 *
 * 三条轨道：
 *   视频轨：片段顺序排列 —— 拖动主体换序、拖左右边缘裁剪 in/out
 *   音频轨：素材按时间点定位 —— 拖动移动、拖边缘调时长
 *   字幕轨：按起止时间定位 —— 拖动移动、拖边缘调起止
 * 播放头：点击/拖动刻度尺 scrub；拆分(S)在播放头处切开选中视频片段；
 * 删除(Del)移除选中对象；可上传导入视频/音频；缩放时间轴。
 * 草稿防抖自动保存（后端 JSONB），导出为后台 ffmpeg 任务轮询进度。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Card, Empty, Input, InputNumber, Message, Modal, Popconfirm,
  Radio, Slider, Space, Spin, Switch, Tag, Tooltip, Typography,
} from '@arco-design/web-react'
import {
  IconLeft, IconPlus, IconDelete, IconExport, IconCheckCircle,
  IconSync, IconScissor, IconUpload, IconMinus, IconExpand, IconMusic,
} from '@arco-design/web-react/icon'
import { useNavigate, useParams } from 'react-router-dom'
import { apiClient } from '@/api/client'
import { uploadService } from '@/api/services'

const { Title, Text } = Typography

const RES_PRESETS = [
  { value: '720p', label: '720P 横屏 16:9（推荐）' },
  { value: '1080p', label: '1080P 横屏' },
  { value: '480p', label: '480P（快速小文件）' },
  { value: 'vertical_720', label: '720P 竖屏 9:16（手机）' },
  { value: 'square_720', label: '720P 方形 1:1' },
]

const fmtSec = (v: number) => `${(v || 0).toFixed(1)}s`
const uid = () => Math.random().toString(36).slice(2, 10)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round1 = (v: number) => Math.round(v * 10) / 10

interface Clip { id: string; url: string; name: string; in: number; out: number | null; volume: number }
interface AudioClip { id: string; url: string; name: string; start: number; duration: number; volume: number; loop?: boolean; fade_in?: number; fade_out?: number }
interface Sub { id: string; start: number; end: number; text: string }
type Selection = { kind: 'clip' | 'audio' | 'sub'; id: string } | null

const EpisodeEditorPage: React.FC = () => {
  const { projectId, episodeId } = useParams()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [episode, setEpisode] = useState<any>(null)
  const [sceneVideos, setSceneVideos] = useState<any[]>([])
  const [audioAssets, setAudioAssets] = useState<any[]>([])
  const [config, setConfig] = useState<any>(null)
  const [durMap, setDurMap] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<Selection>(null)
  const [activePanel, setActivePanel] = useState('props')

  // 时间轴状态
  const [scale, setScale] = useState(12)          // px / 秒
  const [playhead, setPlayhead] = useState(0)     // 秒
  const [dragInfo, setDragInfo] = useState<{ mode: string; id: string; dv: number } | null>(null)

  // 草稿保存 / 导出
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const saveTimer = useRef<any>(null)
  const dirtyRef = useRef(false)
  const [exporting, setExporting] = useState(false)
  const [exportStage, setExportStage] = useState('')
  const [lastOutput, setLastOutput] = useState<string | null>(null)
  const [addVideoVisible, setAddVideoVisible] = useState(false)
  const [uploading, setUploading] = useState('')
  const fileVideoRef = useRef<HTMLInputElement>(null)
  const fileAudioRef = useRef<HTMLInputElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<any>(null)

  const baseUrl = `/projects/${projectId}/episodes/${episodeId}/video-edit`

  // ---------------- 数据加载 ----------------
  useEffect(() => { load() /* eslint-disable-next-line */ }, [])

  const load = async () => {
    setLoading(true)
    try {
      const d: any = await apiClient.get(baseUrl)
      setEpisode(d.episode)
      setSceneVideos(d.scene_videos || [])
      setAudioAssets(d.audio_assets || [])
      const cfg = d.config || {}
      // 分辨率对象 → 预设名回显
      if (cfg.resolution && typeof cfg.resolution === 'object') {
        const wh = `${cfg.resolution.width}x${cfg.resolution.height}`
        const preset = { '1280x720': '720p', '1920x1080': '1080p', '854x480': '480p', '720x1280': 'vertical_720', '720x720': 'square_720' } as Record<string, string>
        cfg.resolution = preset[wh] || '720p'
      }
      // v1 → v2：单 BGM 迁移为一条循环音频
      cfg.audio_clips = cfg.audio_clips || []
      const bgm = cfg.audio?.bgm
      if (bgm?.url && !cfg.audio_clips.length) {
        cfg.audio_clips = [{
          id: uid(), url: bgm.url, name: 'BGM', start: 0, duration: 3600,
          volume: bgm.volume ?? 0.3, loop: true,
          fade_in: bgm.fade_in ?? 1, fade_out: bgm.fade_out ?? 2,
        }]
        cfg.audio = { ...(cfg.audio || {}), bgm: null }
      }
      setConfig(cfg)
      setLastOutput(d.last_output_url || null)
      if (d.rendering) { setExporting(true); pollLatestTask() }
      // 未设终点的视频片段：探测真实时长（分镜自带 duration 优先）
      const needProbe: string[] = []
      const dm: Record<string, number> = {}
      for (const sv of (d.scene_videos || [])) if (sv.duration) dm[sv.url] = sv.duration
      for (const c of (cfg.clips || [])) {
        if (c.out == null && !dm[c.url]) needProbe.push(c.url)
      }
      setDurMap(dm)
      if (needProbe.length) {
        await Promise.all(needProbe.slice(0, 20).map(async (u) => {
          try {
            const r: any = await apiClient.get(`${baseUrl}/probe`, { params: { url: u } })
            dm[u] = r.duration
          } catch { /* 探测失败用默认占位 */ }
        }))
        setDurMap({ ...dm })
      }
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }

  // ---------------- 修改 & 自动保存 ----------------
  const scheduleSave = (next: any) => {
    dirtyRef.current = true
    setSaveState('saving')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        const r: any = await apiClient.put(baseUrl, { config: next })
        setSavedAt(r?.updated_at || new Date().toISOString())
        setSaveState('saved')
        dirtyRef.current = false
      } catch { setSaveState('idle') }
    }, 1200)
  }
  const updateConfig = (fn: (c: any) => any) => {
    setConfig((prev: any) => {
      const next = fn(structuredClone(prev))
      scheduleSave(next)
      return next
    })
  }

  // ---------------- 派生：时长与布局 ----------------
  const srcDur = (c: Clip) => durMap[c.url] ?? (c.out ?? 30)
  const clipDur = (c: Clip) => Math.max(0.2, (c.out ?? srcDur(c)) - (c.in ?? 0))
  const clips: Clip[] = config?.clips || []
  const audioClips: AudioClip[] = config?.audio_clips || []
  const subs: Sub[] = config?.subtitles || []
  const totalDur = useMemo(() => clips.reduce((s, c) => s + clipDur(c), 0), [clips, durMap])
  const clipStart = (idx: number) => clips.slice(0, idx).reduce((s, c) => s + clipDur(c), 0)
  const trackWidth = Math.max((totalDur + 6) * scale, 600)

  const selClip = selection?.kind === 'clip' ? clips.find((c) => c.id === selection.id) : undefined
  const selAudio = selection?.kind === 'audio' ? audioClips.find((a) => a.id === selection.id) : undefined
  const selSub = selection?.kind === 'sub' ? subs.find((s) => s.id === selection.id) : undefined

  // ---------------- 时间轴交互（Pointer Events） ----------------
  const beginDrag = (e: React.PointerEvent, mode: string, item: any) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { mode, id: item.id, startX: e.clientX, orig: { ...item }, moved: false }
  }
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dv = round1((e.clientX - d.startX) / scale)
    if (Math.abs(e.clientX - d.startX) > 3) d.moved = true
    const orig = d.orig
    if (d.mode === 'clip-move') {
      // 视频换序：跟随指针平移，落点在 pointerup 提交
      setDragInfo({ mode: d.mode, id: d.id, dv })
      return
    }
    setDragInfo(null)
    updateConfig((c) => {
      if (d.mode === 'clip-trim-l' || d.mode === 'clip-trim-r') {
        const t = c.clips.find((x: Clip) => x.id === d.id)
        if (!t) return c
        const sd = durMap[t.url] ?? (t.out ?? 30)
        if (d.mode === 'clip-trim-l') {
          t.in = clamp(round1(orig.in + dv), 0, (t.out ?? sd) - 0.2)
        } else {
          const newOut = round1((orig.out ?? sd) + dv)
          t.out = clamp(newOut, t.in + 0.2, sd)
        }
      } else if (d.mode === 'audio-move') {
        const t = c.audio_clips.find((x: AudioClip) => x.id === d.id)
        if (t) t.start = clamp(round1(orig.start + dv), 0, 7200)
      } else if (d.mode === 'audio-trim-l' || d.mode === 'audio-trim-r') {
        const t = c.audio_clips.find((x: AudioClip) => x.id === d.id)
        if (!t) return c
        if (d.mode === 'audio-trim-l') {
          const ns = clamp(round1(orig.start + dv), 0, orig.start + orig.duration - 0.2)
          t.duration = round1(orig.duration - (ns - orig.start))
          t.start = ns
        } else {
          t.duration = clamp(round1(orig.duration + dv), 0.2, 7200)
        }
      } else if (d.mode === 'sub-move') {
        const t = c.subtitles.find((x: Sub) => x.id === d.id)
        if (t) {
          const len = orig.end - orig.start
          t.start = clamp(round1(orig.start + dv), 0, 7200)
          t.end = round1(t.start + len)
        }
      } else if (d.mode === 'sub-trim-l' || d.mode === 'sub-trim-r') {
        const t = c.subtitles.find((x: Sub) => x.id === d.id)
        if (!t) return c
        if (d.mode === 'sub-trim-l') t.start = clamp(round1(orig.start + dv), 0, t.end - 0.2)
        else t.end = clamp(round1(orig.end + dv), t.start + 0.2, 7200)
      }
      return c
    })
  }
  const onDragEnd = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.mode === 'clip-move' && dragInfo) {
      // 按拖动后的左沿落点计算插入位置并提交换序
      const dv = dragInfo.dv
      const idx = clips.findIndex((c) => c.id === d.id)
      const newLeft = clipStart(idx) + dv
      let acc = 0, target = 0
      for (let i = 0; i <= clips.length; i++) {
        if (i === clips.length || newLeft < acc) { target = i - (i > idx ? 1 : 0); break }
        if (i !== idx) acc += clipDur(clips[i])
      }
      updateConfig((c) => {
        const [item] = c.clips.splice(idx, 1)
        c.clips.splice(clamp(target, 0, c.clips.length), 0, item)
        return c
      })
      setDragInfo(null)
      return
    }
    setDragInfo(null)
    if (!d.moved) {
      // 点击（非拖动）= 选中
      const kind = d.mode.startsWith('clip') ? 'clip' : d.mode.startsWith('audio') ? 'audio' : 'sub'
      setSelection({ kind, id: d.id } as Selection)
      if (kind === 'clip') setActivePanel('props')
    }
  }

  // 播放头 scrub（刻度尺）
  const scrubTo = (e: React.PointerEvent) => {
    const el = timelineRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left + el.scrollLeft
    setPlayhead(clamp(round1(x / scale), 0, totalDur))
  }

  // ---------------- 操作：拆分 / 删除 / 添加 ----------------
  const splitSelected = () => {
    if (!selClip) { Message.warning('请先在时间轴选中一个视频片段'); return }
    const idx = clips.findIndex((c) => c.id === selClip.id)
    const start = clipStart(idx)
    const rel = playhead - start
    const dur = clipDur(selClip)
    if (rel <= 0.15 || rel >= dur - 0.15) {
      Message.warning(`播放头需在片段内部（当前片段 ${fmtSec(start)} ~ ${fmtSec(start + dur)}）`)
      return
    }
    const cut = round1(selClip.in + rel)
    updateConfig((c) => {
      const t = c.clips[idx]
      const right = { ...t, id: uid(), in: cut }
      t.out = cut
      c.clips.splice(idx + 1, 0, right)
      return c
    })
    Message.success('已拆分为两段')
  }

  const removeSelected = () => {
    if (!selection) return
    updateConfig((c) => {
      if (selection!.kind === 'clip') c.clips = c.clips.filter((x: Clip) => x.id !== selection!.id)
      if (selection!.kind === 'audio') c.audio_clips = c.audio_clips.filter((x: AudioClip) => x.id !== selection!.id)
      if (selection!.kind === 'sub') c.subtitles = c.subtitles.filter((x: Sub) => x.id !== selection!.id)
      return c
    })
    setSelection(null)
  }

  const addSceneClip = (sv: any) => {
    updateConfig((c) => {
      c.clips.push({ id: uid(), url: sv.url, name: `分镜#${sv.sequence}`, in: 0, out: null, volume: 1 })
      return c
    })
    if (sv.duration) setDurMap((m) => ({ ...m, [sv.url]: sv.duration }))
    setAddVideoVisible(false)
  }

  const addAudioClip = (url: string, name: string, duration?: number) => {
    updateConfig((c) => {
      c.audio_clips = c.audio_clips || []
      c.audio_clips.push({
        id: uid(), url, name, start: round1(playhead),
        duration: duration || 10, volume: 0.6, loop: false, fade_in: 0, fade_out: 0,
      })
      return c
    })
  }

  const addSubtitle = () => {
    const start = round1(playhead)
    updateConfig((c) => {
      c.subtitles.push({ id: uid(), start, end: round1(start + 2), text: '' })
      return c
    })
  }

  // 上传导入
  const handleUpload = async (kind: 'video' | 'audio', file: File) => {
    setUploading(kind)
    try {
      const resp: any = kind === 'video'
        ? await uploadService.video(file)
        : await uploadService.audio(file)
      if (kind === 'video') {
        updateConfig((c) => {
          c.clips.push({ id: uid(), url: resp.url, name: file.name.slice(0, 40), in: 0, out: null, volume: 1 })
          return c
        })
        if (resp.duration) setDurMap((m) => ({ ...m, [resp.url]: resp.duration }))
        Message.success(`视频已导入（${fmtSec(resp.duration || 0)}）`)
      } else {
        addAudioClip(resp.url, file.name.slice(0, 40), resp.duration || 10)
        Message.success(`音频已导入并放在播放头处（${fmtSec(resp.duration || 0)}）`)
      }
    } catch { /* 拦截器提示 */ } finally { setUploading('') }
  }

  // ---------------- 导出 ----------------
  const handleExport = async () => {
    if (!clips.length) { Message.warning('请先添加视频片段'); return }
    if (dirtyRef.current || saveState === 'saving') { Message.info('草稿保存中，请稍候…'); return }
    try {
      const r: any = await apiClient.post(`${baseUrl}/render`, { config })
      setExporting(true); setExportStage('已提交')
      pollTask(r.task_id)
    } catch { /* 拦截器提示 */ }
  }
  const pollLatestTask = async () => {
    try {
      const tasks: any = await apiClient.get('/tasks', { params: { type: 'video_edit', limit: 1 } })
      const latest = Array.isArray(tasks) ? tasks[0] : tasks?.items?.[0]
      if (latest && latest.status === 'processing') pollTask(latest.id)
      else setExporting(false)
    } catch { setExporting(false) }
  }
  const pollTask = (taskId: string) => {
    const timer = setInterval(async () => {
      try {
        const t: any = await apiClient.get(`/tasks/${taskId}`)
        setExportStage(t.meta?.stage || `${t.progress || 0}%`)
        if (t.status === 'completed') {
          clearInterval(timer); setExporting(false)
          const url = (t.output_urls || [])[0]
          if (url) setLastOutput(url)
          Message.success('成片导出完成')
        } else if (t.status === 'failed' || t.status === 'cancelled') {
          clearInterval(timer); setExporting(false)
          Message.error(`导出失败: ${(t.error_message || '').slice(0, 120)}`)
        }
      } catch { /* 继续轮询 */ }
    }, 2500)
  }

  // 快捷键：S 拆分 / Delete 删除（输入框聚焦时忽略）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); splitSelected() }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (loading) return <Card><div style={{ textAlign: 'center', padding: 80 }}><Spin size={28} /></div></Card>
  if (!config) return <Card><Empty description="配置加载失败" /></Card>

  // 时间轴刻度
  const tickStep = scale >= 30 ? 1 : scale >= 12 ? 5 : 10
  const ticks: number[] = []
  for (let t = 0; t * scale < trackWidth; t += tickStep) ticks.push(t)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>
      {/* 顶栏 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Button icon={<IconLeft />} onClick={() => navigate(`/projects/${projectId}/episodes/${episodeId}`)}>返回集详情</Button>
          <Title heading={5} style={{ margin: 0 }}>在线剪辑 · {episode?.title || `第${episode?.number ?? '?'}集`}</Title>
          <Tag color="arcoblue">{clips.length} 视频</Tag>
          <Tag color="gold">{audioClips.length} 音频</Tag>
          <Tag color="purple">{subs.length} 字幕</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>总时长 {fmtSec(totalDur)} · 播放头 {fmtSec(playhead)}</Text>
        </Space>
        <Space>
          {saveState === 'saving' && <Text type="secondary" style={{ fontSize: 12 }}><IconSync /> 保存中…</Text>}
          {saveState === 'saved' && <Text type="success" style={{ fontSize: 12 }}><IconCheckCircle /> 已自动保存</Text>}
          <Button type="primary" icon={<IconExport />} loading={exporting} onClick={handleExport}>
            {exporting ? `导出中（${exportStage || '排队'}）` : '导出成片'}
          </Button>
        </Space>
      </div>

      <div style={{ display: 'flex', gap: 10, flex: 1, minHeight: 0 }}>
        {/* 左：预览 + 工具栏 + 时间轴 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <Card bodyStyle={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 160, padding: 8 }}>
            {selClip
              ? <video key={selClip.id + selClip.in + (selClip.out ?? '')} controls autoPlay
                  src={`${selClip.url}#t=${selClip.in ?? 0},${selClip.out ?? ''}`}
                  style={{ maxWidth: '100%', maxHeight: '28vh' }} />
              : <Empty description="点击时间轴上的视频片段预览；拖动边缘裁剪、拖动主体换序" style={{ padding: 16 }} />}
          </Card>

          {/* 工具栏 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Space size={8}>
              <Tooltip content="在播放头位置把选中的视频片段切成两段（快捷键 S）">
                <Button size="small" icon={<IconScissor />} disabled={!selClip} onClick={splitSelected}>拆分</Button>
              </Tooltip>
              <Popconfirm title="删除选中的片段/音频/字幕？" disabled={!selection} onOk={removeSelected}>
                <Button size="small" status="danger" icon={<IconDelete />} disabled={!selection}>删除</Button>
              </Popconfirm>
              <Button size="small" icon={<IconPlus />} onClick={() => setAddVideoVisible(true)}>分镜视频</Button>
              <Button size="small" icon={<IconUpload />} loading={uploading === 'video'} onClick={() => fileVideoRef.current?.click()}>导入视频</Button>
              <Button size="small" icon={<IconMusic />} loading={uploading === 'audio'} onClick={() => fileAudioRef.current?.click()}>导入音频</Button>
              <Button size="small" icon={<IconPlus />} onClick={addSubtitle}>加字幕</Button>
            </Space>
            <Space size={6}>
              <IconMinus style={{ color: 'var(--color-text-3)' }} />
              <Slider value={scale} min={4} max={60} step={1} style={{ width: 110 }}
                onChange={(v) => setScale(Number(v) || 12)} tooltipVisible={false} />
              <IconExpand style={{ color: 'var(--color-text-3)' }} />
            </Space>
          </div>
          <input ref={fileVideoRef} type="file" accept="video/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload('video', f); e.target.value = '' }} />
          <input ref={fileAudioRef} type="file" accept="audio/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload('audio', f); e.target.value = '' }} />

          {/* 时间轴 */}
          <Card bodyStyle={{ padding: '8px 8px 4px', overflowX: 'auto' }} style={{ flexShrink: 0 }}>
            <div ref={timelineRef} style={{ width: trackWidth, position: 'relative', userSelect: 'none' }}>
              {/* 刻度尺（scrub） */}
              <div
                style={{ height: 22, position: 'relative', borderBottom: '1px solid var(--color-border)', cursor: 'ew-resize', touchAction: 'none' }}
                onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); scrubTo(e) }}
                onPointerMove={(e) => { if (e.buttons === 1) scrubTo(e) }}
              >
                {ticks.map((t) => (
                  <div key={t} style={{ position: 'absolute', left: t * scale, top: 0, height: '100%' }}>
                    <div style={{ width: 1, height: 8, background: 'var(--color-text-4)' }} />
                    <div style={{ fontSize: 10, color: 'var(--color-text-3)', transform: 'translateX(2px)' }}>{t}s</div>
                  </div>
                ))}
              </div>

              {/* 视频轨 */}
              <TrackLabel text={`视频轨（${clips.length}）`} />
              <div style={{ position: 'relative', height: 46, marginBottom: 6 }}>
                {clips.map((c, i) => {
                  const st = clipStart(i)
                  const dur = clipDur(c)
                  const isDrag = dragInfo?.mode === 'clip-move' && dragInfo.id === c.id
                  const sel = selection?.kind === 'clip' && selection.id === c.id
                  return (
                    <div key={c.id}
                      style={{
                        position: 'absolute', left: st * scale, width: Math.max(dur * scale, 26), top: 0, bottom: 0,
                        transform: isDrag ? `translateX(${dragInfo!.dv * scale}px)` : undefined,
                        zIndex: isDrag ? 10 : 1, opacity: isDrag ? 0.85 : 1,
                        background: sel ? 'rgb(var(--arcoblue-5))' : 'rgb(var(--arcoblue-2))',
                        border: sel ? '2px solid rgb(var(--arcoblue-6))' : '1px solid rgb(var(--arcoblue-3))',
                        borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'grab', touchAction: 'none',
                      }}
                      onPointerDown={(e) => beginDrag(e, 'clip-move', c)}
                      onPointerMove={onDragMove} onPointerUp={onDragEnd}
                    >
                      <Text ellipsis style={{ fontSize: 12, padding: '0 10px', pointerEvents: 'none', color: sel ? '#fff' : undefined }}>
                        {i + 1}. {c.name} · {fmtSec(dur)}
                      </Text>
                      <EdgeHandle side="l" onDown={(e) => beginDrag(e, 'clip-trim-l', c)} onMove={onDragMove} onUp={onDragEnd} />
                      <EdgeHandle side="r" onDown={(e) => beginDrag(e, 'clip-trim-r', c)} onMove={onDragMove} onUp={onDragEnd} />
                    </div>
                  )
                })}
                {!clips.length && <Text type="secondary" style={{ fontSize: 11 }}>（从「分镜视频」或「导入视频」添加）</Text>}
              </div>

              {/* 音频轨 */}
              <TrackLabel text={`音频轨（${audioClips.length}）`} />
              <div style={{ position: 'relative', height: 38, marginBottom: 6 }}>
                {audioClips.map((a) => {
                  const sel = selection?.kind === 'audio' && selection.id === a.id
                  return (
                    <div key={a.id}
                      style={{
                        position: 'absolute', left: a.start * scale, width: Math.max(a.duration * scale, 26), top: 0, bottom: 0,
                        background: sel ? 'rgb(var(--gold-5))' : 'rgb(var(--gold-2))',
                        border: sel ? '2px solid rgb(var(--gold-6))' : '1px solid rgb(var(--gold-3))',
                        borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center',
                        cursor: 'grab', touchAction: 'none',
                      }}
                      onPointerDown={(e) => beginDrag(e, 'audio-move', a)}
                      onPointerMove={onDragMove} onPointerUp={onDragEnd}
                    >
                      <Text ellipsis style={{ fontSize: 11, padding: '0 10px', pointerEvents: 'none' }}>
                        {a.name}{a.loop ? ' ⟳' : ''} · {fmtSec(a.duration)}
                      </Text>
                      <EdgeHandle side="l" gold onDown={(e) => beginDrag(e, 'audio-trim-l', a)} onMove={onDragMove} onUp={onDragEnd} />
                      <EdgeHandle side="r" gold onDown={(e) => beginDrag(e, 'audio-trim-r', a)} onMove={onDragMove} onUp={onDragEnd} />
                    </div>
                  )
                })}
                {!audioClips.length && <Text type="secondary" style={{ fontSize: 11 }}>（导入音频或从右侧音频资产添加）</Text>}
              </div>

              {/* 字幕轨 */}
              <TrackLabel text={`字幕轨（${subs.length}）`} />
              <div style={{ position: 'relative', height: 32 }}>
                {subs.map((s) => {
                  const sel = selection?.kind === 'sub' && selection.id === s.id
                  return (
                    <div key={s.id}
                      style={{
                        position: 'absolute', left: s.start * scale, width: Math.max((s.end - s.start) * scale, 24), top: 0, bottom: 0,
                        background: sel ? 'rgb(var(--purple-5))' : 'rgb(var(--purple-2))',
                        border: sel ? '2px solid rgb(var(--purple-6))' : '1px solid rgb(var(--purple-3))',
                        borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center',
                        cursor: 'grab', touchAction: 'none',
                      }}
                      onPointerDown={(e) => beginDrag(e, 'sub-move', s)}
                      onPointerMove={onDragMove} onPointerUp={onDragEnd}
                    >
                      <Text ellipsis style={{ fontSize: 11, padding: '0 8px', pointerEvents: 'none', whiteSpace: 'nowrap' }}>{s.text || '（空字幕）'}</Text>
                      <EdgeHandle side="l" purple onDown={(e) => beginDrag(e, 'sub-trim-l', s)} onMove={onDragMove} onUp={onDragEnd} />
                      <EdgeHandle side="r" purple onDown={(e) => beginDrag(e, 'sub-trim-r', s)} onMove={onDragMove} onUp={onDragEnd} />
                    </div>
                  )
                })}
                {!subs.length && <Text type="secondary" style={{ fontSize: 11 }}>（点「加字幕」在播放头处添加）</Text>}
              </div>

              {/* 播放头 */}
              <div style={{ position: 'absolute', left: playhead * scale, top: 0, bottom: 0, width: 2, background: 'rgb(var(--red-6))', pointerEvents: 'none', zIndex: 20 }}>
                <div style={{ position: 'absolute', top: -2, left: -5, width: 12, height: 12, borderRadius: 3, background: 'rgb(var(--red-6))' }} />
              </div>
            </div>
          </Card>
        </div>

        {/* 右：属性面板 */}
        <Card style={{ width: 360, overflow: 'auto' }} bodyStyle={{ paddingTop: 4 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            {([['props', '属性'], ['output', '输出']] as const).map(([k, label]) => (
              <Button key={k} size="small" type={activePanel === k ? 'primary' : 'default'} onClick={() => setActivePanel(k)}>{label}</Button>
            ))}
          </div>

          {activePanel === 'props' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {selClip && (
                <div>
                  <Text style={{ fontWeight: 600 }}>{selClip.name}</Text>
                  <Row label="起点(裁头)" node={<InputNumber size="mini" min={0} step={0.1} value={selClip.in} style={{ width: 90 }}
                    onChange={(v) => updateConfig((c) => { const t = c.clips.find((x: Clip) => x.id === selClip.id); if (t) t.in = Number(v) || 0; return c })} />} />
                  <Row label="终点(裁尾)" node={<InputNumber size="mini" min={selClip.in + 0.2} step={0.1} value={selClip.out ?? undefined} placeholder="到结尾" style={{ width: 90 }}
                    onChange={(v) => updateConfig((c) => { const t = c.clips.find((x: Clip) => x.id === selClip.id); if (t) t.out = v == null ? null : Number(v); return c })} />} />
                  <Row label="时长" node={<Tag size="small">{fmtSec(clipDur(selClip))}</Tag>} />
                  <div style={{ marginTop: 6 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>片段音量 {(selClip.volume ?? 1).toFixed(1)}x（0=静音）</Text>
                    <Slider value={selClip.volume} min={0} max={2} step={0.1}
                      onChange={(v) => updateConfig((c) => { const t = c.clips.find((x: Clip) => x.id === selClip.id); if (t) t.volume = Number(v); return c })} />
                  </div>
                </div>
              )}
              {selAudio && (
                <div>
                  <Text style={{ fontWeight: 600 }}>{selAudio.name}</Text>
                  <Row label="起点" node={<InputNumber size="mini" min={0} step={0.1} value={selAudio.start} style={{ width: 90 }}
                    onChange={(v) => updateConfig((c) => { const t = c.audio_clips.find((x: AudioClip) => x.id === selAudio.id); if (t) t.start = Number(v) || 0; return c })} />} />
                  <Row label="时长" node={<InputNumber size="mini" min={0.2} step={0.1} value={selAudio.duration} style={{ width: 90 }}
                    onChange={(v) => updateConfig((c) => { const t = c.audio_clips.find((x: AudioClip) => x.id === selAudio.id); if (t) t.duration = Number(v) || 0.2; return c })} />} />
                  <Row label="循环铺满" node={<Switch size="small" checked={!!selAudio.loop}
                    onChange={(v) => updateConfig((c) => { const t = c.audio_clips.find((x: AudioClip) => x.id === selAudio.id); if (t) t.loop = v; return c })} />} />
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>音量 {(selAudio.volume ?? 0.6).toFixed(2)}</Text>
                    <Slider value={selAudio.volume} min={0} max={1.5} step={0.05}
                      onChange={(v) => updateConfig((c) => { const t = c.audio_clips.find((x: AudioClip) => x.id === selAudio.id); if (t) t.volume = Number(v); return c })} />
                  </div>
                  <Space size={8} style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 12 }}>淡入</span>
                    <InputNumber size="mini" min={0} max={10} step={0.5} value={selAudio.fade_in ?? 0} style={{ width: 70 }}
                      onChange={(v) => updateConfig((c) => { const t = c.audio_clips.find((x: AudioClip) => x.id === selAudio.id); if (t) t.fade_in = Number(v) || 0; return c })} />
                    <span style={{ fontSize: 12 }}>淡出</span>
                    <InputNumber size="mini" min={0} max={10} step={0.5} value={selAudio.fade_out ?? 0} style={{ width: 70 }}
                      onChange={(v) => updateConfig((c) => { const t = c.audio_clips.find((x: AudioClip) => x.id === selAudio.id); if (t) t.fade_out = Number(v) || 0; return c })} />
                  </Space>
                </div>
              )}
              {selSub && (
                <div>
                  <Text style={{ fontWeight: 600 }}>字幕</Text>
                  <div style={{ marginTop: 6 }}>
                    <Space size={8}>
                      <InputNumber size="mini" min={0} step={0.1} value={selSub.start} style={{ width: 84 }}
                        onChange={(v) => updateConfig((c) => { const t = c.subtitles.find((x: Sub) => x.id === selSub.id); if (t) t.start = Number(v) || 0; return c })} />
                      <span style={{ fontSize: 12 }}>至</span>
                      <InputNumber size="mini" min={0} step={0.1} value={selSub.end} style={{ width: 84 }}
                        onChange={(v) => updateConfig((c) => { const t = c.subtitles.find((x: Sub) => x.id === selSub.id); if (t) t.end = Number(v) || 0; return c })} />
                    </Space>
                    <Input size="small" style={{ marginTop: 8 }} maxLength={120} value={selSub.text} placeholder="字幕文本"
                      onChange={(v) => updateConfig((c) => { const t = c.subtitles.find((x: Sub) => x.id === selSub.id); if (t) t.text = v; return c })} />
                    <div style={{ marginTop: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>字号</Text>
                      <InputNumber size="mini" min={16} max={64} value={config.subtitle_style?.font_size ?? 28} style={{ width: 70, marginLeft: 8 }}
                        onChange={(v) => updateConfig((c) => { c.subtitle_style.font_size = Number(v) || 28; return c })} />
                      <Radio.Group size="small" style={{ marginLeft: 12 }} value={config.subtitle_style?.position ?? 'bottom'}
                        onChange={(v) => updateConfig((c) => { c.subtitle_style.position = v; return c })}>
                        <Radio value="bottom">底部</Radio>
                        <Radio value="top">顶部</Radio>
                      </Radio.Group>
                    </div>
                  </div>
                </div>
              )}
              {!selClip && !selAudio && !selSub && (
                <Empty description="点击时间轴上的片段/音频/字幕查看属性" style={{ padding: 12 }} />
              )}
              {/* 原声与音频资产 */}
              <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>原声音量（全局）{(config.audio?.volume ?? 1).toFixed(1)}x</Text>
                <Slider value={config.audio?.volume ?? 1} min={0} max={2} step={0.1}
                  onChange={(v) => updateConfig((c) => { c.audio.volume = Number(v); return c })} />
                {audioAssets.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <Text style={{ fontWeight: 600, fontSize: 13 }}>音频资产（点击加到播放头处）</Text>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                      {audioAssets.slice(0, 8).map((a) => (
                        <Button key={a.id} size="mini" long onClick={() => addAudioClip(a.url, a.name)}>
                          <IconMusic /> {a.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activePanel === 'output' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <Text style={{ fontWeight: 600 }}>输出分辨率</Text>
                <Radio.Group direction="vertical" style={{ marginTop: 8, display: 'flex', gap: 6 }}
                  value={typeof config.resolution === 'string' ? config.resolution : '720p'}
                  onChange={(v) => updateConfig((c) => { c.resolution = v; return c })}>
                  {RES_PRESETS.map((p) => <Radio key={p.value} value={p.value}>{p.label}</Radio>)}
                </Radio.Group>
              </div>
              <Button type="primary" long icon={<IconExport />} loading={exporting} onClick={handleExport}>
                {exporting ? `导出中（${exportStage || '排队'}）` : '开始导出成片'}
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                操作：拖动片段主体=换序/移动；拖动左右边缘=裁剪；刻度尺拖动=播放头；S=拆分；Del=删除
              </Text>
              {lastOutput && (
                <div>
                  <Text style={{ fontWeight: 600 }}>最近导出</Text>
                  <video src={lastOutput} controls style={{ width: '100%', marginTop: 8, borderRadius: 8 }} />
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* 分镜视频选择弹窗 */}
      <Modal title="添加分镜视频" visible={addVideoVisible} onCancel={() => setAddVideoVisible(false)} footer={null}>
        {sceneVideos.length
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sceneVideos.map((s) => (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 8, background: 'var(--color-fill-2)', borderRadius: 6 }}>
                  <Space>
                    <Text>分镜#{s.sequence}</Text>
                    {s.duration != null && <Tag size="small">{fmtSec(s.duration)}</Tag>}
                  </Space>
                  <Button size="mini" type="primary" onClick={() => addSceneClip(s)}>添加</Button>
                </div>
              ))}
            </div>
          )
          : <Empty description="该集还没有已生成的分镜视频，可点「导入视频」上传本地素材" />}
      </Modal>
    </div>
  )
}

/** 轨道标签 */
const TrackLabel = ({ text }: { text: string }) => (
  <div style={{ fontSize: 11, color: 'var(--color-text-4)', margin: '4px 0 2px' }}>{text}</div>
)

/** 片段左右边缘拖拽把手（裁剪/调时长） */
const EdgeHandle = ({ side, gold, purple, onDown, onMove, onUp }: {
  side: 'l' | 'r'; gold?: boolean; purple?: boolean
  onDown: (e: React.PointerEvent) => void; onMove: (e: React.PointerEvent) => void; onUp: (e: React.PointerEvent) => void
}) => (
  <div
    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
    style={{
      position: 'absolute', [side]: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', touchAction: 'none',
      background: gold ? 'rgb(var(--gold-6))' : purple ? 'rgb(var(--purple-6))' : 'rgb(var(--arcoblue-6))',
      opacity: 0.75, borderRadius: side === 'l' ? '6px 0 0 6px' : '0 6px 6px 0',
    } as React.CSSProperties}
  />
)

/** 属性行 */
const Row = ({ label, node }: { label: string; node: React.ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
    <span style={{ fontSize: 12, width: 64, flexShrink: 0 }}>{label}</span>
    {node}
  </div>
)

export default EpisodeEditorPage
