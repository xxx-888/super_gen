/**
 * PromptEditorLite - 轻量版提示词编辑器（支持 @引用）
 *
 * 与 PromptEditor（Tiptap 富文本版）的区别：
 * - 纯受控组件（value/onChange），不依赖全局 store
 * - 不强制绑定 sceneId，可用于"新建分镜""快速编辑"等无 scene 的场景
 * - 用原生 TextArea + @引用补全，零额外依赖
 *
 * 输入 @ 弹出角色/场景/道具/音效候选，选择后插入 @{type:uuid}，
 * 后端 prompt_builder 会展开这些引用为完整描述。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Input, Empty, Tag } from '@arco-design/web-react'
import { resourceService } from '@/api/services'

// @引用类型元信息（与后端 prompt_builder 的 type 对齐）
const TYPE_META: Record<string, { label: string; color: string }> = {
  character: { label: '角色', color: '#722ED1' },
  scene_bg: { label: '场景', color: '#00B42A' },
  prop: { label: '道具', color: '#FF7D00' },
  audio: { label: '音效', color: '#86909C' },
}

// 高亮层与编辑层（透明 textarea）共享的排版参数。
// 关键：两层必须逐字符同宽，否则光标与可见文字会错位、且越靠后错位越严重。
// 1) 必须显式指定【同一套】字体栈——裸 'monospace' 在 <div> 和 <textarea> 里可能被
//    解析成不同字体文件（textarea 是老的替换元素，字体继承行为不一致），ASCII 也会错位。
// 2) chip 不能用 600/500 的 font-weight：很多 monospace 字体没有真正的粗体，浏览器会
//    做 synthetic bold（描边合成），这会改变字符 advance 宽度，导致 chip 后整体偏移。
//    所以 chip 必须和正文一样用 400。
const FONT_STACK =
  'Consolas, "Courier New", "DejaVu Sans Mono", "Liberation Mono", Menlo, monospace'
const FONT_SIZE = 14
const LINE_HEIGHT = 1.8
const LETTER_SPACING = 0

export interface PromptEditorLiteProps {
  value?: string
  onChange?: (val: string) => void
  placeholder?: string
  minHeight?: number
  /** 项目ID，用于加载该项目的角色/场景/道具/音效资源 */
  projectId?: string
  /** 是否自动加载项目资源（默认 true） */
  autoLoad?: boolean
  maxLength?: number
}

const PromptEditorLite: React.FC<PromptEditorLiteProps> = ({
  value = '', onChange, placeholder, minHeight = 120, projectId, autoLoad = true, maxLength,
}) => {
  const textareaRef = useRef<any>(null)

  const [resources, setResources] = useState<Record<string, any[]>>({
    character: [], scene_bg: [], prop: [], audio: [],
  })
  const [resourcesLoaded, setResourcesLoaded] = useState(false)

  // @ 引用补全状态
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionEnd, setMentionEnd] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)

  useEffect(() => {
    if (!autoLoad || !projectId) { setResourcesLoaded(true); return }
    let cancelled = false
    ;(async () => {
      try {
        const [character, scene_bg, prop, audio] = await Promise.all([
          resourceService.characters.list(projectId),
          resourceService.sceneBg.list(projectId),
          resourceService.props.list(projectId),
          resourceService.audio.list(projectId),
        ])
        if (cancelled) return
        const norm = (r: any) => Array.isArray(r) ? r : (r?.data ?? [])
        setResources({
          character: norm(character),
          scene_bg: norm(scene_bg),
          prop: norm(prop),
          audio: norm(audio),
        })
      } catch { /* 资源加载失败不阻断编辑 */ } finally {
        if (!cancelled) setResourcesLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [projectId, autoLoad])

  // 所有候选（扁平化 + 过滤）
  const suggestions = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.trim().toLowerCase()
    const list: any[] = []
    for (const type of Object.keys(resources)) {
      for (const item of resources[type]) {
        const name = item.name || ''
        if (!q || name.toLowerCase().includes(q)) {
          list.push({ type, id: item.id, name })
        }
      }
    }
    return list.slice(0, 50)
  }, [mentionQuery, resources])

  // 解析当前文本里的 @引用，用于彩色预览条展示
  const referencedItems = useMemo(() => {
    if (!value) return []
    const found: Array<{ name: string; type: string }> = []
    // 匹配 @中文名称（与插入格式一致）
    const matches = value.matchAll(/@([\w一-龥]+)/g)
    const nameToType: Record<string, string> = {}
    for (const type of Object.keys(resources)) {
      for (const item of resources[type]) {
        if (item.name) nameToType[item.name] = type
      }
    }
    const seen = new Set<string>()
    for (const m of matches) {
      const name = m[1]
      if (nameToType[name] && !seen.has(name)) {
        seen.add(name)
        found.push({ name, type: nameToType[name] })
      }
    }
    return found
  }, [value, resources])

  // 名称 → 类型的映射（供高亮渲染用）
  const nameToTypeMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const type of Object.keys(resources)) {
      for (const item of resources[type]) {
        if (item.name) m[item.name] = type
      }
    }
    return m
  }, [resources])

  // 把文本转成带彩色 @引用 的 HTML（用于底层高亮层）
  const highlightedHtml = useMemo(() => {
    if (!value) return ''
    // 转义 HTML 特殊字符
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 用正则切分：@名称（中英文）和普通文本
    const parts: string[] = []
    const regex = /@([\w一-龥]+)/g
    let lastIdx = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(value)) !== null) {
      // 普通文本段
      if (m.index > lastIdx) parts.push(esc(value.slice(lastIdx, m.index)))
      const name = m[1]
      const type = nameToTypeMap[name]
      const meta = type ? TYPE_META[type] : null
      if (meta) {
        // 彩色高亮：背景色 + 文字色
        // 注意：不能加 padding / 不能改水平几何 / 不能改 font-weight。
        // 高亮层叠在透明 textarea 之上，二者必须逐字符同宽才能让光标与可见文字对齐：
        //  - padding 会让 chip 比纯文本宽；
        //  - font-weight 改变会触发 synthetic bold，改变字符 advance；
        //  任何一项都会让 chip 之后输入的文字整体错位（需要多打空格对齐）。
        parts.push(
          `<span style="background:${meta.color}20;color:${meta.color};">@${esc(name)}</span>`
        )
      } else {
        // 未匹配到资源的 @名称，用默认色（同样不加 font-weight，避免与正文不同宽）
        parts.push(
          `<span style="color:rgb(var(--primary-6));">@${esc(name)}</span>`
        )
      }
      lastIdx = m.index + m[0].length
    }
    // 尾部普通文本
    if (lastIdx < value.length) parts.push(esc(value.slice(lastIdx)))
    // 末尾加一个空格和换行占位（保证 textarea 自动高度时高亮层同步）
    return parts.join('') + '\n'
  }, [value, nameToTypeMap])

  // 检测 @ 引用
  const detectMention = (text: string, pos: number) => {
    const before = text.slice(0, pos)
    const match = before.match(/(^|\s)@([\w一-龥]*)$/)
    if (match) {
      const start = match.index! + (match[1] ? match[1].length : 0)
      setMentionStart(start)
      setMentionEnd(pos)
      setMentionQuery(match[2])
      setMentionIndex(0)
    } else {
      setMentionQuery(null)
      setMentionStart(null)
      setMentionEnd(null)
    }
  }

  const handleChange = (val: string, e?: any) => {
    onChange?.(val)
    const pos = e?.target?.selectionStart ?? val.length
    detectMention(val, pos)
  }

  const insertMention = (item: any) => {
    if (mentionStart === null || mentionEnd === null || !onChange) return
    // 插入 @中文名称（用户可读），后端 prompt_builder 会按名称解析展开
    const insert = `@${item.name} `
    const next = value.slice(0, mentionStart) + insert + value.slice(mentionEnd)
    onChange(next)
    const caret = mentionStart + insert.length
    setMentionQuery(null)
    setMentionStart(null)
    setMentionEnd(null)
    // 恢复光标
    requestAnimationFrame(() => {
      const dom = textareaRef.current?.dom || textareaRef.current?.textareaRef?.current
      if (dom) {
        dom.focus()
        dom.setSelectionRange(caret, caret)
      }
    })
  }

  const handleKeyDown = (e: any) => {
    if (mentionQuery === null || suggestions.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      // 必须同时 preventDefault + stopPropagation 才能阻止 TextArea 的光标移动/换行
      e.preventDefault()
      e.stopPropagation()
      if (e.nativeEvent) e.nativeEvent.stopImmediatePropagation()
      if (e.key === 'ArrowDown') {
        setMentionIndex((i) => (i + 1) % suggestions.length)
      } else if (e.key === 'ArrowUp') {
        setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
      } else if (e.key === 'Enter') {
        insertMention(suggestions[mentionIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setMentionQuery(null)
      setMentionStart(null)
      setMentionEnd(null)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* 高亮层：与 textarea 完全相同的排版，渲染彩色 @引用 */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          padding: '4px 12px', minHeight,
          fontFamily: FONT_STACK, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT,
          letterSpacing: LETTER_SPACING,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          color: 'var(--color-text-1)',
          pointerEvents: 'none', zIndex: 1,
          overflow: 'hidden',
          border: '1px solid transparent',
          boxSizing: 'border-box',
        }}
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
      {/* 编辑层：透明文字，caret 可见，背景透明 */}
      <Input.TextArea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || '输入提示词... 输入 @ 可引用角色/场景/道具/音效，例如：@沈如姬 站在 @咖啡厅 上'}
        style={{
          minHeight, fontFamily: FONT_STACK, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT,
          letterSpacing: LETTER_SPACING,
          padding: '4px 12px',
          color: 'transparent',
          caretColor: 'var(--color-text-1)',
          background: 'transparent',
          position: 'relative', zIndex: 2,
        }}
      />

      {/* 已引用的资源彩色预览条 */}
      {referencedItems.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, padding: '4px 0' }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-3)', lineHeight: '20px' }}>已引用：</span>
          {referencedItems.map((r, i) => {
            const meta = TYPE_META[r.type] || { label: r.type, color: '#86909C' }
            return (
              <Tag key={i} size="small" style={{
                background: `${meta.color}15`, border: `1px solid ${meta.color}`,
                color: meta.color, borderRadius: 10,
              }}>
                {meta.label} · {r.name}
              </Tag>
            )
          })}
        </div>
      )}

      {/* @ 引用候选下拉 */}
      {mentionQuery !== null && (
        <div
          style={{
            position: 'absolute', bottom: 8, left: 8, right: 8,
            maxHeight: 240, overflowY: 'auto',
            background: 'var(--color-bg-1)',
            border: '1px solid var(--color-border)',
            borderRadius: 8, boxShadow: 'var(--shadow-3)',
            zIndex: 20, padding: 6,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--color-text-3)', padding: '4px 8px' }}>
            @ 引用 — 角色 / 场景 / 道具 / 音效（↑↓ 选择，Enter 插入，Esc 关闭）
          </div>
          {suggestions.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Empty description={resourcesLoaded ? '无匹配资源（可在资源管理先添加）' : '加载中...'} />
            </div>
          ) : (
            suggestions.map((s, i) => {
              const meta = TYPE_META[s.type] || { label: s.type, color: '#86909C' }
              const isActive = i === mentionIndex
              return (
                <div
                  key={`${s.type}-${s.id}`}
                  ref={(el) => {
                    // 键盘选中时自动滚入视野
                    if (isActive && el) el.scrollIntoView({ block: 'nearest' })
                  }}
                  onMouseDown={(e) => { e.preventDefault(); insertMention(s) }}
                  onMouseEnter={() => setMentionIndex(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                    background: isActive ? 'var(--color-fill-3)' : 'transparent',
                    borderLeft: isActive ? `3px solid ${meta.color}` : '3px solid transparent',
                    transition: 'background 0.1s',
                  }}
                >
                  <span style={{
                    fontSize: 11, color: '#fff', background: meta.color,
                    padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap',
                    fontWeight: 500, minWidth: 36, textAlign: 'center',
                  }}>{meta.label}</span>
                  <span style={{
                    color: isActive ? 'rgb(var(--primary-6))' : 'var(--color-text-1)',
                    fontWeight: isActive ? 600 : 400,
                  }}>{s.name}</span>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

export default PromptEditorLite
