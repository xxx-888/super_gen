/**
 * CanvasDock - 画布底部中心组件坞（LibLib 风格）
 *
 * 悬浮胶囊工具条固定在画布底部中心：
 * - 收起态：大 "+" 按钮 + 分组快捷按钮（素材/生成/音频/输出）
 * - 展开态：向上弹出的节点面板——分组 Tab + 节点芯片网格
 *   · 芯片可拖拽到画布任意位置（HTML5 dataTransfer，与旧侧栏同协议）
 *   · 单击芯片 → 派发 canvas:add-node 事件在画布可视中心创建
 * - 再次点击当前分组 / ✕ / Esc 收起
 */
import React from 'react'
import {
  IconEdit, IconImage, IconVideoCamera, IconSound, IconShareExternal, IconUpload,
  IconPlus, IconClose,
} from '@arco-design/web-react/icon'
import { NODE_REGISTRY, PALETTE_GROUPS, type CanvasNodeType } from './types'

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

export const CanvasDock: React.FC = () => {
  const [open, setOpen] = React.useState(false)
  const [activeGroup, setActiveGroup] = React.useState(0)

  // Esc 收起
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const onDragStart = (e: React.DragEvent, nodeType: CanvasNodeType) => {
    e.dataTransfer.setData('application/canvas-node', nodeType)
    e.dataTransfer.effectAllowed = 'move'
  }

  const onChipClick = (nodeType: CanvasNodeType) => {
    window.dispatchEvent(new CustomEvent('canvas:add-node', { detail: { nodeType } }))
  }

  const selectGroup = (idx: number) => {
    if (open && activeGroup === idx) { setOpen(false); return }
    setActiveGroup(idx)
    setOpen(true)
  }

  const group = PALETTE_GROUPS[activeGroup]

  return (
    <div style={{
      position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      maxWidth: 'calc(100% - 32px)',
    }}>
      {/* ===== 展开的节点面板 ===== */}
      {open && (
        <div style={{
          background: 'var(--color-bg-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,.18)',
          backdropFilter: 'blur(12px)',
          padding: 12, width: 520, maxWidth: '90vw',
        }}>
          {/* 分组 Tab 行 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {PALETTE_GROUPS.map((g, idx) => (
              <button
                key={g.group}
                onClick={() => setActiveGroup(idx)}
                style={{
                  border: 'none', cursor: 'pointer', borderRadius: 999, padding: '4px 14px',
                  fontSize: 12, fontWeight: 500, transition: 'all .15s',
                  background: idx === activeGroup ? 'rgb(var(--arcoblue-1))' : 'transparent',
                  color: idx === activeGroup ? 'rgb(var(--arcoblue-6))' : 'var(--color-text-2)',
                }}
              >
                {g.group}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--color-text-3)', alignSelf: 'center' }}>
              拖拽到画布任意位置 · 单击添加到中心
            </span>
            <button
              onClick={() => setOpen(false)}
              title="收起 (Esc)"
              style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: 'var(--color-text-3)', display: 'flex', alignItems: 'center', padding: 4,
              }}
            >
              <IconClose style={{ fontSize: 14 }} />
            </button>
          </div>
          {/* 节点芯片网格 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {group.nodes.map((nt) => {
              const meta = NODE_REGISTRY[nt]
              return (
                <div
                  key={nt}
                  draggable
                  onDragStart={(e) => onDragStart(e, nt)}
                  onClick={() => onChipClick(nt)}
                  title={`${meta.description}（拖拽或单击添加）`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                    borderRadius: 10, cursor: 'grab', userSelect: 'none',
                    background: 'var(--color-fill-1)',
                    border: `1px solid ${meta.color}30`,
                    transition: 'transform .12s, box-shadow .12s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-2px)'
                    e.currentTarget.style.boxShadow = `0 6px 16px ${meta.color}30`
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'none'
                    e.currentTarget.style.boxShadow = 'none'
                  }}
                >
                  <span style={{ color: meta.color, display: 'flex', fontSize: 18 }}>{NODE_ICONS[nt]}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--color-text-1)', fontWeight: 500 }}>{meta.label}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ===== 底部胶囊工具条 ===== */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px',
        background: 'var(--color-bg-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 999, boxShadow: '0 8px 28px rgba(0,0,0,.16)',
        backdropFilter: 'blur(12px)',
      }}>
        {/* 大 + 按钮：开/收面板 */}
        <button
          onClick={() => setOpen(!open)}
          title={open ? '收起节点面板' : '添加节点'}
          style={{
            width: 36, height: 36, borderRadius: '50%', border: 'none', cursor: 'pointer',
            background: open ? 'var(--color-fill-2)' : 'rgb(var(--arcoblue-6))',
            color: open ? 'var(--color-text-1)' : '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'transform .2s', boxShadow: open ? 'none' : '0 4px 12px rgba(22,93,255,.4)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
        >
          <IconPlus style={{ fontSize: 18, transform: open ? 'rotate(45deg)' : 'none', transition: 'transform .2s' }} />
        </button>

        <div style={{ width: 1, height: 20, background: 'var(--color-border)', margin: '0 6px' }} />

        {/* 分组快捷按钮：直接跳到该分组并展开 */}
        {PALETTE_GROUPS.map((g, idx) => {
          const firstMeta = NODE_REGISTRY[g.nodes[0]]
          return (
            <button
              key={g.group}
              onClick={() => selectGroup(idx)}
              title={`添加${g.group}节点`}
              style={{
                border: 'none', cursor: 'pointer', borderRadius: 999, padding: '6px 14px',
                fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6,
                transition: 'all .15s',
                background: open && activeGroup === idx ? 'var(--color-fill-2)' : 'transparent',
                color: open && activeGroup === idx ? firstMeta.color : 'var(--color-text-2)',
              }}
            >
              <span style={{ color: firstMeta.color, display: 'flex', fontSize: 15 }}>{NODE_ICONS[g.nodes[0]]}</span>
              {g.group}
            </button>
          )
        })}
      </div>
    </div>
  )
}
