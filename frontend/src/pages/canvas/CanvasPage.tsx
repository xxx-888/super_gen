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
  addEdge, useNodesState, useEdgesState, type Connection, type Node, type Edge,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Card, Typography, Button, Space, Select, Message, Empty, Spin, Modal,
  Input, Tag, Tooltip,
} from '@arco-design/web-react'
import {
  IconPlus, IconDelete, IconRefresh, IconSave, IconBackward, IconCopy,
  IconApps,
} from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { projectService, canvasService, CanvasData } from '@/api/services'
import { useCanvasStore, useTeamStore } from '@/stores'
import { NodePalette } from '@/components/canvas/NodePalette'
import { canvasNodeTypes } from '@/components/canvas/nodes'
import { NODE_REGISTRY, isValidConnection, type CanvasNodeType } from '@/components/canvas/types'
import { useNodeExecution } from '@/hooks/useNodeExecution'
import { CanvasRuntimeContext, type CanvasRuntime } from '@/components/canvas/CanvasContext'

const { Title, Text } = Typography

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

  // 加载项目列表（按当前团队过滤）
  useEffect(() => {
    (async () => {
      try {
        const data: any = await projectService.list({ org_id: currentOrg?.id })
        const list = Array.isArray(data) ? data : (data?.data ?? [])
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
      {/* 项目选择 + 新建 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Text style={{ color: 'var(--color-text-2)' }}>项目：</Text>
        <Select
          style={{ width: 260 }}
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
        <Button type="primary" icon={<IconPlus />} onClick={() => {
          if (!selectedProjectId) { Message.warning('请先选择项目'); return }
          setNewVisible(true)
        }}>新建画布</Button>
        <Button icon={<IconRefresh />} onClick={() => selectedProjectId && loadCanvases(selectedProjectId)}>刷新</Button>
      </div>

      {/* 画布网格 */}
      {loading ? (
        <Spin dot style={{ display: 'block', margin: '60px auto' }} />
      ) : canvases.length === 0 ? (
        <Empty
          description={selectedProjectId ? '该项目还没有画布，点击「新建画布」开始创作' : '请先选择项目'}
          style={{ padding: 60 }}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {canvases.map((c: any) => {
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
                    <Space size="small" style={{ fontSize: 12 }}>
                      <Tag size="small" color="arcoblue">{nodeCount} 节点</Tag>
                      <Tag size="small">{edgeCount} 连线</Tag>
                      <Text type="secondary" style={{ fontSize: 11 }}>v{c.version}</Text>
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

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(
    (canvas.graph_data?.nodes as Node[]) || []
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    (canvas.graph_data?.edges as Edge[]) || []
  )
  const [editingName, setEditingName] = React.useState(false)
  const [name, setName] = React.useState(canvas.name)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
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
    setNodes((nds) => nds.filter((n) => n.id !== nodeId))
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
    scheduleAutoSave()
  }, [setNodes, setEdges, scheduleAutoSave])

  // 传递给节点的运行时上下文。用 useMemo 保持引用稳定。
  const runtime: CanvasRuntime = useMemo(() => ({
    projectId: projectId || undefined,
    runNode,
    updateNodeData,
    deleteNode,
  }), [projectId, runNode, updateNodeData, deleteNode])

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
    scheduleAutoSave()
  }, [setEdges, scheduleAutoSave])

  // 拖拽创建节点
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
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
        <Button icon={<IconSave />} type="primary" onClick={handleManualSave} loading={saving}>保存</Button>
      </div>

      {/* 画布主体 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <NodePalette />
        <div style={{ flex: 1, position: 'relative' }} onDrop={onDrop} onDragOver={onDragOver}>
          <CanvasRuntimeContext.Provider value={runtime}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            nodeTypes={canvasNodeTypes}
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

      {/* 底部状态栏 */}
      <div style={{
        padding: '4px 12px', background: 'var(--color-bg-1)', borderTop: '1px solid var(--color-border)',
        fontSize: 11, color: 'var(--color-text-3)', display: 'flex', gap: 16, flexShrink: 0,
      }}>
        <span>节点 {nodes.length}</span>
        <span>连线 {edges.length}</span>
        <span>提示：拖入节点 → 拖动右侧圆点连线 → 点节点右上角 ▶ 运行</span>
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
