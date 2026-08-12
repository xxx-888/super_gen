/**
 * 画布面板 - 类型定义与节点注册表
 *
 * 节点类型与现有 creationService API 对齐：
 * - PromptNode        → 提示词文本（输出 text）
 * - MaterialNode      → 角色/场景/道具素材（输出 image, ref）
 * - ImageGenNode      → 文生图（creationService.fusion）
 * - FusionGenNode     → 融合生成（多参考图+提示词 → 图片，creationService.fusion）
 * - VideoGenNode      → 图生视频（creationService.imageToVideo）
 * - FirstLastFrameNode → 首尾帧生视频（creationService.firstLastFrame）
 * - LipSyncNode       → 对口型（creationService.lipSync）
 * - TTSNode           → 语音合成（creationService.tts）
 * - OutputNode        → 最终输出/发布
 */
import type { Node, Edge } from '@xyflow/react'

// ==================== 节点类型枚举 ====================
export type CanvasNodeType =
  | 'prompt'
  | 'material'
  | 'imageGen'
  | 'fusionGen'
  | 'videoGen'
  | 'firstLastFrame'
  | 'lipSync'
  | 'tts'
  | 'output'

// ==================== 句柄数据类型（连线匹配用） ====================
// 输出/输入句柄的类型必须匹配才能连线
export type HandleType = 'text' | 'image' | 'video' | 'audio' | 'ref'

// ==================== 节点运行状态 ====================
export type NodeRunStatus = 'idle' | 'running' | 'completed' | 'failed'

// ==================== 节点 data 结构（存入 graph_data） ====================
export interface BaseNodeData {
  // 节点参数（每种节点不同，用 Record 兼容）
  [key: string]: any
  // 运行时状态（不持久化，每次打开画布重置）
  _status?: NodeRunStatus
  _taskId?: string
  _result?: string[]          // 产出 URL 列表
  _errorMessage?: string
  _updatedAt?: number
}

// React Flow 节点类型（data 用 BaseNodeData）
export type CanvasNode = Node<BaseNodeData>
export type CanvasEdge = Edge

// ==================== 节点元信息注册表 ====================
export interface NodeMeta {
  type: CanvasNodeType
  label: string           // 显示名
  icon: string            // Arco icon 组件名（运行时映射）
  color: string           // 主题色（CSS color）
  description: string
  inputs: { id: string; type: HandleType; label: string }[]
  outputs: { id: string; type: HandleType; label: string }[]
  /** 默认参数（新建节点时填充到 data） */
  defaultData: Record<string, any>
}

export const NODE_REGISTRY: Record<CanvasNodeType, NodeMeta> = {
  prompt: {
    type: 'prompt',
    label: '提示词',
    icon: 'IconEdit',
    color: '#165DFF',
    description: '输入画面描述，支持 @引用角色/场景/道具',
    inputs: [],
    outputs: [{ id: 'text', type: 'text', label: '文本' }],
    defaultData: { text: '' },
  },
  material: {
    type: 'material',
    label: '素材',
    icon: 'IconImage',
    color: '#00B42A',
    description: '从素材库选择角色/场景/道具',
    inputs: [],
    outputs: [
      { id: 'image', type: 'image', label: '图片' },
      { id: 'ref', type: 'ref', label: '引用' },
    ],
    defaultData: { classType: 'character', name: '', image_url: '', resource_id: '' },
  },
  imageGen: {
    type: 'imageGen',
    label: '文生图',
    icon: 'IconImage',
    color: '#722ED1',
    description: '根据提示词生成图片',
    inputs: [
      { id: 'text', type: 'text', label: '提示词' },
      { id: 'refs', type: 'ref', label: '元素引用' },
    ],
    outputs: [{ id: 'image', type: 'image', label: '图片' }],
    defaultData: { model: '', size: '16:9', count: 1, quality: 'hd', watermark: false },
  },
  fusionGen: {
    type: 'fusionGen',
    label: '融合生成',
    icon: 'IconImage',
    color: '#722ED1',
    description: '多个参考图+提示词融合生成图片',
    inputs: [
      { id: 'text', type: 'text', label: '提示词' },
      { id: 'ref1', type: 'ref', label: '参考图1' },
      { id: 'ref2', type: 'ref', label: '参考图2' },
      { id: 'ref3', type: 'ref', label: '参考图3' },
    ],
    outputs: [{ id: 'image', type: 'image', label: '图片' }],
    defaultData: { model: '', size: '16:9', count: 1, quality: 'hd', watermark: false },
  },
  videoGen: {
    type: 'videoGen',
    label: '图生视频',
    icon: 'IconVideoCamera',
    color: '#F53F3F',
    description: '根据图片生成视频',
    inputs: [
      { id: 'image', type: 'image', label: '图片' },
      { id: 'text', type: 'text', label: '提示词' },
    ],
    outputs: [{ id: 'video', type: 'video', label: '视频' }],
    defaultData: {
      model: '', duration: 5, resolution: '720p', size: '16:9',
      quality: 'hd', watermark: false,
    },
  },
  firstLastFrame: {
    type: 'firstLastFrame',
    label: '首尾帧生视频',
    icon: 'IconVideoCamera',
    color: '#F77234',
    description: '用首帧和尾帧生成视频',
    inputs: [
      { id: 'first_frame', type: 'image', label: '首帧' },
      { id: 'last_frame', type: 'image', label: '尾帧' },
      { id: 'text', type: 'text', label: '提示词' },
    ],
    outputs: [{ id: 'video', type: 'video', label: '视频' }],
    defaultData: {
      model: '', duration: 5, resolution: '720p', size: '16:9',
      quality: 'hd', watermark: false,
    },
  },
  lipSync: {
    type: 'lipSync',
    label: '对口型',
    icon: 'IconSound',
    color: '#0FC6C2',
    description: '视频对口型合成',
    inputs: [
      { id: 'video', type: 'video', label: '视频' },
      { id: 'audio', type: 'audio', label: '音频' },
    ],
    outputs: [{ id: 'video', type: 'video', label: '视频' }],
    defaultData: { model: '' },
  },
  tts: {
    type: 'tts',
    label: '语音合成',
    icon: 'IconSound',
    color: '#3491FA',
    description: '文字转语音',
    inputs: [{ id: 'text', type: 'text', label: '文本' }],
    outputs: [{ id: 'audio', type: 'audio', label: '音频' }],
    defaultData: { model: '', voice_id: '', text: '' },
  },
  output: {
    type: 'output',
    label: '输出',
    icon: 'IconShareExternal',
    color: '#86909C',
    description: '最终视频输出/发布',
    inputs: [{ id: 'video', type: 'video', label: '视频' }],
    outputs: [],
    defaultData: { published: false },
  },
}

/** 拖拽侧栏的节点分组（按功能聚合，方便查找）
 * 注：prompt 和 material 节点已移除——提示词编辑器已集成到各生成节点内，
 * 素材引用通过提示词编辑器的 @引用 实现。已有画布上的旧节点仍能正常渲染。 */
export const PALETTE_GROUPS: { group: string; nodes: CanvasNodeType[] }[] = [
  { group: '生成', nodes: ['imageGen', 'fusionGen', 'videoGen', 'firstLastFrame'] },
  { group: '音频', nodes: ['tts', 'lipSync'] },
  { group: '输出', nodes: ['output'] },
]

/** 判断连线是否合法：输出句柄类型必须与输入句柄类型一致 */
export function isValidConnection(connection: {
  sourceHandle?: string | null
  targetHandle?: string | null
  source?: string | null
  target?: string | null
}): boolean {
  // 同节点不可自连
  if (connection.source && connection.target && connection.source === connection.target) return false
  // 句柄 id 已经编码了类型信息（如 "image-out"、"text-in"）
  // 简化校验：解析 handle id 前缀
  const srcType = connection.sourceHandle?.split('-')[0]
  const tgtType = connection.targetHandle?.split('-')[0]
  return !!srcType && srcType === tgtType
}
