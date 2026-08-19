/**
 * LinkedMaterialChips - 生成节点上「已连线参考素材」提示条
 *
 * 实时（React Flow edges/nodes）列出连入本节点的素材库/上传素材节点，
 * 按提示词编辑器同款 @名称 彩色芯片展示（颜色与 HighlightPrompt/PromptEditorLite 对齐）。
 * 运行时会以 @名称 自动注入提示词（后端展开为 [角色:名] 并并入参考媒体），
 * 无需在提示词里手动 @ 一遍。★ 标记首条素材连线（主参考）。
 */
import React from 'react'
import { useEdges, useNodes } from '@xyflow/react'
import { NODE_REGISTRY } from '../types'

interface LinkedItem {
  name: string
  /** 资源类型（character/scene_bg/prop/audio/video），配色用 */
  rtype?: string
  /** 主参考（首条素材连线） */
  primary: boolean
}

// 与 HighlightPrompt 的 TYPE_COLORS 对齐
const TYPE_COLORS: Record<string, string> = {
  character: '#722ED1',
  scene_bg: '#00B42A',
  prop: '#FF7D00',
  audio: '#86909C',
  video: '#165DFF',
}

export const LinkedMaterialChips: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const edges = useEdges()
  const nodes = useNodes()

  const items = React.useMemo<LinkedItem[]>(() => {
    const out: LinkedItem[] = []
    const push = (item: Omit<LinkedItem, 'primary'>) => {
      out.push({ ...item, primary: out.length === 0 })
    }
    for (const e of edges.filter((x) => x.target === nodeId)) {
      const src = nodes.find((n) => n.id === e.source)
      if (!src) continue
      const d: any = src.data
      if (src.type === 'material' && d.name) {
        push({ name: d.name, rtype: d.classType || 'character' })
        continue
      }
      if (src.type === 'uploadMaterial') {
        const f = d.files?.[d.mediaType]
        if (f?.url) {
          const rtype = d.mediaType === 'image' ? (f.imageClass || 'character') : d.mediaType
          push({ name: f.name || '未命名素材', rtype })
        }
        continue
      }
      // 生成节点产出（提示词文本连线不算参考素材）：已入库显示素材名芯片，
      // 未入库显示自动别名（连线仍可 @引用，媒体按连线传输）
      if (e.sourceHandle?.startsWith('text')) continue
      if (d._result?.length) {
        if (d.savedMaterial?.name) {
          push({ name: d.savedMaterial.name, rtype: d.savedMaterial.imageClass })
        } else {
          const label = NODE_REGISTRY[src.type as keyof typeof NODE_REGISTRY]?.label || '上游'
          push({ name: d.refAlias || `${label}产出` })
        }
      }
    }
    return out
  }, [edges, nodes])

  if (!items.length) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
        {items.map((it, i) => {
          const color = TYPE_COLORS[it.rtype || ''] || '#86909C'
          return (
            <span key={i} style={{
              color, fontWeight: 600, fontSize: 11, lineHeight: '18px',
              backgroundColor: `${color}15`, borderRadius: 3, padding: '0 4px',
              border: it.primary ? `1px solid ${color}55` : '1px solid transparent',
            }}>
              {it.primary ? '★' : ''}@{it.name}
            </span>
          )
        })}
      </div>
      <span style={{ fontSize: 10, color: 'var(--color-text-3)' }}>
        ★首条连线为主参考；@引用已自动写入下方提示词（可编辑），断线自动移除
      </span>
    </div>
  )
}

export default LinkedMaterialChips
