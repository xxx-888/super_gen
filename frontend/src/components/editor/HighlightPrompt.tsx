/**
 * HighlightPrompt - 只读提示词的 @引用彩色高亮展示
 *
 * 解析 @{type:uuid:name} 模板格式和 @Name 裸名称格式，
 * 已知资源名称渲染为对应类型颜色的彩色芯片，其余纯文本原样显示。
 *
 * 颜色（与 PromptEditorLite 的 TYPE_META 对齐）：
 *   character 紫 / scene_bg 绿 / prop 橙 / audio 灰
 */
import React, { useEffect, useMemo, useState } from 'react'
import { resourceService } from '@/api/services'

const TYPE_COLORS: Record<string, string> = {
  character: '#722ED1',
  scene_bg: '#00B42A',
  prop: '#FF7D00',
  audio: '#86909C',
  video: '#165DFF',
}

// 同时匹配 @{type:uuid:name} 模板和 @Name 裸名称
const MENTION_RE = /@\{(\w+):([a-f0-9-]{36})(?::([^}]+))?\}|@([\w一-龥]+)/g

interface HighlightPromptProps {
  prompt?: string
  /** 项目ID，用于加载资源做裸 @Name 名称→类型匹配 */
  projectId?: string
  /** 字体大小，默认跟随上下文 */
  fontSize?: number
  /** 是否单行截断（列表行用），默认 false */
  ellipsis?: boolean
  style?: React.CSSProperties
}

interface Segment {
  text: string
  type?: string  // 有 type = 高亮芯片；无 = 普通文本
}

const HighlightPrompt: React.FC<HighlightPromptProps> = ({
  prompt, projectId, fontSize, ellipsis = false, style,
}) => {
  const [nameToType, setNameToType] = useState<Record<string, string>>({})

  // 加载资源，建立 名称→类型 映射（用于裸 @Name 高亮）
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    ;(async () => {
      try {
        const [character, scene_bg, prop, audio, video] = await Promise.all([
          resourceService.characters.list(projectId),
          resourceService.sceneBg.list(projectId),
          resourceService.props.list(projectId),
          resourceService.audio.list(projectId),
          resourceService.video.list(projectId),
        ])
        if (cancelled) return
        const norm = (r: any) => Array.isArray(r) ? r : (r?.data ?? [])
        const map: Record<string, string> = {}
        for (const item of norm(character)) if (item.name) map[item.name] = 'character'
        for (const item of norm(scene_bg)) if (item.name) map[item.name] = 'scene_bg'
        for (const item of norm(prop)) if (item.name) map[item.name] = 'prop'
        for (const item of norm(audio)) if (item.name) map[item.name] = 'audio'
        for (const item of norm(video)) if (item.name) map[item.name] = 'video'
        setNameToType(map)
      } catch { /* 资源加载失败不高亮，不阻断 */ }
    })()
    return () => { cancelled = true }
  }, [projectId])

  // 把 prompt 解析为 segments（普通文本 + 高亮芯片）
  const segments = useMemo<Segment[]>(() => {
    if (!prompt) return []
    const result: Segment[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null
    MENTION_RE.lastIndex = 0
    while ((match = MENTION_RE.exec(prompt)) !== null) {
      // 前面的普通文本
      if (match.index > lastIndex) {
        result.push({ text: prompt.slice(lastIndex, match.index) })
      }
      if (match[1]) {
        // @{type:uuid:name} 模板格式
        const type = match[1]
        const name = match[3] || match[2]
        result.push({ text: `@${name}`, type })
      } else if (match[4]) {
        // @Name 裸名称格式
        const name = match[4]
        const type = nameToType[name]
        result.push({ text: `@${name}`, type })
      }
      lastIndex = MENTION_RE.lastIndex
    }
    // 尾部普通文本
    if (lastIndex < prompt.length) {
      result.push({ text: prompt.slice(lastIndex) })
    }
    return result
  }, [prompt, nameToType])

  if (!prompt) return null

  return (
    <span style={{
      fontSize,
      display: ellipsis ? 'block' : 'inline',
      overflow: ellipsis ? 'hidden' : undefined,
      textOverflow: ellipsis ? 'ellipsis' : undefined,
      whiteSpace: ellipsis ? 'nowrap' : undefined,
      ...style,
    }}>
      {segments.map((seg, i) => {
        if (seg.type) {
          const color = TYPE_COLORS[seg.type] || '#86909C'
          return (
            <span key={i} style={{
              color,
              fontWeight: 600,
              backgroundColor: `${color}15`,
              borderRadius: 3,
              padding: '0 2px',
            }}>
              {seg.text}
            </span>
          )
        }
        return <span key={i}>{seg.text}</span>
      })}
    </span>
  )
}

export default HighlightPrompt
