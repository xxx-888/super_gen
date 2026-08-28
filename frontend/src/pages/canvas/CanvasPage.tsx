/**
 * CanvasPage - 画布面板主页面
 *
 * 替代旧的「工作台」和「创作面板」，统一为一个基于 React Flow 的节点画布。
 * 两种模式：
 * - 列表模式：选项目 → 显示画布卡片网格 → 新建/打开/删除/复制画布
 * - 编辑模式：打开画布后进入节点画布编辑器（左侧节点面板 + 中间画布 + 顶部工具栏）
 *
 * 画布结构持久化到后端 /projects/{projectId}/canvas（graph_data 整存整取），
 * 本地 localStorage 存未保存草稿防丢失。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, useNodesState, useEdgesState, useReactFlow,
  type Connection, type Node, type Edge,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Card, Typography, Button, Space, Select, Message, Empty, Spin, Modal,
  Input, Tag, Tooltip, Grid,
} from '@arco-design/web-react'
import {
  IconPlus, IconDelete, IconRefresh, IconSave, IconBackward, IconCopy, IconQuestionCircle,
  IconApps, IconUpload, IconThunderbolt, IconShareAlt, IconClockCircle,
} from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { projectService, canvasService, CanvasData } from '@/api/services'
import { useCanvasStore, useTeamStore } from '@/stores'
import { NodePalette } from '@/components/canvas/NodePalette'
import { canvasNodeTypes } from '@/components/canvas/nodes'
import { NODE_REGISTRY, isValidConnection, type CanvasNodeType } from '@/components/canvas/types'
import { DeletableEdge } from '@/components/canvas/DeletableEdge'
import { DropUploadModal, type DropFileItem, type DropUploadResult } from '@/components/canvas/DropUploadModal'
import { detectMediaType, type MediaType } from '@/components/canvas/materialUpload'

// 全部连线（含历史画布的 default 类型）都用带剪刀按钮的可删除样式
const canvasEdgeTypes = { default: DeletableEdge, deletable: DeletableEdge }

// 拖拽文件批量上传的单次上限与显示名
const DROP_FILE_LIMITS: Record<MediaType, number> = { image: 9, video: 3, audio: 3 }
const MEDIA_TYPE_LABEL: Record<MediaType, string> = { image: '图片', video: '视频', audio: '音频' }
// 拖拽上传生成的节点 id 防撞序号（同毫秒多批次）
let dropNodeSeq = 0

/** 拖拽事件携带的是否本地文件（节点面板拖拽带自定义 MIME，不带 Files） */
const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')
import { useNodeExecution } from '@/hooks/useNodeExecution'
import { CanvasRuntimeContext, type CanvasRuntime } from '@/components/canvas/CanvasContext'

const { Title, Text } = Typography
const { Row, Col } = Grid

// ==================== 列表模式 ====================
const CanvasListMode: React.FC = () => {
  const navigate = useNavigate()
  const { canvases, loading, loadCanvases, createCanvas, deleteCanvas, duplicateCanvas, openCanvas, setProjectId } = useCanvasStore()
  const { currentOrg } = useTeamStore()
  const [projects, setProjects] = React.useState<any[]>([])
  const [selectedProjectId, setSelectedProjectId] = React.useState<string>('')
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const [newVisible, setNewVisible] = React.useState(false)
  // 画布搜索与排序（数据全量在 store，前端过滤/排序）
  const [canvasSearch, setCanvasSearch] = React.useState('')
  const [canvasSort, setCanvasSort] = React.useState('updated_at')

  // 搜索过滤 + 排序后的画布列表
  const visibleCanvases = React.useMemo(() => {
    let list = [...canvases]
    if (canvasSearch) {
      const kw = canvasSearch.toLowerCase()
      list = list.filter((c: any) => (c.name || '').toLowerCase().includes(kw))
    }
    const keyFns: Record<string, (c: any) => any> = {
      updated_at: (c) => c.updated_at || '',
      created_at: (c) => c.created_at || '',
      name: (c) => c.name || '',
    }
    const fn = keyFns[canvasSort] || keyFns.updated_at
    list.sort((a: any, b: any) => canvasSort === 'name'
      ? String(fn(a)).localeCompare(String(fn(b)), 'zh')
      : String(fn(b)).localeCompare(String(fn(a))))
    return list
  }, [canvases, canvasSearch, canvasSort])

  // 加载项目列表（按当前团队过滤）
  useEffect(() => {
    (async () => {
      try {
        const data: any = await projectService.list({ org_id: currentOrg?.id })
        const list = Array.isArray(data) ? data : (data?.items ?? data?.data ?? [])
        setProjects(list)
        if (!selectedProjectId && list.length > 0) setSelectedProjectId(list[0].id)
      } catch { setProjects([]) }
    })()
  }, [currentOrg?.id])

  useEffect(() => {
    if (selectedProjectId) {
      setProjectId(selectedProjectId)
      loadCanvases(selectedProjectId)
    }
  }, [selectedProjectId, setProjectId, loadCanvases])

  const handleCreate = async () => {
    if (!selectedProjectId) { Message.warning('请先选择项目'); return }
    setCreating(true)
    try {
      const canvas = await createCanvas(selectedProjectId, newName || undefined)
      if (canvas) {
        Message.success('已创建新画布')
        setNewVisible(false)
        setNewName('')
        openCanvas(canvas)
      }
    } finally { setCreating(false) }
  }

  const handleDelete = async (id: string, name: string) => {
    Modal.confirm({
      title: '确认删除',
      content: `确定删除画布「${name}」吗？此操作不可恢复。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        const ok = await deleteCanvas(id)
        if (ok) Message.success('已删除')
      },
    })
  }

  const handleDuplicate = async (id: string) => {
    const c = await duplicateCanvas(id)
    if (c) Message.success('已复制')
  }

  return (
    <div style={{ padding: 0 }}>
      {/* 画布统计（当前项目） */}
      {selectedProjectId && canvases.length > 0 && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          {[
            { t: '画布总数', v: canvases.length, s: undefined, c: 'rgb(var(--arcoblue-6))', I: IconApps },
            { t: '节点总数', v: canvases.reduce((s: number, c: any) => s + (c.meta?.node_count || 0), 0), s: '当前项目所有画布', c: 'rgb(var(--purple-6))', I: IconThunderbolt },
            { t: '连线总数', v: canvases.reduce((s: number, c: any) => s + (c.meta?.edge_count || 0), 0), s: undefined, c: 'rgb(var(--green-6))', I: IconShareAlt },
            { t: '最近更新', v: (() => { const latest = canvases.reduce((a: any, c: any) => (c.updated_at > (a?.updated_at || '') ? c : a), null); return latest?.updated_at ? new Date(latest.updated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'; })(), s: undefined, c: 'rgb(var(--orange-6))', I: IconClockCircle },
          ].map(({ t, v, s, c, I }: any) => (
            <Col key={t} span={6}>
              <Card style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <I style={{ fontSize: 22, color: c }} />
                  <Text type="secondary" style={{ fontSize: 13 }}>{t}</Text>
                </div>
                <div style={{ fontSize: 24, fontWeight: 600, marginTop: 8 }}>{v}</div>
                {s && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{s}</div>}
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* 项目选择 + 搜索排序 + 新建 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Text style={{ color: 'var(--color-text-2)' }}>项目：</Text>
        <Select
          style={{ width: 220 }}
          placeholder="选择项目"
          value={selectedProjectId || undefined}
          onChange={setSelectedProjectId}
          showSearch
          filterOption={(input: string, option: any) => {
            const p = projects.find((x: any) => x.id === option?.value)
            return p ? p.name.toLowerCase().includes(input.toLowerCase()) : false
          }}
        >
          {projects.map((p: any) => (
            <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
          ))}
        </Select>
        {selectedProjectId && canvases.length > 0 && (
          <>
            <Input
              placeholder="搜索画布名称"
              style={{ width: 170 }}
              value={canvasSearch}
              onChange={setCanvasSearch}
              allowClear
            />
            <Select value={canvasSort} style={{ width: 120 }} onChange={setCanvasSort}>
              <Select.Option value="updated_at">按最近更新</Select.Option>
              <Select.Option value="created_at">按创建时间</Select.Option>
              <Select.Option value="name">按名称</Select.Option>
            </Select>
          </>
        )}
        <Button type="primary" icon={<IconPlus />} onClick={() => {
          if (!selectedProjectId) { Message.warning('请先选择项目'); return }
          setNewVisible(true)
        }}>新建画布</Button>
        <Button icon={<IconRefresh />} onClick={() => selectedProjectId && loadCanvases(selectedProjectId)}>刷新</Button>
      </div>

      {/* 画布网格 */}
      {loading ? (
        <Spin dot style={{ display: 'block', margin: '60px auto' }} />
      ) : projects.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Empty description="还没有项目，画布挂在项目下——先去创建一个项目" />
          <Button type="primary" style={{ marginTop: 12 }} onClick={() => navigate('/projects')}>去创建项目</Button>
        </div>
      ) : canvases.length === 0 ? (
        <Empty
          description={selectedProjectId ? '该项目还没有画布，点击「新建画布」开始创作' : '请先选择项目'}
          style={{ padding: 60 }}
        />
      ) : visibleCanvases.length === 0 ? (
        <Empty description="没有符合搜索条件的画布" style={{ padding: 60 }} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {visibleCanvases.map((c: any) => {
            const nodeCount = c.meta?.node_count || 0
            const edgeCount = c.meta?.edge_count || 0
            return (
              <Card
                key={c.id}
                hoverable
                size="small"
                style={{ cursor: 'pointer', overflow: 'hidden' }}
                onClick={() => openCanvas(c as CanvasData)}
                cover={
                  <div style={{
                    height: 140, background: 'var(--color-fill-3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    backgroundImage: c.thumbnail_url ? `url(${c.thumbnail_url})` : undefined,
                    backgroundSize: 'cover', backgroundPosition: 'center',
                  }}>
                    {!c.thumbnail_url && <IconApps style={{ fontSize: 40, color: 'var(--color-text-4)' }} />}
                  </div>
                }
                actions={[
                  <Tooltip key="copy" content="复制">
                    <IconCopy onClick={(e) => { e.stopPropagation(); handleDuplicate(c.id) }} />
                  </Tooltip>,
                  <Tooltip key="del" content="删除">
                    <IconDelete onClick={(e) => { e.stopPropagation(); handleDelete(c.id, c.name) }} style={{ color: 'rgb(var(--danger-6))' }} />
                  </Tooltip>,
                ]}
              >
                <Card.Meta
                  title={<Text ellipsis style={{ maxWidth: 200 }}>{c.name}</Text>}
                  description={
                    <Space size="small" style={{ fontSize: 12, display: 'block' }}>
                      <Space size="small" style={{ fontSize: 12 }}>
                        <Tag size="small" color="arcoblue">{nodeCount} 节点</Tag>
                        <Tag size="small">{edgeCount} 连线</Tag>
                        <Text type="secondary" style={{ fontSize: 11 }}>v{c.version}</Text>
                      </Space>
                      {c.updated_at && (
                        <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                          更新 {new Date(c.updated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </Text>
                      )}
                    </Space>
                  }
                />
              </Card>
            )
          })}
        </div>
      )}

      {/* 新建画布弹窗 */}
      <Modal
        title="新建画布"
        visible={newVisible}
        onCancel={() => { setNewVisible(false); setNewName('') }}
        onOk={handleCreate}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
      >
        <div style={{ marginBottom: 8, color: 'var(--color-text-2)' }}>画布名称（可留空，后续可修改）</div>
        <Input
          placeholder="如：林弈的抉择·第一场"
          value={newName}
          onChange={setNewName}
          onPressEnter={handleCreate}
        />
      </Modal>
    </div>
  )
}

// ==================== 编辑模式（画布编辑器） ====================
const CanvasEditMode: React.FC<{ canvas: CanvasData }> = ({ canvas }) => {
  const navigate = useNavigate()
  // 用 selector 精确订阅，避免 dirty/saving 等变化触发不必要的重渲染
  const projectId = useCanvasStore(s => s.projectId)
  const saveCanvas = useCanvasStore(s => s.saveCanvas)
  const closeCanvas = useCanvasStore(s => s.closeCanvas)
  const setCurrentCanvas = useCanvasStore(s => s.setCurrentCanvas)
  const setDirty = useCanvasStore(s => s.setDirty)
  const dirty = useCanvasStore(s => s.dirty)
  const saving = useCanvasStore(s => s.saving)
  // 屏幕坐标 → 画布坐标（拖拽文件落点定位用）
  const { screenToFlowPosition } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(
    (canvas.graph_data?.nodes as Node[]) || []
  )
  // 连线图例帮助弹窗
  const [helpVisible, setHelpVisible] = React.useState(false)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    (canvas.graph_data?.edges as Edge[]) || []
  )
  const [editingName, setEditingName] = React.useState(false)
  const [name, setName] = React.useState(canvas.name)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)

  // 本地文件拖拽批量上传：待确认文件列表 + 悬停高亮
  const [dropFiles, setDropFiles] = React.useState<DropFileItem[] | null>(null)
  const [fileDragging, setFileDragging] = React.useState(false)
  const fileDragDepthRef = useRef(0)   // dragenter/leave 计数（子元素切换不闪断）
  const dropAnchorRef = useRef<{ x: number; y: number } | null>(null)  // 落点画布坐标

  // 连线素材 → 提示词自动 @引用 的同步函数（依赖 useNodeExecution，定义后赋值）
  const syncPromptMentionRef = useRef<((sourceId: string, targetId: string, added: boolean) => void) | null>(null)
  const canvasIdRef = useRef(canvas.id)
  nodesRef.current = nodes
  edgesRef.current = edges
  canvasIdRef.current = canvas.id
  const saveCanvasRef = useRef(saveCanvas)
  saveCanvasRef.current = saveCanvas
  const setDirtyRef = useRef(setDirty)
  setDirtyRef.current = setDirty

  // 防抖自动保存（不依赖 React state/effect，直接用 ref + setTimeout）
  const scheduleAutoSave = useCallback(() => {
    setDirtyRef.current(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      // 保存时保留 _status 和 _result（刷新后恢复生成结果），
      // 只剥离函数和临时运行时字段
      const KEEP_RUNTIME = new Set(['_status', '_result', '_errorMessage'])
      const cleanNodes = nodesRef.current.map((n) => {
        const cleanData: Record<string, any> = {}
        for (const [k, v] of Object.entries(n.data || {})) {
          if (!k.startsWith('_') || KEEP_RUNTIME.has(k)) {
            // 跳过函数类型（_run 等，不可 JSON 序列化）
            if (typeof v !== 'function') cleanData[k] = v
          }
        }
        return { ...n, data: cleanData as any }
      })
      const ok = await saveCanvasRef.current({ nodes: cleanNodes, edges: edgesRef.current })
      if (ok) {
        try { localStorage.removeItem(`canvas-draft-${canvasIdRef.current}`) } catch {}
      }
    }, 2000)
  }, [])  // 空依赖，引用永远稳定

  // 包装 onNodesChange：React Flow 的节点变化（拖拽/选中/尺寸）触发自动保存
  const handleNodesChange = useCallback((changes: any[]) => {
    onNodesChange(changes)
    scheduleAutoSave()
  }, [onNodesChange, scheduleAutoSave])

  // 包装 onEdgesChange：连线变化触发自动保存
  const handleEdgesChange = useCallback((changes: any[]) => {
    // 断线（Delete 键/拖走连线）时，同步移除目标节点提示词里的自动 @引用
    for (const c of changes) {
      if (c.type === 'remove') {
        const e = edgesRef.current.find((x) => x.id === c.id)
        if (e) syncPromptMentionRef.current?.(e.source, e.target, false)
      }
    }
    onEdgesChange(changes)
    scheduleAutoSave()
  }, [onEdgesChange, scheduleAutoSave])

  // 节点执行引擎（runNode 引用稳定，不会触发重渲染）
  const { runNode, updateNodeData } = useNodeExecution({
    projectId: projectId || undefined,
    onNodesChange: setNodes,
    getNodesEdges: () => ({ nodes: nodesRef.current, edges: edgesRef.current }),
  })

  // 删除节点（同时移除关联连线）
  const deleteNode = useCallback((nodeId: string) => {
    // 删除素材/上传素材节点时，同步移除下游提示词里的自动 @引用
    for (const e of edgesRef.current) {
      if (e.source === nodeId) syncPromptMentionRef.current?.(e.source, e.target, false)
    }
    setNodes((nds) => nds.filter((n) => n.id !== nodeId))
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
    scheduleAutoSave()
  }, [setNodes, setEdges, scheduleAutoSave])

  // 连线素材 → 目标生成节点提示词自动写入/移除 @名称（与手动 @ 完全同格式，
  // 打开提示词编辑器即可看到并高亮；断线/删上游节点时同步移除）
  const syncPromptMention = useCallback((sourceId: string, targetId: string, added: boolean) => {
    const src = nodesRef.current.find((n) => n.id === sourceId)
    const tgt = nodesRef.current.find((n) => n.id === targetId)
    if (!src || !tgt) return
    const sd: any = src.data
    let name: string | undefined = src.type === 'material' ? sd.name
      : src.type === 'uploadMaterial' ? sd.files?.[sd.mediaType]?.name
      : sd.savedMaterial?.name  // 图片生成节点存为素材库后的结果图
    if (!name && sd._result?.length) {
      // 未入库的生成结果：自动分配稳定别名（@别名 只是提示词指代，不展开资源；
      // 媒体本体仍按连线传输，入库后再次连线则用素材名）
      if (!sd.refAlias) {
        const label = NODE_REGISTRY[src.type as CanvasNodeType]?.label || '生成'
        const alias = `${label}-${String(src.id).slice(-4)}`
        updateNodeData(src.id, { refAlias: alias })
        sd.refAlias = alias
      }
      name = sd.refAlias
    }
    if (!name) return
    // 只有带提示词的生成节点自动写入（TTS 用 text 字段，跳过）
    if (!['videoGen', 'imageGen', 'fusionGen', 'imageToImage', 'videoToVideo', 'firstLastFrame'].includes(String(tgt.type))) return
    const token = `@${name}`
    const cur = String((tgt.data as any).prompt || '')
    // 去重/移除需双格式识别：编辑器芯片序列化为 @{type:uuid:name} 模板、
    // 连线插入为 @名称 裸名 —— 只认裸名会导致重复插入或删不掉
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tmplWordRe = new RegExp(`^@\\{\\w+:[a-f0-9-]{36}:${esc}\\}$`)
    const words = cur.split(/\s+/).filter(Boolean)
    const already = words.includes(token) || words.some((w) => tmplWordRe.test(w)) || cur.includes(token)
    if (added) {
      if (already) return
      // 新引用插入提示词最前面（与运行时注入位置一致，保持素材引用在描述文本之前）
      updateNodeData(targetId, { prompt: [token, ...words].join(' ') })
    } else {
      const next = words.filter((w) => w !== token && !tmplWordRe.test(w)).join(' ')
      if (next !== cur) updateNodeData(targetId, { prompt: next })
    }
  }, [updateNodeData])
  syncPromptMentionRef.current = syncPromptMention

  // 图片生成节点「存为素材库」后：已存在的下游连线立即补写 @引用
  // （连线发生在入库之前时，@名称无法在连线时刻写入，这里补上）
  useEffect(() => {
    const handler = (ev: Event) => {
      const { nodeId } = (ev as CustomEvent).detail || {}
      if (!nodeId) return
      for (const e of edgesRef.current) {
        if (e.source === nodeId) syncPromptMentionRef.current?.(e.source, e.target, true)
      }
    }
    window.addEventListener('canvas:material-saved', handler)
    return () => window.removeEventListener('canvas:material-saved', handler)
  }, [])

  // 删除连线（剪刀按钮用）：联动移除下游提示词里的自动 @引用
  const deleteEdge = useCallback((edgeId: string) => {
    const e = edgesRef.current.find((x) => x.id === edgeId)
    if (!e) return
    syncPromptMentionRef.current?.(e.source, e.target, false)
    setEdges((eds) => eds.filter((x) => x.id !== edgeId))
    scheduleAutoSave()
  }, [setEdges, scheduleAutoSave])

  // 传递给节点的运行时上下文。用 useMemo 保持引用稳定。
  const runtime: CanvasRuntime = useMemo(() => ({
    projectId: projectId || undefined,
    runNode,
    updateNodeData,
    deleteNode,
    deleteEdge,
  }), [projectId, runNode, updateNodeData, deleteNode, deleteEdge])

  // 离开页面前保存
  useEffect(() => {
    const handler = () => {
      if (useCanvasStore.getState().dirty) {
        saveCanvasRef.current({ nodes: nodesRef.current, edges: edgesRef.current })
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // 连线校验
  const onConnect = useCallback((params: Connection) => {
    if (!isValidConnection(params)) {
      Message.warning('句柄类型不匹配，无法连线')
      return
    }
    setEdges((eds) => addEdge({
      ...params,
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-text-3)' },
    }, eds))
    // 连线成功：素材自动在目标节点提示词里写入 @引用
    if (params.source && params.target) {
      syncPromptMentionRef.current?.(params.source, params.target, true)
    }
    scheduleAutoSave()
  }, [setEdges, scheduleAutoSave])

  // 拖拽：① 本地文件拖入 → 批量上传素材；② 节点面板拖入 → 创建节点
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = dragHasFiles(e) ? 'copy' : 'move'
  }, [])

  // 文件悬停高亮（计数法：进出子元素各配对一次，深度归零才算真正离开）
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    fileDragDepthRef.current += 1
    setFileDragging(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
    if (fileDragDepthRef.current === 0) setFileDragging(false)
  }, [])

  /** 拖入的本地文件：按 MIME/扩展名识别类型，超上限与不支持的跳过并提示，其余进批量确认弹窗 */
  const handleFileDrop = useCallback((dropped: File[], e: React.DragEvent) => {
    if (!projectId) { Message.warning('缺少项目信息，无法上传素材'); return }
    const accepted: DropFileItem[] = []
    const counts: Record<MediaType, number> = { image: 0, video: 0, audio: 0 }
    const skipped: string[] = []
    const overLimit: MediaType[] = []
    for (const file of dropped) {
      const mt = detectMediaType(file)
      if (!mt) { skipped.push(file.name); continue }
      if (counts[mt] >= DROP_FILE_LIMITS[mt]) { overLimit.push(mt); continue }
      counts[mt] += 1
      accepted.push({ file, mediaType: mt })
    }
    if (skipped.length) {
      const shown = skipped.slice(0, 3).join('、')
      Message.warning(`已忽略不支持的文件：${shown}${skipped.length > 3 ? ` 等 ${skipped.length} 个` : ''}`)
    }
    for (const mt of ['image', 'video', 'audio'] as MediaType[]) {
      const n = overLimit.filter((x) => x === mt).length
      if (n > 0) Message.warning(`${MEDIA_TYPE_LABEL[mt]}单次最多 ${DROP_FILE_LIMITS[mt]} 个，已忽略超出的 ${n} 个`)
    }
    if (accepted.length === 0) { Message.error('没有可上传的图片/视频/音频文件'); return }
    dropAnchorRef.current = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    setDropFiles(accepted)
  }, [projectId, screenToFlowPosition])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    fileDragDepthRef.current = 0
    setFileDragging(false)
    // ① 本地文件拖入 → 批量上传素材
    const droppedFiles = Array.from(e.dataTransfer.files || [])
    if (droppedFiles.length > 0) {
      handleFileDrop(droppedFiles, e)
      return
    }
    // ② 节点面板拖入 → 创建节点
    const nodeType = e.dataTransfer.getData('application/canvas-node') as CanvasNodeType
    if (!nodeType || !NODE_REGISTRY[nodeType]) return
    const meta = NODE_REGISTRY[nodeType]
    // React Flow 坐标转换（屏幕坐标 → 画布坐标）需要 rfInstance，这里用近似（中心偏移）
    // 简化：放在画布中心附近的相对位置
    const position = {
      x: e.clientX - 400,
      y: e.clientY - 200,
    }
    const newNode: Node = {
      id: `${nodeType}-${Date.now()}`,
      type: nodeType,
      position,
      data: { ...meta.defaultData, _projectId: projectId },
    }
    setNodes((nds) => nds.concat(newNode))
    scheduleAutoSave()
  }, [projectId, setNodes, scheduleAutoSave, handleFileDrop])

  /** 批量上传完成的文件 → 在落点网格位创建「上传素材」节点（每行 3 个） */
  const handleDropUploaded = useCallback((result: DropUploadResult) => {
    const anchor = dropAnchorRef.current || { x: 80, y: 80 }
    const col = result.index % 3
    const rowIdx = Math.floor(result.index / 3)
    const newNode: Node = {
      id: `uploadMaterial-${Date.now()}-${result.index}-${dropNodeSeq++}`,
      type: 'uploadMaterial',
      position: { x: anchor.x + col * 290, y: anchor.y + rowIdx * 340 },
      data: {
        mediaType: result.mediaType,
        files: { [result.mediaType]: { url: result.url, name: result.name, imageClass: result.imageClass, resourceId: result.resourceId } },
        _projectId: projectId,
      },
    }
    setNodes((nds) => nds.concat(newNode))
    scheduleAutoSave()
  }, [projectId, setNodes, scheduleAutoSave])

  // 双击侧栏节点创建（在画布中心）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeType: CanvasNodeType }
      const meta = NODE_REGISTRY[detail.nodeType]
      const newNode: Node = {
        id: `${detail.nodeType}-${Date.now()}`,
        type: detail.nodeType,
        position: { x: 200 + Math.random() * 100, y: 200 + Math.random() * 100 },
        data: { ...meta.defaultData, _projectId: projectId },
      }
      setNodes((nds) => nds.concat(newNode))
      scheduleAutoSave()
    }
    window.addEventListener('canvas:add-node', handler)
    return () => window.removeEventListener('canvas:add-node', handler)
  }, [projectId, setNodes, scheduleAutoSave])

  // 手动保存
  const handleManualSave = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const KEEP_RUNTIME = new Set(['_status', '_result', '_errorMessage'])
    const cleanNodes = nodesRef.current.map((n) => {
      const cleanData: Record<string, any> = {}
      for (const [k, v] of Object.entries(n.data || {})) {
        if ((!k.startsWith('_') || KEEP_RUNTIME.has(k)) && typeof v !== 'function') {
          cleanData[k] = v
        }
      }
      return { ...n, data: cleanData as any }
    })
    const ok = await saveCanvasRef.current({ nodes: cleanNodes, edges: edgesRef.current })
    if (ok) Message.success('已保存')
  }

  // 重命名
  const handleRename = async () => {
    setEditingName(false)
    if (name !== canvas.name && projectId) {
      try {
        const res: any = await canvasService(projectId).update(canvas.id, { name })
        const updated = (res?.data ?? res) as CanvasData
        setCurrentCanvas({ ...canvas, name: updated.name })
        Message.success('已重命名')
      } catch { Message.error('重命名失败') }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px - 40px)' }}>
      {/* 顶部工具栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        background: 'var(--color-bg-1)', borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}>
        <Button type="text" icon={<IconBackward />} onClick={() => closeCanvas()}>返回列表</Button>
        {editingName ? (
          <Input
            size="small"
            style={{ width: 200 }}
            value={name}
            onChange={setName}
            onBlur={handleRename}
            onPressEnter={handleRename}
            autoFocus
          />
        ) : (
          <Text
            style={{ cursor: 'pointer', fontWeight: 600, fontSize: 15 }}
            onClick={() => setEditingName(true)}
            title="点击重命名"
          >
            {canvas.name}
          </Text>
        )}
        <Tag size="small" color="arcoblue">v{canvas.version}</Tag>
        {dirty && <Tag size="small" color="orange">未保存</Tag>}
        {saving && <Tag size="small" color="arcoblue">保存中…</Tag>}
        <div style={{ flex: 1 }} />
        <Button icon={<IconQuestionCircle />} onClick={() => setHelpVisible(true)}>连线图例</Button>
        <Button icon={<IconSave />} type="primary" onClick={handleManualSave} loading={saving}>保存</Button>
      </div>

      {/* 画布主体 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <NodePalette />
        <div
          style={{ flex: 1, position: 'relative' }}
          onDrop={onDrop} onDragOver={onDragOver}
          onDragEnter={onDragEnter} onDragLeave={onDragLeave}
        >
          {/* 连线中点剪刀按钮：悬停连线时高亮显示 */}
          <style>{`
            .react-flow__edge .edge-del-btn { opacity: 0.25; }
            .react-flow__edge:hover .edge-del-btn {
              opacity: 1; color: rgb(var(--danger-6)); border-color: rgb(var(--danger-6));
            }
          `}</style>
          {/* 本地文件拖入悬停提示（pointerEvents none 不拦截拖拽事件） */}
          {fileDragging && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 1000, pointerEvents: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(22, 93, 255, 0.06)',
              border: '2px dashed rgb(var(--arcoblue-5))', borderRadius: 8,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--color-bg-1)', padding: '14px 24px', borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)', fontSize: 14, fontWeight: 600,
              }}>
                <IconUpload style={{ fontSize: 20, color: 'rgb(var(--arcoblue-6))' }} />
                松开鼠标上传素材（图片≤9 · 视频≤3 · 音频≤3）
              </div>
            </div>
          )}
          <CanvasRuntimeContext.Provider value={runtime}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            nodeTypes={canvasNodeTypes}
            edgeTypes={canvasEdgeTypes}
            fitView
            deleteKeyCode={['Delete', 'Backspace']}
            style={{ background: 'var(--color-fill-1)' }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            <Controls />
            <MiniMap
              nodeStrokeColor={(n) => NODE_REGISTRY[n.type as CanvasNodeType]?.color || '#999'}
              nodeColor={(n) => NODE_REGISTRY[n.type as CanvasNodeType]?.color || '#999'}
              style={{ background: 'var(--color-bg-2)' }}
            />
          </ReactFlow>
          </CanvasRuntimeContext.Provider>
        </div>
      </div>

      {/* 拖拽文件批量上传弹窗 */}
      <DropUploadModal
        visible={!!dropFiles}
        files={dropFiles || []}
        projectId={projectId || undefined}
        onClose={() => setDropFiles(null)}
        onFileUploaded={handleDropUploaded}
      />

      {/* 连线图例帮助弹窗 */}
      <Modal
        title="连线颜色图例与规则"
        visible={helpVisible}
        onCancel={() => setHelpVisible(false)}
        footer={null}
        style={{ width: 560 }}
      >
        <div style={{ fontSize: 13 }}>
          <Text style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>
            ① 句柄颜色 = 传输的数据类型（决定什么线能连什么口）
          </Text>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', marginBottom: 14 }}>
            {[
              ['#165DFF', 'text 文本', '提示词 / 文本流：提示词节点的输出 → 各生成节点的「提示词」输入'],
              ['#00B42A', 'ref 引用', '参考图引用：素材节点「引用」输出、融合节点的「参考图 1/2/3」输入'],
              ['#722ED1', 'image 图片', '图片流：素材/文生图/图生图节点输出 → 图生视频「图片」、图生图/视频生视频「参考图」'],
              ['#F53F3F', 'video 视频', '视频流：图生视频/首尾帧/视频生视频/对口型输出 → 输出节点、对口型「视频」'],
              ['#3491FA', 'audio 音频', '音频流：语音合成节点输出 → 对口型「音频」输入'],
            ].map(([c, name, desc]) => (
              <React.Fragment key={name}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                  <span style={{ width: 12, height: 12, borderRadius: '50%', background: c, display: 'inline-block' }} />
                  {name}
                </span>
                <Text type="secondary" style={{ fontSize: 12 }}>{desc}</Text>
              </React.Fragment>
            ))}
          </div>
          <Text style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>② 连线规则</Text>
          <ul style={{ margin: '0 0 14px 18px', padding: 0, color: 'var(--color-text-2)', fontSize: 12, lineHeight: 1.8 }}>
            <li>同色句柄可以直接相连（文本→文本、图→图…）</li>
            <li>例外：<b>紫色（image）可以连绿色（ref）</b> —— 生成出来的图可直接作为下游的参考图</li>
            <li>参考类输入（image / ref）支持<b>多上游聚合</b>：多个节点的图连到同一节点会按连线顺序全部作为参考</li>
            <li>首帧类输入取连线中<b>第一张</b>图作为首帧，其余自动转为附加参考</li>
          </ul>
          <Text style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>③ 节点边框颜色 = 节点功能分组</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            紫色系=生图（文生图/融合）、黄绿=图生图、红系=图生视频、品红=视频生视频、橙=首尾帧、青=对口型、蓝=语音合成、绿=素材、灰=输出。仅作视觉区分，不影响连线。
          </Text>
        </div>
      </Modal>

      {/* 底部状态栏 */}
      <div style={{
        padding: '4px 12px', background: 'var(--color-bg-1)', borderTop: '1px solid var(--color-border)',
        fontSize: 11, color: 'var(--color-text-3)', display: 'flex', gap: 16, flexShrink: 0,
      }}>
        <span>节点 {nodes.length}</span>
        <span>连线 {edges.length}</span>
        <span>提示：拖入节点 → 拖动右侧圆点连线 → 点节点右上角 ▶ 运行；本地图片/视频/音频可直接拖入画布批量上传</span>
      </div>
    </div>
  )
}

// ==================== 主组件（带 Provider） ====================
const CanvasEditor: React.FC = () => {
  const { currentCanvas } = useCanvasStore()
  // key 用 id+version 强制 CanvasEditMode 在画布变更时重新挂载，
  // 确保 useNodesState 用最新的 graph_data 初始化（避免 HMR/异步加载导致的初始值陈旧）
  return (
    <ReactFlowProvider>
      {currentCanvas
        ? <CanvasEditMode key={currentCanvas.id} canvas={currentCanvas} />
        : <CanvasListMode />}
    </ReactFlowProvider>
  )
}

const CanvasPage: React.FC = () => {
  return (
    <div className="canvas-page" style={{ height: '100%' }}>
      <CanvasEditor />
    </div>
  )
}

export default CanvasPage
