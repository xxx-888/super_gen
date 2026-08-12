/**
 * BaseNodeShell - 画布节点的公共外壳
 *
 * 统一结构：标题栏（图标 + 名称 + 状态灯）+ 内容区 + 句柄（输入/输出连接点）
 * 参照 liblib.tv 画布节点的视觉风格：圆角卡片、彩色左边框、状态指示灯。
 */
import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeRunStatus, HandleType } from './types'

// 句柄颜色映射（按数据类型）
const HANDLE_COLOR: Record<HandleType, string> = {
  text: '#165DFF',
  image: '#722ED1',
  video: '#F53F3F',
  audio: '#3491FA',
  ref: '#00B42A',
}

// 状态灯样式
const STATUS_INDICATOR: Record<NodeRunStatus, { color: string; label: string }> = {
  idle: { color: 'var(--color-fill-3)', label: '' },
  running: { color: 'rgb(var(--arcoblue-6))', label: '运行中' },
  completed: { color: 'rgb(var(--success-6))', label: '完成' },
  failed: { color: 'rgb(var(--danger-6))', label: '失败' },
}

export interface BaseNodeShellProps {
  /** 节点类型显示名（如"文生图"） */
  label: string
  /** 主题色（左边框 + 图标背景） */
  color: string
  /** 图标元素（React node） */
  icon?: React.ReactNode
  /** 运行状态 */
  status?: NodeRunStatus
  /** 是否选中 */
  selected?: boolean
  /** 输入句柄列表 */
  inputs?: { id: string; type: HandleType; label?: string }[]
  /** 输出句柄列表 */
  outputs?: { id: string; type: HandleType; label?: string }[]
  /** 右上角额外操作（如运行按钮） */
  actions?: React.ReactNode
  /** 删除节点回调（提供则显示删除按钮） */
  onDelete?: () => void
  /** 节点内容 */
  children?: React.ReactNode
}

export const BaseNodeShell: React.FC<BaseNodeShellProps> = ({
  label,
  color,
  icon,
  status = 'idle',
  selected = false,
  inputs = [],
  outputs = [],
  actions,
  onDelete,
  children,
}) => {
  const st = STATUS_INDICATOR[status]
  const maxHandles = Math.max(inputs.length, outputs.length, 1)
  // 节点最小高度：每个句柄约 28px + 标题 + 内容
  const contentMinHeight = children ? undefined : Math.max(60, maxHandles * 28)

  return (
    <div
      className="canvas-node-shell"
      style={{
        background: 'var(--color-bg-1)',
        // 用拆分属性避免 border(简写) 与 borderLeft 冲突的 React 警告
        borderTop: `1px solid ${selected ? color : 'var(--color-border)'}`,
        borderRight: `1px solid ${selected ? color : 'var(--color-border)'}`,
        borderBottom: `1px solid ${selected ? color : 'var(--color-border)'}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        boxShadow: selected
          ? `0 0 0 2px ${color}33, 0 4px 12px rgba(0,0,0,0.08)`
          : '0 2px 8px rgba(0,0,0,0.06)',
        width: 260,
        fontSize: 12,
        overflow: 'hidden',
        transition: 'box-shadow 0.15s, border-color 0.15s',
      }}
    >
      {/* 输入句柄（左侧） */}
      {inputs.map((h, i) => {
        const top = 36 + i * 24 + 12
        return (
          <Handle
            key={h.id}
            id={`${h.id}-in`}
            type="target"
            position={Position.Left}
            isConnectable
            style={{
              top,
              background: HANDLE_COLOR[h.type],
              border: '2px solid var(--color-bg-1)',
              width: 10,
              height: 10,
            }}
            title={h.label || h.type}
          />
        )
      })}

      {/* 输出句柄（右侧） */}
      {outputs.map((h, i) => {
        const top = 36 + i * 24 + 12
        return (
          <Handle
            key={h.id}
            id={`${h.id}-out`}
            type="source"
            position={Position.Right}
            isConnectable
            style={{
              top,
              background: HANDLE_COLOR[h.type],
              border: '2px solid var(--color-bg-1)',
              width: 10,
              height: 10,
            }}
            title={h.label || h.type}
          />
        )
      })}

      {/* 标题栏 */}
      <div
        className="canvas-node-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid var(--color-fill-2)',
          background: `${color}0D`, // 5% 透明度
        }}
      >
        {icon && (
          <span className="canvas-node-icon" style={{ color, display: 'flex', alignItems: 'center' }}>
            {icon}
          </span>
        )}
        <span
          className="canvas-node-label"
          style={{ fontWeight: 600, color: 'var(--color-text-1)', flex: 1, fontSize: 13 }}
        >
          {label}
        </span>
        {/* 状态灯 */}
        <span
          className={`canvas-node-status ${status === 'running' ? 'status-running' : ''}`}
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: st.color,
            flexShrink: 0,
          }}
          title={st.label}
        />
        {actions}
        {/* 删除按钮 */}
        {onDelete && (
          <span
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            style={{
              cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center',
              color: 'var(--color-text-4)', marginLeft: 2,
              width: 18, height: 18, borderRadius: 4,
              transition: 'color 0.15s, background 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'rgb(var(--danger-6))'; e.currentTarget.style.background = 'rgb(var(--danger-1))' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-4)'; e.currentTarget.style.background = 'transparent' }}
            title="删除节点"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
        )}
      </div>

      {/* 内容区：加 nodrag class 让 React Flow 不拦截此区域的鼠标事件，
          这样提示词编辑器、Select、Switch 等控件都能正常交互 */}
      <div
        className="canvas-node-body nodrag"
        style={{ padding: children ? 8 : 4, minHeight: contentMinHeight }}
      >
        {children}
      </div>
    </div>
  )
}
