/**
 * NodePalette - 节点拖拽侧栏
 *
 * 左侧节点面板，按功能分组。用户拖拽节点到画布即可创建。
 * 使用 HTML5 拖拽 API：onDragStart 设置 dataTransfer，画布 onDrop 读取并创建节点。
 */
import React from 'react'
import {
  IconEdit, IconImage, IconVideoCamera, IconSound, IconShareExternal, IconUpload,
} from '@arco-design/web-react/icon'
import { NODE_REGISTRY, PALETTE_GROUPS, type CanvasNodeType } from './types'

// 节点类型 → 图标组件 映射
const NODE_ICONS: Record<CanvasNodeType, React.ReactNode> = {
  prompt: <IconEdit />,
  material: <IconImage />,
  uploadMaterial: <IconUpload />,
  imageGen: <IconImage />,
  imageToImage: <IconImage />,
  fusionGen: <IconImage />,
  videoGen: <IconVideoCamera />,
  videoToVideo: <IconVideoCamera />,
  firstLastFrame: <IconVideoCamera />,
  lipSync: <IconSound />,
  tts: <IconSound />,
  output: <IconShareExternal />,
}

export const NodePalette: React.FC = () => {
  const onDragStart = (e: React.DragEvent, nodeType: CanvasNodeType) => {
    e.dataTransfer.setData('application/canvas-node', nodeType)
    e.dataTransfer.effectAllowed = 'move'
  }

  // 双击快捷创建（在画布中心位置）
  const onDoubleClick = (nodeType: CanvasNodeType) => {
    // 派发自定义事件，由画布监听并创建节点
    window.dispatchEvent(new CustomEvent('canvas:add-node', { detail: { nodeType } }))
  }

  return (
    <div
      className="node-palette"
      style={{
        width: 180,
        height: '100%',
        background: 'var(--color-bg-1)',
        borderRight: '1px solid var(--color-border)',
        overflow: 'auto',
        padding: '8px 0',
        flexShrink: 0,
      }}
    >
      <div style={{ padding: '0 12px 8px', fontSize: 12, color: 'var(--color-text-3)', fontWeight: 600 }}>
        节点
      </div>
      {PALETTE_GROUPS.map((group) => (
        <div key={group.group} style={{ marginBottom: 8 }}>
          <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--color-text-3)', textTransform: 'uppercase' }}>
            {group.group}
          </div>
          {group.nodes.map((nt) => {
            const meta = NODE_REGISTRY[nt]
            return (
              <div
                key={nt}
                draggable
                onDragStart={(e) => onDragStart(e, nt)}
                onDoubleClick={() => onDoubleClick(nt)}
                title={`${meta.description}（拖入或双击）`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  margin: '2px 8px',
                  borderRadius: 6,
                  cursor: 'grab',
                  border: '1px solid transparent',
                  background: 'transparent',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-fill-2)'
                  e.currentTarget.style.borderColor = `${meta.color}40`
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.borderColor = 'transparent'
                }}
              >
                <span style={{ color: meta.color, display: 'flex', alignItems: 'center', fontSize: 16 }}>
                  {NODE_ICONS[nt]}
                </span>
                <span style={{ fontSize: 12, color: 'var(--color-text-1)' }}>{meta.label}</span>
              </div>
            )
          })}
        </div>
      ))}
      <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--color-text-3)', lineHeight: 1.6 }}>
        💡 拖入画布或双击添加节点，
        <br />拖动节点右侧圆点可连线。
      </div>
    </div>
  )
}
