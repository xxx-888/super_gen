/**
 * PromptEditorLite - 轻量版提示词编辑器（单层 contentEditable + 原子彩色芯片）
 *
 * 架构：单个 contentEditable <div>，@引用渲染为 contenteditable=false 的原子芯片。
 *      单层真实 DOM，光标天然存在于文本节点中，彻底告别双层渲染的光标错位问题。
 *
 * 存储格式（模板语法）：@{type:uuid:name}
 *   - uuid 为权威标识：资源改名后引用不失效；后端按 uuid 解析
 *   - name 内联携带：资源被删除/未加载时前端仍能显示名称
 *   - 向后兼容：旧的裸 @Name 格式后端仍能解析（按名称查找）
 *
 * 关键设计点：
 * - lastEmittedRef：记录上次 onChange 发出的值。useEffect([value]) 中，若值与自己发出
 *   的一致则跳过 innerHTML 更新（避免光标跳动）；只有外部变更才重渲染 DOM。
 * - 芯片原子性：contenteditable=false 使芯片不可内部编辑，Backspace 整体删除。
 * - 序列化：input 时遍历子节点，文本节点→原样、芯片→@{type:id:name}、<br>→\n。
 * - IME 合成期间不触发 @检测；粘贴净化为纯文本。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input, Empty, Modal } from '@arco-design/web-react'
import { IconSound, IconImage, IconDown, IconRight } from '@arco-design/web-react/icon'
import { resourceService } from '@/api/services'

// @引用类型元信息（与后端 prompt_builder 对齐）
const TYPE_META: Record<string, { label: string; color: string }> = {
  character: { label: '角色', color: '#722ED1' },
  scene_bg: { label: '场景', color: '#00B42A' },
  prop: { label: '道具', color: '#FF7D00' },
  audio: { label: '音效', color: '#86909C' },
}

/** 将十六进制颜色转为 rgba(r,g,b,alpha) */
function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '')
  const r = parseInt(m.substring(0, 2), 16)
  const g = parseInt(m.substring(2, 4), 16)
  const b = parseInt(m.substring(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export interface PromptEditorLiteProps {
  value?: string
  onChange?: (val: string) => void
  placeholder?: string
  minHeight?: number
  /** 项目ID，用于加载该项目的角色/场景/道具/音效资源 */
  projectId?: string
  /** 是否自动加载项目资源（默认 true） */
  autoLoad?: boolean
  /** 是否在编辑器下方显示 @引用的缩略图预览面板（默认 true） */
  showMentionPreview?: boolean
  maxLength?: number
}

const PromptEditorLite: React.FC<PromptEditorLiteProps> = ({
  value = '', onChange, placeholder, minHeight = 120, projectId, autoLoad = true,
  showMentionPreview = true, maxLength,
}) => {
  const editorRef = useRef<HTMLDivElement>(null)
  /** 上次 onChange 发出的值，用于区分外部传入 vs 自身回声 */
  const lastEmittedRef = useRef<string>('')
  /** 中文输入法合成中标记 */
  const composingRef = useRef(false)
  const [focused, setFocused] = useState(false)

  const [resources, setResources] = useState<Record<string, any[]>>({
    character: [], scene_bg: [], prop: [], audio: [],
  })
  const [resourcesLoaded, setResourcesLoaded] = useState(false)

  // @ 引用补全状态
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionSearch, setMentionSearch] = useState('')

  // ── 资源加载 ─────────────────────────────────────────
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

  // ── 所有候选（扁平化 + 过滤） ────────────────────────
  const suggestions = useMemo(() => {
    if (mentionQuery === null) return []
    const q = (mentionSearch || mentionQuery || '').trim().toLowerCase()
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
  }, [mentionQuery, mentionSearch, resources])

  /** 收集资源名 → (type,id) 映射，用于把裸 @Name 升级为模板格式 + 预览面板解析 */
  const nameToResource = useMemo(() => {
    const map: Record<string, { type: string; id: string }> = {}
    for (const type of Object.keys(resources))
      for (const item of resources[type])
        if (item.name && item.id) map[item.name] = { type, id: String(item.id) }
    return map
  }, [resources])

  // ── 解析当前 value 里的 @引用，匹配出缩略图（供底部预览面板用） ──
  const mentionedResources = useMemo(() => {
    if (!value) return [] as { type: string; id: string; name: string; image_url?: string | null; audio_url?: string | null }[]
    // 提取所有 @{type:uuid:name} 模板引用（去重，保留首次出现顺序）
    const re = /@\{(\w+):([a-f0-9-]{36}):([^}]+)\}/g
    const seen = new Set<string>()
    const refs: { type: string; id: string; name: string }[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(value)) !== null) {
      const key = `${m[1]}:${m[2]}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({ type: m[1], id: m[2], name: m[3] })
    }
    // 裸 @Name 格式也补上（用 nameToResource 映射）
    const bareRe = /@([\w一-龥]+)/g
    while ((m = bareRe.exec(value)) !== null) {
      // 跳过已被模板格式覆盖的位置
      const overlap = refs.some(r => r.name === m![1])
      if (overlap) continue
      const res = nameToResource[m[1]]
      if (res) {
        const key = `${res.type}:${res.id}`
        if (seen.has(key)) continue
        seen.add(key)
        refs.push({ type: res.type, id: res.id, name: m[1] })
      }
    }
    // 用 resources 数据匹配出 image_url / audio_url
    return refs.map(ref => {
      const list = resources[ref.type] || []
      const found = list.find((r: any) => String(r.id) === ref.id)
      return {
        ...ref,
        image_url: found?.image_url || null,
        audio_url: ref.type === 'audio' ? found?.url : null,
      }
    })
  }, [value, resources, nameToResource])

  // 预览面板折叠状态（每个组件实例独立）
  const [previewExpanded, setPreviewExpanded] = useState(false)
  // 点击缩略图放大预览的图片 URL
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  // ═══════════════════════════════════════════════════════
  //  序列化 / 反序列化（字符串 ⇄ DOM）
  // ═══════════════════════════════════════════════════════

  /** 创建一个 @mention 芯片 DOM 节点 */
  const createMentionNode = useCallback((type: string, id: string, name: string): HTMLSpanElement => {
    const meta = TYPE_META[type] || { color: '#86909C' }
    const span = document.createElement('span')
    span.className = 'pel-mention'
    span.setAttribute('contenteditable', 'false')
    span.setAttribute('data-type', type)
    span.setAttribute('data-id', id)
    span.setAttribute('data-name', name)
    span.style.setProperty('--mention-color', meta.color)
    span.style.setProperty('--mention-bg', hexToRgba(meta.color, 0.1))
    span.textContent = `@${name}`
    return span
  }, [])

  /** 将存储字符串渲染为 DOM 子节点（写入 contentEditable） */
  const renderValueToDom = useCallback((text: string) => {
    const root = editorRef.current
    if (!root) return
    // 清空现有内容
    root.textContent = ''
    if (!text) return

    // 同时匹配 @{type:id:name} 模板 和 @Name 裸名称（已知资源才转芯片）
    const templateRe = /@\{(\w+):([a-f0-9-]{36}):([^}]+)\}/g
    // 裸 @名称：@后跟中英文/数字（与 detectMention 一致）
    const bareNameRe = /@([\w一-龥]+)/g
    // 合并两种模式，按位置排序处理
    type Token = { index: number; kind: 'template' | 'bare'; type?: string; id?: string; name: string }
    const tokens: Token[] = []
    let m: RegExpExecArray | null
    templateRe.lastIndex = 0
    while ((m = templateRe.exec(text)) !== null) {
      tokens.push({ index: m.index, kind: 'template', type: m[1], id: m[2], name: m[3] })
    }
    bareNameRe.lastIndex = 0
    while ((m = bareNameRe.exec(text)) !== null) {
      // 只在模板格式未覆盖此位置时才考虑裸名称
      const overlap = tokens.some(t => m!.index >= t.index && m!.index < t.index + m![0].length)
      if (!overlap) {
        const name = m[1]
        const res = nameToResource[name]
        if (res) {
          tokens.push({ index: m.index, kind: 'bare', type: res.type, id: res.id, name })
        }
      }
    }
    tokens.sort((a, b) => a.index - b.index)

    let lastIndex = 0
    const doc = document
    const parts: Node[] = []

    const flushText = (raw: string) => {
      if (!raw) return
      const lines = raw.split('\n')
      lines.forEach((line, i) => {
        if (i > 0) parts.push(doc.createElement('br'))
        if (line) parts.push(doc.createTextNode(line))
      })
    }

    for (const tok of tokens) {
      flushText(text.slice(lastIndex, tok.index))
      parts.push(createMentionNode(tok.type!, tok.id!, tok.name))
      lastIndex = tok.index + (tok.kind === 'template'
        ? `@{${tok.type}:${tok.id}:${tok.name}}`.length
        : `@${tok.name}`.length)
    }
    flushText(text.slice(lastIndex))

    parts.forEach((n) => root.appendChild(n))
  }, [createMentionNode, nameToResource])

  /** 把 contentEditable 的 DOM 序列化为存储字符串 */
  const serializeDom = useCallback((): string => {
    const root = editorRef.current
    if (!root) return ''
    let out = ''
    root.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent || ''
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement
        if (el.classList?.contains('pel-mention')) {
          const type = el.getAttribute('data-type') || ''
          const id = el.getAttribute('data-id') || ''
          const name = el.getAttribute('data-name') || ''
          out += `@{${type}:${id}:${name}}`
        } else if (el.tagName === 'BR') {
          out += '\n'
        } else {
          // 未知元素：取纯文本（防富文本注入）
          out += el.textContent || ''
        }
      }
    })
    return out
  }, [])

  // ═══════════════════════════════════════════════════════
  //  值同步（外部变更 → DOM）
  // ═══════════════════════════════════════════════════════

  // 初次挂载渲染
  useEffect(() => {
    renderValueToDom(value)
    lastEmittedRef.current = value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // value 变化时：仅在外部变更（非自身回声）时重渲染 DOM
  useEffect(() => {
    if (value === lastEmittedRef.current) return // 自身回声，跳过
    renderValueToDom(value)
    lastEmittedRef.current = value
  }, [value, renderValueToDom])

  // 资源加载完成后重渲染（裸 @Name → 彩色芯片）
  // 用 requestAnimationFrame 延迟到当前事件循环之后，避开模态框自动聚焦导致的
  // activeElement 误判。仅在用户未手动编辑（值未变）时重渲染，避免丢失光标。
  const [resourcesReady, setResourcesReady] = useState(false)
  useEffect(() => {
    const hasResources = Object.values(resources).some(arr => arr.length > 0)
    if (hasResources && !resourcesReady) {
      setResourcesReady(true)
      // 延迟一帧后重渲染：此时模态框的自动聚焦已完成，且如果用户没编辑过
      // （lastEmittedRef === value），重渲染不会丢失用户输入
      requestAnimationFrame(() => {
        if (value === lastEmittedRef.current) {
          renderValueToDom(value)
        }
      })
    }
  }, [resources, resourcesReady, value, renderValueToDom])

  // ═══════════════════════════════════════════════════════
  //  自动高度
  // ═══════════════════════════════════════════════════════
  const autoResize = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    const lineH = parseFloat(cs.lineHeight) || 22
    const padTop = parseFloat(cs.paddingTop) || 0
    const padBottom = parseFloat(cs.paddingBottom) || 0
    const minH = Math.max(minHeight, 4 * lineH + padTop + padBottom)
    const maxH = 18 * lineH + padTop + padBottom
    // 先解除限制测真实高度
    el.style.height = 'auto'
    const scrollH = el.scrollHeight
    const targetH = Math.min(Math.max(scrollH, minH), maxH)
    el.style.height = targetH + 'px'
    el.style.overflowY = scrollH > maxH ? 'auto' : 'hidden'
  }, [minHeight])

  useEffect(() => { autoResize() }, [autoResize, value])

  // ═══════════════════════════════════════════════════════
  //  @ 引用检测与插入
  // ═══════════════════════════════════════════════════════

  /** 取光标前的文本（用于检测 @触发） */
  const getTextBeforeCaret = useCallback((): string => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return ''
    const range = sel.getRangeAt(0)
    // 取从当前行/段落起点到光标的文本
    const preRange = range.cloneRange()
    preRange.selectNodeContents(editorRef.current!)
    preRange.setEnd(range.endContainer, range.endOffset)
    return preRange.toString()
  }, [])

  /** 检测光标前是否有未完成的 @引用 */
  const detectMention = useCallback(() => {
    if (composingRef.current) return
    const before = getTextBeforeCaret()
    // 从后向前找最后一个 @，且其后只有中英文/数字
    const match = before.match(/@([\w一-龥]*)$/)
    if (match) {
      setMentionQuery(match[1] || '')
      setMentionIndex(0)
      setMentionSearch('')
    } else {
      setMentionQuery(null)
    }
  }, [getTextBeforeCaret])

  /** 删除当前正在输入的 @查询文本（插入芯片前调用） */
  const removeCurrentMentionQuery = useCallback((): Range | null => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0).cloneRange()
    const queryLen = (mentionQuery || '').length + 1 // +1 for @ itself
    // 光标回退 queryLen 个字符
    const startOffset = Math.max(0, range.endOffset - queryLen)
    try {
      range.setStart(range.startContainer, startOffset)
      range.deleteContents()
      sel.removeAllRanges()
      sel.addRange(range)
      return range
    } catch {
      return null
    }
  }, [mentionQuery])

  /** 插入一个 @mention 芯片到光标处 */
  const insertMention = useCallback((item: { type: string; id: string; name: string }) => {
    const root = editorRef.current
    if (!root) return
    root.focus()

    // 先删除正在输入的 @查询文本
    removeCurrentMentionQuery()

    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    range.deleteContents()

    // 在 @ 前自动补空格（若需要）
    const beforeText = getTextBeforeCaret()
    const needSpaceBefore = beforeText.length > 0 && !/\s$/.test(beforeText)

    const frag = document.createDocumentFragment()
    if (needSpaceBefore) frag.appendChild(document.createTextNode(' '))
    frag.appendChild(createMentionNode(item.type, String(item.id), item.name))
    // 芯片后跟一个零宽空格，方便光标移出
    frag.appendChild(document.createTextNode('\u200B'))

    // 关键：在 insertNode 之前先记录末尾节点引用。
    // 因为 range.insertNode(frag) 会把 frag 的子节点移入 DOM，使 frag 变空、
    // frag.lastChild 变为 null。预先捕获才能正确把光标定位到芯片之后。
    const tailNode = frag.lastChild
    range.insertNode(frag)
    // 把光标移到零宽空格之后（即芯片右边）
    if (tailNode) {
      const newRange = document.createRange()
      newRange.setStartAfter(tailNode)
      newRange.collapse(true)
      sel.removeAllRanges()
      sel.addRange(newRange)
    }

    setMentionQuery(null)
    setMentionIndex(0)
    setMentionSearch('')

    // 序列化并通知父组件
    const next = serializeDom()
    lastEmittedRef.current = next
    onChange?.(next)
    autoResize()
  }, [createMentionNode, getTextBeforeCaret, removeCurrentMentionQuery, serializeDom, onChange, autoResize])

  // ═══════════════════════════════════════════════════════
  //  事件处理
  // ═══════════════════════════════════════════════════════

  const handleInput = useCallback(() => {
    // 序列化当前 DOM 并通知
    const next = serializeDom()
    lastEmittedRef.current = next
    onChange?.(next)
    detectMention()
    autoResize()
  }, [serializeDom, onChange, detectMention, autoResize])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // @候选下拉激活时拦截方向键/回车/ESC
    if (mentionQuery !== null && suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
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
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setMentionQuery(null)
        return
      }
    }
    // 普通 Enter：允许换行（contentEditable 默认行为），无需拦截
  }, [mentionQuery, suggestions, mentionIndex, insertMention])

  /** 粘贴：净化为纯文本，避免富文本污染芯片结构 */
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    // 按换行拆分，插入文本节点 + <br>
    const lines = text.split('\n')
    const frag = document.createDocumentFragment()
    lines.forEach((line, i) => {
      if (i > 0) frag.appendChild(document.createElement('br'))
      if (line) frag.appendChild(document.createTextNode(line))
    })
    range.insertNode(frag)
    // 光标移到末尾
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
    handleInput()
  }, [handleInput])

  // ═══════════════════════════════════════════════════════
  //  渲染
  // ═══════════════════════════════════════════════════════
  return (
    <div style={{ position: 'relative' }}>
      <style>{`
        .pel-ce-editor[contenteditable] {
          outline: none;
          word-break: break-word;
          white-space: pre-wrap;
          overflow-wrap: break-word;
          line-height: 1.5715;
          font-size: 14px;
          font-family: inherit;
          box-sizing: border-box;
          width: 100%;
          padding: 4px 12px;
          border-radius: var(--border-radius-small, 2px);
          border: 1px solid var(--color-border, #e5e6eb);
          background: var(--color-fill-2, #f7f8fa);
          color: var(--color-text-1, #1d2129);
          transition: border-color 0.1s, background-color 0.1s;
          min-height: ${minHeight}px;
          resize: none;
          overflow-y: hidden;
        }
        .pel-ce-editor[contenteditable].pel-focused {
          background: var(--color-bg-2, #ffffff);
          border-color: rgb(var(--primary-6, 22, 93, 255));
        }
        /* 占位符：空内容时显示 */
        .pel-ce-editor[contenteditable]:empty:before {
          content: attr(data-placeholder);
          color: var(--color-text-3, #86909c);
          pointer-events: none;
        }
        /* @mention 原子芯片 */
        .pel-ce-editor .pel-mention {
          color: var(--mention-color, #722ED1);
          background: var(--mention-bg, rgba(114, 46, 209, 0.1));
          border-radius: 3px;
          padding: 0 3px;
          font-weight: 500;
          font-size: 0.95em;
          user-select: all;
          -webkit-user-select: all;
          cursor: default;
          display: inline;
        }
        .pel-ce-editor .pel-mention::selection {
          background: var(--mention-bg, rgba(114, 46, 209, 0.2));
        }
      `}</style>

      <div
        ref={editorRef}
        className={`pel-ce-editor${focused ? ' pel-focused' : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder || '输入提示词... 输入 @ 可引用角色/场景/道具/音效'}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => {
          composingRef.current = false
          handleInput()
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setMentionQuery(null) }}
      />

      {/* ── @ 引用缩略图预览面板（有引用时自动显示，默认折叠） ── */}
      {showMentionPreview && mentionedResources.length > 0 && (
        <div style={{
          marginTop: 6, borderRadius: 6, overflow: 'hidden',
          border: '1px solid var(--color-border)', background: 'var(--color-bg-2)',
        }}>
          {/* 摘要行（点击展开/收起） */}
          <div
            onClick={() => setPreviewExpanded(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
              cursor: 'pointer', userSelect: 'none', fontSize: 12,
              color: 'var(--color-text-2)',
            }}
            title={previewExpanded ? '收起预览' : '展开查看缩略图'}
          >
            {previewExpanded
              ? <IconDown style={{ fontSize: 12 }} />
              : <IconRight style={{ fontSize: 12 }} />}
            <span style={{ fontWeight: 600 }}>引用资源</span>
            {/* 按类型分组的数量标签 */}
            {Object.keys(TYPE_META).map(type => {
              const count = mentionedResources.filter(r => r.type === type).length
              if (count === 0) return null
              const meta = TYPE_META[type]
              return (
                <span key={type} style={{
                  fontSize: 11, color: meta.color, background: `${meta.color}1A`,
                  padding: '1px 7px', borderRadius: 10, fontWeight: 500,
                }}>
                  {meta.label} {count}
                </span>
              )
            })}
          </div>

          {/* 展开后的缩略图网格（按类型分组） */}
          {previewExpanded && (
            <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Object.keys(TYPE_META).map(type => {
                const items = mentionedResources.filter(r => r.type === type)
                if (items.length === 0) return null
                const meta = TYPE_META[type]
                return (
                  <div key={type}>
                    <div style={{
                      fontSize: 11, color: 'var(--color-text-3)', marginBottom: 5,
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <span style={{ width: 3, height: 10, background: meta.color, borderRadius: 2, display: 'inline-block' }} />
                      {meta.label}（{items.length}）
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {items.map(item => {
                        const isAudio = type === 'audio'
                        // 统一卡片宽度，音频窄一些。图片卡用固定画框高度 + contain 完整展示
                        const cardStyle: React.CSSProperties = {
                          width: isAudio ? 140 : 112,
                          flex: 'none',
                        }
                        return (
                          <div key={`${type}-${item.id}`} style={cardStyle}>
                            {isAudio ? (
                              // 音频：图标 + 名称 + 播放条
                              <div style={{
                                padding: '4px 6px', borderRadius: 6,
                                background: 'var(--color-fill-2)', display: 'flex',
                                alignItems: 'center', gap: 4,
                              }}>
                                <IconSound style={{ fontSize: 14, color: meta.color, flexShrink: 0 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{
                                    fontSize: 11, color: 'var(--color-text-1)',
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  }}>{item.name}</div>
                                  {item.audio_url && (
                                    <audio src={item.audio_url} controls style={{
                                      width: '100%', height: 18, transform: 'scale(0.7)',
                                      transformOrigin: 'left center',
                                    }} />
                                  )}
                                </div>
                              </div>
                            ) : (
                              // 图片：固定画框 + contain 完整展示原图（不裁剪）+ 点击放大
                              <div style={{
                                borderRadius: 6, overflow: 'hidden',
                                border: '1px solid var(--color-border)',
                                background: 'var(--color-bg-2)',
                              }}>
                                <div style={{
                                  width: '100%', height: 88,
                                  overflow: 'hidden', position: 'relative',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  // 棋盘格背景：让透明图片的留白区可见
                                  backgroundImage:
                                    'linear-gradient(45deg, var(--color-fill-3) 25%, transparent 25%),' +
                                    'linear-gradient(-45deg, var(--color-fill-3) 25%, transparent 25%),' +
                                    'linear-gradient(45deg, transparent 75%, var(--color-fill-3) 75%),' +
                                    'linear-gradient(-45deg, transparent 75%, var(--color-fill-3) 75%)',
                                  backgroundSize: '12px 12px',
                                  backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
                                  background: 'var(--color-fill-2)',
                                }}>
                                  {item.image_url ? (
                                    <img
                                      src={item.image_url}
                                      alt={item.name}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setPreviewSrc(item.image_url!)
                                      }}
                                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                      style={{
                                        maxWidth: '100%', maxHeight: '100%',
                                        objectFit: 'contain', display: 'block',
                                        cursor: 'zoom-in',
                                      }}
                                    />
                                  ) : (
                                    <IconImage style={{ color: 'var(--color-text-4)', fontSize: 20 }} />
                                  )}
                                </div>
                                <div style={{
                                  fontSize: 11, padding: '3px 5px', color: 'var(--color-text-1)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  textAlign: 'center',
                                }}>{item.name}</div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── @ 引用候选下拉 ────────────────────────────── */}
      {mentionQuery !== null && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
            maxHeight: 240, overflowY: 'auto',
            background: 'var(--color-bg-1)',
            border: '1px solid var(--color-border)',
            borderRadius: 8, boxShadow: 'var(--shadow-3)',
            zIndex: 20, padding: 6,
          }}
        >
          <div style={{ padding: '2px 4px 6px' }}>
            <Input
              size="small"
              placeholder="搜索资源名称..."
              value={mentionSearch}
              onChange={setMentionSearch}
              prefix={<span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>🔍</span>}
              style={{ borderRadius: 6 }}
              onKeyDown={(e) => {
                if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
                  e.stopPropagation()
                }
              }}
            />
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

      {/* ── 缩略图点击放大预览 ────────────────────────── */}
      <Modal
        visible={!!previewSrc}
        onCancel={() => setPreviewSrc(null)}
        footer={null}
        closable
        style={{ width: 'auto', maxWidth: '80vw' }}
      >
        {previewSrc && (
          <div style={{ textAlign: 'center' }}>
            <img src={previewSrc} alt="预览" style={{ maxWidth: '78vw', maxHeight: '72vh', objectFit: 'contain' }} />
          </div>
        )}
      </Modal>
    </div>
  )
}

export default PromptEditorLite
