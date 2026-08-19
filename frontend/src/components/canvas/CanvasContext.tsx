/**
 * CanvasContext - 画布节点运行时上下文
 *
 * 用 React Context 把 runNode / projectId 传给所有节点组件，
 * 避免用 useEffect 注入 _run 到 node.data（那会导致无限循环：
 * runNode 引用变 → effect 触发 setNodes → nodes 变 → 重渲染 → runNode 又变...）。
 */
import React from 'react'

export interface CanvasRuntime {
  /** 当前项目 ID（用于素材加载、API 调用） */
  projectId?: string
  /** 执行单个节点（收集上游 → 调 API → 轮询 → 回填） */
  runNode: (nodeId: string) => void
  /** 更新节点 data（用于节点内编辑回写参数） */
  updateNodeData: (nodeId: string, patch: Record<string, any>) => void
  /** 删除节点（同时删除关联的连线） */
  deleteNode: (nodeId: string) => void
  /** 删除连线（联动移除下游提示词里的自动 @引用） */
  deleteEdge: (edgeId: string) => void
}

export const CanvasRuntimeContext = React.createContext<CanvasRuntime>({
  projectId: undefined,
  runNode: () => {},
  updateNodeData: () => {},
  deleteNode: () => {},
  deleteEdge: () => {},
})

export const useCanvasRuntime = () => React.useContext(CanvasRuntimeContext)
