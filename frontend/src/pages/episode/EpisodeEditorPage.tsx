/**
 * EpisodeEditorPage - 视频在线剪辑器（M7）
 *
 * 功能：片段时间轴（裁剪/排序/删除/音量）+ 预览、原声与 BGM 混音、
 * 中文字幕（样式/按分镜生成）、输出分辨率预设。
 * 草稿自动保存（防抖 1.5s PUT 后端 JSONB，进项目自动加载）；
 * 导出为后台 ffmpeg 任务（轮询进度），完成后在线播放。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Card, Empty, Form, Input, InputNumber, Message, Modal, Popconfirm,
  Radio, Select, Slider, Space, Spin, Tag, Tooltip, Typography,
} from '@arco-design/web-react'
import {
  IconLeft, IconPlus, IconDelete, IconUp, IconDown, IconSave, IconExport,
  IconCheckCircle, IconSync, IconClockCircle,
} from '@arco-design/web-react/icon'
import { useNavigate, useParams } from 'react-router-dom'
import { apiClient } from '@/api/client'

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

interface Clip { id: string; url: string; name: string; in: number; out: number | null; volume: number }
interface Sub { id: string; start: number; end: number; text: string }

const EpisodeEditorPage: React.FC = () => {
  const { projectId, episodeId } = useParams()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [episode, setEpisode] = useState<any>(null)
  const [sceneVideos, setSceneVideos] = useState<any[]>([])
  const [audioAssets, setAudioAssets] = useState<any[]>([])
  const [config, setConfig] = useState<any>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState('clips')
  // 草稿保存状态
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const saveTimer = useRef<any>(null)
  const dirtyRef = useRef(false)
  // 导出
  const [exporting, setExporting] = useState(false)
  const [exportStage, setExportStage] = useState('')
  const [lastOutput, setLastOutput] = useState<string | null>(null)
  const [addVisible, setAddVisible] = useState(false)

  const baseUrl = `/api/v1/projects/${projectId}/episodes/${episodeId}/video-edit`

  useEffect(() => { load() /* eslint-disable-next-line */ }, [])

  const load = async () => {
    setLoading(true)
    try {
      const d: any = await apiClient.get(baseUrl)
      setEpisode(d.episode)
      setSceneVideos(d.scene_videos || [])
      setAudioAssets(d.audio_assets || [])
      setConfig(d.config)
      setLastOutput(d.last_output_url || null)
      if (d.rendering) {
        setExporting(true)
        pollLatestTask()
      }
      const first = (d.config?.clips || [])[0]
      if (first) setSelectedClipId(first.id)
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }

  // ---- 草稿自动保存（防抖；引用变化触发） ----
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
      }, 1500)
  }
  const updateConfig = (fn: (c: any) => any) => {
    setConfig((prev: any) => {
      const next = fn(structuredClone(prev))
      scheduleSave(next)
      return next
    })
  }

  // ---- 时间轴计算 ----
  const clipDur = (c: Clip) => Math.max(0.1, (c.out ?? 99) - (c.in ?? 0))
  const clips: Clip[] = config?.clips || []
  const totalDur = useMemo(() => clips.reduce((s, c) => s + clipDur(c), 0), [clips])
  const subs: Sub[] = config?.subtitles || []

  const selectedClip = clips.find((c) => c.id === selectedClipId) || clips[0]

  // ---- 片段操作 ----
  const moveClip = (idx: number, dir: -1 | 1) => updateConfig((c) => {
    const j = idx + dir
    if (j < 0 || j >= c.clips.length) return c
    [c.clips[idx], c.clips[j]] = [c.clips[j], c.clips[idx]]
    return c
  })
  const removeClip = (id: string) => updateConfig((c) => {
    c.clips = c.clips.filter((x: Clip) => x.id !== id)
    return c
  })
  const patchClip = (id: string, patch: Partial<Clip>) => updateConfig((c) => {
    const t = c.clips.find((x: Clip) => x.id === id)
    if (t) Object.assign(t, patch)
    return c
  })
  const addClip = (url: string, name: string) => updateConfig((c) => {
    c.clips.push({ id: uid(), url, name, in: 0, out: null, volume: 1 })
    return c
  })

  // ---- 字幕操作 ----
  const addSub = () => updateConfig((c) => {
    const start = Math.max(0, totalDur - 3)
    c.subtitles.push({ id: uid(), start: Number(start.toFixed(1)), end: Number(Math.min(totalDur, start + 2).toFixed(1)), text: '' })
    return c
  })
  const patchSub = (id: string, patch: Partial<Sub>) => updateConfig((c) => {
    const t = c.subtitles.find((x: Sub) => x.id === id)
    if (t) Object.assign(t, patch)
    return c
  })
  const removeSub = (id: string) => updateConfig((c) => {
    c.subtitles = c.subtitles.filter((x: Sub) => x.id !== id)
    return c
  })

  // ---- 导出 ----
  const handleExport = async () => {
    if (!clips.length) { Message.warning('请先添加片段'); return }
    if (dirtyRef.current || saveState === 'saving') {
      Message.info('草稿保存中，请稍候…'); return
    }
    try {
      const r: any = await apiClient.post(`${baseUrl}/render`, { config })
      setExporting(true)
      setExportStage('已提交')
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
          clearInterval(timer)
          setExporting(false)
          const url = (t.output_urls || [])[0]
          if (url) setLastOutput(url)
          Message.success('成片导出完成')
        } else if (t.status === 'failed' || t.status === 'cancelled') {
          clearInterval(timer)
          setExporting(false)
          Message.error(`导出失败: ${(t.error_message || '').slice(0, 120)}`)
        }
      } catch { /* 网络抖动继续轮询 */ }
    }, 2500)
  }

  if (loading) return <Card><div style={{ textAlign: 'center', padding: 80 }}><Spin size={28} /></div></Card>
  if (!config) return <Card><Empty description="配置加载失败" /></Card>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {/* 顶部栏 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Button icon={<IconLeft />} onClick={() => navigate(`/projects/${projectId}/episodes/${episodeId}`)}>返回集详情</Button>
          <Title heading={5} style={{ margin: 0 }}>在线剪辑 · {episode?.title || `第${episode?.number ?? '?'}集`}</Title>
          <Tag color="arcoblue">{clips.length} 片段</Tag>
          <Tag color="cyan">总时长 {fmtSec(totalDur)}</Tag>
        </Space>
        <Space>
          {saveState === 'saving' && <Text type="secondary" style={{ fontSize: 12 }}><IconSync spin /> 保存中…</Text>}
          {saveState === 'saved' && (
            <Text type="success" style={{ fontSize: 12 }}>
              <IconCheckCircle /> 已自动保存{savedAt ? ` · ${new Date(savedAt).toLocaleTimeString('zh-CN')}` : ''}
            </Text>
          )}
          <Button type="primary" icon={<IconExport />} loading={exporting} onClick={handleExport}>
            {exporting ? `导出中（${exportStage || '排队'}）` : '导出成片'}
          </Button>
        </Space>
      </div>

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        {/* 左：预览 + 时间轴 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <Card style={{ flex: 1, display: 'flex', flexDirection: 'column' }} title="预览"
            bodyStyle={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 240 }}>
            {selectedClip
              ? (
                <video
                  key={selectedClip.id + selectedClip.in + selectedClip.out}
                  src={`${selectedClip.url}#t=${selectedClip.in ?? 0},${selectedClip.out ?? ''}`}
                  controls style={{ maxWidth: '100%', maxHeight: '48vh' }}
                />
              )
              : <Empty description="从右侧「片段」添加视频，或点击下方添加分镜视频" />}
          </Card>

          {/* 时间轴 */}
          <Card title="时间轴" bodyStyle={{ paddingTop: 12 }}
            extra={<Button size="small" icon={<IconPlus />} onClick={() => setAddVisible(true)}>添加片段</Button>}>
            {clips.length
              ? (
                <div>
                  {/* 视频轨道 */}
                  <div style={{ display: 'flex', gap: 3, height: 54 }}>
                    {clips.map((c, i) => (
                      <Tooltip key={c.id} content={`${c.name}｜${fmtSec(clipDur(c))}｜音量 ${(c.volume ?? 1).toFixed(1)}${c.volume === 0 ? '（静音）' : ''}`}>
                        <div onClick={() => setSelectedClipId(c.id)}
                          style={{
                            flex: Math.max(0.1, clipDur(c)),
                            display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
                            background: c.id === selectedClip?.id ? 'rgb(var(--arcoblue-5))' : 'var(--color-fill-3)',
                            borderRadius: 6, cursor: 'pointer', padding: '0 6px', minWidth: 44,
                            border: c.id === selectedClip?.id ? '2px solid rgb(var(--arcoblue-6))' : '2px solid transparent',
                          }}>
                          <Text style={{ fontSize: 12, fontWeight: 600, color: c.id === selectedClip?.id ? '#fff' : undefined }} ellipsis>{i + 1}. {c.name}</Text>
                          <Text style={{ fontSize: 11, color: c.id === selectedClip?.id ? 'rgba(255,255,255,.8)' : 'var(--color-text-3)' }}>{fmtSec(clipDur(c))}</Text>
                        </div>
                      </Tooltip>
                    ))}
                  </div>
                  {/* 字幕轨道（按时间比例） */}
                  {subs.length > 0 && (
                    <div style={{ position: 'relative', height: 26, marginTop: 6, background: 'var(--color-fill-2)', borderRadius: 6, overflow: 'hidden' }}>
                      {subs.map((s) => (
                        <Tooltip key={s.id} content={`${fmtSec(s.start)}-${fmtSec(s.end)}：${s.text || '（空）'}`}>
                          <div style={{
                            position: 'absolute', left: `${(s.start / Math.max(0.1, totalDur)) * 100}%`,
                            width: `${Math.max(1.5, ((s.end - s.start) / Math.max(0.1, totalDur)) * 100)}%`,
                            top: 3, bottom: 3, borderRadius: 4,
                            background: 'rgb(var(--gold-5))', display: 'flex', alignItems: 'center',
                            justifyContent: 'center', overflow: 'hidden', cursor: 'default',
                          }}>
                            <Text ellipsis style={{ fontSize: 11, padding: '0 4px' }}>{s.text}</Text>
                          </div>
                        </Tooltip>
                      ))}
                    </div>
                  )}
                  <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
                    点击片段选中预览；拖动顺序/裁剪/音量在右侧「片段」面板；字幕轨道按时间轴比例显示
                  </Text>
                </div>
              )
              : <Empty description="暂无片段" />}
          </Card>
        </div>

        {/* 右：属性面板 */}
        <Card style={{ width: 420, overflow: 'auto' }} bodyStyle={{ paddingTop: 4 }}>
          {/* Tabs 用受控切换 */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
            {([['clips', '片段'], ['audio', '音频'], ['subs', '字幕'], ['output', '输出']] as const).map(([k, label]) => (
              <Button key={k} size="small" type={activeTab === k ? 'primary' : 'default'} onClick={() => setActiveTab(k)}>{label}</Button>
            ))}
          </div>

          {/* ===== 片段面板 ===== */}
          {activeTab === 'clips' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {clips.map((c, i) => (
                <div key={c.id} style={{
                  padding: 10, borderRadius: 8, border: `1px solid ${c.id === selectedClip?.id ? 'rgb(var(--arcoblue-6))' : 'var(--color-border)'}`,
                  background: c.id === selectedClip?.id ? 'var(--color-fill-1)' : undefined,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={{ fontWeight: 600 }} ellipsis>{i + 1}. {c.name}</Text>
                    <Space size={2}>
                      <Button size="mini" icon={<IconUp />} disabled={i === 0} onClick={() => moveClip(i, -1)} />
                      <Button size="mini" icon={<IconDown />} disabled={i === clips.length - 1} onClick={() => moveClip(i, 1)} />
                      <Popconfirm title="删除该片段？" onOk={() => removeClip(c.id)}>
                        <Button size="mini" status="danger" icon={<IconDelete />} />
                      </Popconfirm>
                    </Space>
                  </div>
                  <Space size={10}>
                    <span style={{ fontSize: 12 }}>起点</span>
                    <InputNumber size="mini" min={0} step={0.1} value={c.in} style={{ width: 84 }}
                      onChange={(v) => patchClip(c.id, { in: Number(v) || 0 })} />
                    <span style={{ fontSize: 12 }}>终点</span>
                    <InputNumber size="mini" min={c.in + 0.1} step={0.1} value={c.out ?? undefined}
                      placeholder="到结尾" style={{ width: 84 }}
                      onChange={(v) => patchClip(c.id, { out: v == null ? null : Number(v) })} />
                    <Tag size="small">{fmtSec(clipDur(c))}</Tag>
                  </Space>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <span style={{ fontSize: 12, width: 64 }}>{c.volume === 0 ? '静音' : '音量'}</span>
                    <Slider value={c.volume} min={0} max={2} step={0.1} style={{ flex: 1, margin: '0 4px' }}
                      onChange={(v) => patchClip(c.id, { volume: Number(v) || 0 })} />
                    <span style={{ fontSize: 12, width: 30 }}>{c.volume.toFixed(1)}x</span>
                  </div>
                </div>
              ))}
              <Button long icon={<IconPlus />} onClick={() => setAddVisible(true)}>添加片段</Button>
            </div>
          )}

          {/* ===== 音频面板 ===== */}
          {activeTab === 'audio' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <Text style={{ fontWeight: 600 }}>原声音量（全局）</Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <Slider value={config.audio?.volume ?? 1} min={0} max={2} step={0.1} style={{ flex: 1 }}
                    onChange={(v) => updateConfig((c) => { c.audio.volume = v; return c })} />
                  <Tag size="small">{(config.audio?.volume ?? 1).toFixed(1)}x{config.audio?.volume === 0 ? ' 静音' : ''}</Tag>
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>作用于全部片段的原声（片段单独音量在「片段」面板）</Text>
              </div>
              <div>
                <Text style={{ fontWeight: 600 }}>背景音乐（BGM）</Text>
                <Select
                  placeholder="选择 BGM（项目音频资产）" allowClear style={{ width: '100%', marginTop: 6 }}
                  value={config.audio?.bgm?.url || undefined}
                  onChange={(v) => updateConfig((c) => {
                    c.audio.bgm = v ? { url: v, volume: c.audio.bgm?.volume ?? 0.3, fade_in: c.audio.bgm?.fade_in ?? 1, fade_out: c.audio.bgm?.fade_out ?? 2 } : null
                    return c
                  })}
                >
                  {audioAssets.map((a) => <Select.Option key={a.id} value={a.url}>{a.name}</Select.Option>)}
                </Select>
                {config.audio?.bgm && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, width: 52 }}>音量</span>
                      <Slider value={config.audio.bgm.volume} min={0} max={1.5} step={0.05} style={{ flex: 1 }}
                        onChange={(v) => updateConfig((c) => { c.audio.bgm.volume = Number(v) || 0; return c })} />
                      <span style={{ fontSize: 12, width: 34 }}>{config.audio.bgm.volume.toFixed(2)}</span>
                    </div>
                    <Space size={10}>
                      <span style={{ fontSize: 12 }}>淡入</span>
                      <InputNumber size="mini" min={0} max={10} step={0.5} value={config.audio.bgm.fade_in} style={{ width: 80 }}
                        onChange={(v) => updateConfig((c) => { c.audio.bgm.fade_in = Number(v) || 0; return c })} />
                      <span style={{ fontSize: 12 }}>淡出</span>
                      <InputNumber size="mini" min={0} max={10} step={0.5} value={config.audio.bgm.fade_out} style={{ width: 80 }}
                        onChange={(v) => updateConfig((c) => { c.audio.bgm.fade_out = Number(v) || 0; return c })} />
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>BGM 自动循环铺满全片，导出时与原声混音</Text>
                  </div>
                )}
                {!audioAssets.length && <Text type="secondary" style={{ fontSize: 12 }}>项目还没有音频资产，可到「资源管理」上传参考音频后选用</Text>}
              </div>
            </div>
          )}

          {/* ===== 字幕面板 ===== */}
          {activeTab === 'subs' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Space>
                <Button size="small" icon={<IconPlus />} onClick={addSub}>添加字幕</Button>
              </Space>
              {subs.length === 0 && <Empty description="暂无字幕" />}
              {subs.map((s) => (
                <div key={s.id} style={{ padding: 8, borderRadius: 8, background: 'var(--color-fill-2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <IconClockCircle style={{ color: 'var(--color-text-3)' }} />
                    <InputNumber size="mini" min={0} max={Math.max(1, totalDur)} step={0.1} value={s.start} style={{ width: 78 }}
                      onChange={(v) => patchSub(s.id, { start: Number(v) || 0 })} />
                    <span style={{ fontSize: 12 }}>至</span>
                    <InputNumber size="mini" min={0} max={Math.max(1, totalDur) + 60} step={0.1} value={s.end} style={{ width: 78 }}
                      onChange={(v) => patchSub(s.id, { end: Number(v) || 0 })} />
                    <span style={{ flex: 1 }} />
                    <Popconfirm title="删除该字幕？" onOk={() => removeSub(s.id)}>
                      <Button size="mini" status="danger" icon={<IconDelete />} />
                    </Popconfirm>
                  </div>
                  <Input size="small" maxLength={120} value={s.text} placeholder="字幕文本"
                    onChange={(v) => patchSub(s.id, { text: v })} />
                </div>
              ))}
              {subs.length > 0 && (
                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
                  <Text style={{ fontWeight: 600, fontSize: 13 }}>字幕样式</Text>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <span style={{ fontSize: 12 }}>字号</span>
                    <InputNumber size="mini" min={16} max={64} value={config.subtitle_style?.font_size ?? 28} style={{ width: 80 }}
                      onChange={(v) => updateConfig((c) => { c.subtitle_style.font_size = Number(v) || 28; return c })} />
                    <span style={{ fontSize: 12 }}>位置</span>
                    <Radio.Group size="small" value={config.subtitle_style?.position ?? 'bottom'}
                      onChange={(v) => updateConfig((c) => { c.subtitle_style.position = v; return c })}>
                      <Radio value="bottom">底部</Radio>
                      <Radio value="top">顶部</Radio>
                    </Radio.Group>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===== 输出面板 ===== */}
          {activeTab === 'output' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <Text style={{ fontWeight: 600 }}>输出分辨率</Text>
                <Radio.Group direction="vertical" style={{ marginTop: 8, display: 'flex', gap: 6 }}
                  value={typeof config.resolution === 'string' ? config.resolution : 'custom'}
                  onChange={(v) => updateConfig((c) => { c.resolution = v; return c })}>
                  {RES_PRESETS.map((p) => <Radio key={p.value} value={p.value}>{p.label}</Radio>)}
                </Radio.Group>
              </div>
              <div>
                <Text style={{ fontWeight: 600 }}>导出</Text>
                <div style={{ marginTop: 8 }}>
                  <Button type="primary" long icon={<IconExport />} loading={exporting} onClick={handleExport}>
                    {exporting ? `导出中（${exportStage || '排队'}）` : '开始导出成片'}
                  </Button>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                    后台 ffmpeg 合成：拼接裁剪 → 混音 → 字幕烧录。完成后在下方播放，也可从集详情再次进入继续编辑
                  </Text>
                </div>
              </div>
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

      {/* 添加片段弹窗 */}
      <Modal title="添加片段" visible={addVisible} onCancel={() => setAddVisible(false)} footer={null}>
        {sceneVideos.length
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sceneVideos.map((s) => (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 8, background: 'var(--color-fill-2)', borderRadius: 6 }}>
                  <Space>
                    <Text>分镜#{s.sequence}</Text>
                    {s.duration != null && <Tag size="small">{fmtSec(s.duration)}</Tag>}
                  </Space>
                  <Button size="mini" type="primary" onClick={() => { addClip(s.url, `分镜#${s.sequence}`); setAddVisible(false) }}>添加</Button>
                </div>
              ))}
              <Text type="secondary" style={{ fontSize: 12 }}>仅显示已生成视频的分镜；重复添加同一素材可用裁剪取不同段落</Text>
            </div>
          )
          : <Empty description="该集还没有已生成的分镜视频，请先生成" />}
      </Modal>
    </div>
  )
}

export default EpisodeEditorPage
