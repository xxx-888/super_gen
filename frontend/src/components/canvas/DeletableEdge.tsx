/**
 * DeletableEdge - 可视化删除连线
 *
 * 在连线中点放一个 ✂ 按钮：悬停连线时完全显示，点击即断开
 * （联动移除下游提示词里的自动 @引用）。替代「选中线 + 退格键」的隐式操作。
 * 同时注册为 default 类型，历史画布的旧连线同样生效。
 */
import React from 'react'
import {
  BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps,
} from '@xyflow/react'
import { useCanvasRuntime } from './CanvasContext'

export const DeletableEdge: React.FC<EdgeProps> = ({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  markerEnd, style,
}) => {
  const { deleteEdge } = useCanvasRuntime()
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  })

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <button
          className="nodrag nopan edge-del-btn"
          title="断开连线"
          onClick={(e) => {
            e.stopPropagation()
            deleteEdge(id)
          }}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            width: 18,
            height: 18,
            borderRadius: '50%',
            border: '1px solid var(--color-border-2)',
            background: 'var(--color-bg-1)',
            color: 'var(--color-text-3)',
            fontSize: 10,
            lineHeight: 1,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            transition: 'opacity 0.15s, color 0.15s, border-color 0.15s',
          }}
        >
          ✂
        </button>
      </EdgeLabelRenderer>
    </>
  )
}

export default DeletableEdge
