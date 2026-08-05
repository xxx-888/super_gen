/**
 * PromptEditor - 提示词编辑器 (核心组件)
 *
 * 功能:
 * 1. 富文本编辑器，支持@引用角色/场景/道具/音频
 * 2. 底部资源面板，点击插入引用
 * 3. 实时解析和预览展开后的提示词
 * 4. Token数量估算和质量评估
 * 5. 支持撤销/重做
 *
 * 使用Tiptap构建，自定义Mention扩展实现@引用
 */
import React, { useEffect, useCallback, useMemo, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Mention from '@tiptap/extension-mention'
import { createRoot, Root } from 'react-dom/client'
import {
  Modal,
  Button,
  Space,
  Tag,
  Tooltip,
  Tabs,
  Input,
  Empty,
  Spin,
  Message,
} from '@arco-design/web-react'
import {
  IconEye,
  IconSave,
  IconUndo,
  IconRedo,
  IconCheckCircle,
  IconExclamationCircle,
} from '@arco-design/web-react/icon'

import ResourcePanel from './ResourcePanel'
import PromptPreviewPanel from './PromptPreviewPanel'

import { useEditorStore, useResourcePanelStore } from '@/stores'
import { apiClient } from '@/api/client'
import type { ScenePromptPreview, ResourceType } from '@/types'

interface PromptEditorProps {
  sceneId: string
  initialPrompt?: string
  onSave?: (prompt: string) => void
  onCancel?: () => void
  readOnly?: boolean
}

const PromptEditor: React.FC<PromptEditorProps> = ({
  sceneId,
  initialPrompt = '',
  onSave,
  onCancel,
  readOnly = false,
}) => {
  const {
    originalPrompt,
    isDirty,
    isValid,
    validationErrors,
    previewData,
    setOriginalPrompt,
    setIsDirty,
    setValidation,
    setPreviewData,
  } = useEditorStore()

  const {
    characters,
    sceneBackgrounds,
    props: propItems,
    audioAssets,
    activeTab,
    setActiveTab,
  } = useResourcePanelStore()

  // ==================== 资源数据(用于Mention建议) ====================
  const suggestionItems = useMemo(() => {
    const allResources = [
      ...characters.map((c) => ({ ...c, resourceType: 'character' as ResourceType })),
      ...sceneBackgrounds.map((s) => ({ ...s, resourceType: 'scene_bg' as ResourceType })),
      ...propItems.map((p) => ({ ...p, resourceType: 'prop' as ResourceType })),
      ...audioAssets.map((a) => ({ ...a, resourceType: 'audio' as ResourceType })),
    ]

    return allResources.map((resource) => ({
      id: resource.id,
      name: resource.name || '未命名',
      resourceType: resource.resourceType,
      imageUrl: resource.image_url || undefined,
      searchTerms: [
        resource.name,
        resource.description || '',
        resource.appearance_prompt || '',
        resource.prompt || '',
      ]
        .filter(Boolean)
        .join(' '),
    }))
  }, [characters, sceneBackgrounds, propItems, audioAssets])

  // ==================== Tiptap编辑器配置 ====================
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: { depth: 100 },
      }),
      Mention.configure({
        HTMLAttributes: {
          class: 'mention-node',
        },
        suggestion: {
          items: ({ query }) => {
            if (!query.trim()) return suggestionItems.slice(0, 10)

            const lowerQuery = query.toLowerCase()
            return suggestionItems
              .filter(
                (item) =>
                  item.name.toLowerCase().includes(lowerQuery) ||
                  item.searchTerms.toLowerCase().includes(lowerQuery)
              )
              .slice(0, 10)
          },

          render: () => {
            let component: React.ReactElement | null = null
            let popup: HTMLElement | null = null
            let root: Root | null = null

            return {
              onStart: (props) => {
                popup = document.createElement('div')
                popup.className = 'mention-suggestion-popup'
                popup.style.cssText = `
                  position: absolute;
                  background: white;
                  border: 1px solid #E5E6EB;
                  border-radius: 8px;
                  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
                  padding: 4px;
                  min-width: 200px;
                  max-height: 240px;
                  overflow-y: auto;
                  z-index: 1000;
                `

                document.body.appendChild(popup)

                component = React.createElement(MentionSuggestionList, {
                  items: props.items,
                  command: props.command,
                })

                // 同步创建 root，避免异步泄漏
                if (popup) {
                  root = createRoot(popup)
                  root.render(component)
                }
              },

              onUpdate(props: any) {
                if (!props.clientRect) return

                const rect = props.clientRect()
                if (!rect || !popup) return

                popup.style.top = `${rect.bottom + window.scrollY + 8}px`
                popup.style.left = `${rect.left + window.scrollX}px`
              },

              onKeyDown(props: any) {
                if (props.event.key === 'Escape') {
                  if (root) { root.unmount(); root = null }
                  if (popup) { popup.remove(); popup = null }
                  return true
                }
                if (props.event.key === 'Enter') {
                  return false
                }
                return false
              },

              onExit() {
                if (root) { root.unmount(); root = null }
                if (popup) { popup.remove(); popup = null }
              },
            }
          },
        },
      }),
    ],
    content: initialPrompt,
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      const content = editor.getText()
      setOriginalPrompt(content)
      setIsDirty(true)
      debouncedUpdatePreview(content)
    },
    editorProps: {
      attributes: {
        class: 'prompt-editor-content',
      },
    },
  })

  // 同步外部 initialPrompt 变化
  useEffect(() => {
    if (editor && initialPrompt && !isDirty) {
      editor.commands.setContent(initialPrompt)
    }
  }, [initialPrompt, sceneId])  // sceneId 变化时也重置

  // ==================== 防抖预览更新 ====================
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updatePreview = useCallback(async (prompt: string) => {
    try {
      const data: ScenePromptPreview = await apiClient.post(
        `/scenes/${sceneId}/preview`,
        { prompt }
      )
      setPreviewData(data)

      const quality = data.estimated_quality
      setValidation(
        quality !== 'too_short' && quality !== 'too_long',
        quality === 'too_short'
          ? ['提示词过短，可能影响生成质量']
          : quality === 'too_long'
          ? ['提示词过长，可能被截断']
          : []
      )
    } catch (error) {
      console.error('Failed to update preview:', error)
    }
  }, [sceneId, setPreviewData, setValidation])

  const debouncedUpdatePreview = useCallback(
    (prompt: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(async () => {
        await updatePreview(prompt)
      }, 500)
    },
    [updatePreview]
  )

  // 初始加载时获取预览
  useEffect(() => {
    if (initialPrompt) {
      updatePreview(initialPrompt)
    }
  }, [sceneId])  // eslint-disable-line react-hooks/exhaustive-deps

  // ==================== 保存处理 ====================
  const handleSave = async () => {
    if (!editor) return

    const content = editor.getText()

    try {
      await apiClient.put(`/scenes/${sceneId}/prompt`, { prompt: content })
      setIsDirty(false)
      Message.success('提示词已保存')
      onSave?.(content)
    } catch (error) {
      Message.error('保存失败')
    }
  }

  // ==================== 插入引用 ====================
  const insertMention = useCallback(
    (item: any) => {
      if (!editor) return

      // 插入真正的 Mention 节点（而非纯文本）
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'mention',
          attrs: {
            id: item.id,
            label: item.name,
          },
        })
        .run()

      Message.info(`已插入 @${item.name}`)
    },
    [editor]
  )

  // 清理 timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  // ==================== 渲染 ====================
  return (
    <div className="prompt-editor-container">
      {/* 头部工具栏 */}
      <div className="prompt-editor-header">
        <Space>
          <span style={{ fontWeight: 600 }}>编辑提示词</span>
          {isDirty && (
            <Tag color="orange" size="small">
              未保存
            </Tag>
          )}
          {isValid ? (
            <Tooltip content="提示词格式正确">
              <IconCheckCircle style={{ color: '#00B42A' }} />
            </Tooltip>
          ) : (
            <Tooltip content={validationErrors.join('; ')}>
              <IconExclamationCircle style={{ color: '#F53F3F' }} />
            </Tooltip>
          )}
        </Space>

        <Space>
          <Button
            type="text"
            size="small"
            icon={<IconUndo />}
            onClick={() => editor?.chain().focus().undo().run()}
            disabled={!editor?.can().undo()}
          >
            撤销
          </Button>
          <Button
            type="text"
            size="small"
            icon={<IconRedo />}
            onClick={() => editor?.chain().focus().redo().run()}
            disabled={!editor?.can().redo()}
          >
            重做
          </Button>

          {!readOnly && (
            <>
              <Button onClick={onCancel}>取消</Button>
              <Button
                type="primary"
                icon={<IconSave />}
                onClick={handleSave}
                disabled={!isDirty}
              >
                保存
              </Button>
            </>
          )}
        </Space>
      </div>

      {/* 主内容区 */}
      <div className="prompt-editor-body">
        {/* 编辑器区域 */}
        <div className="prompt-editor-main">
          {editor ? (
            <EditorContent editor={editor} />
          ) : (
            <Spin loading />
          )}

          {/* 预览面板 */}
          {previewData && (
            <PromptPreviewPanel data={previewData} />
          )}
        </div>

        {/* 右侧资源面板 */}
        {!readOnly && (
          <div className="prompt-editor-sidebar">
            <ResourcePanel
              onInsertMention={insertMention}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ==================== 子组件: 建议列表 ====================
interface MentionSuggestionListProps {
  items: Array<{
    id: string
    name: string
    resourceType: ResourceType
    imageUrl?: string
  }>
  command: (item: any) => void
}

const MentionSuggestionList: React.FC<MentionSuggestionListProps> = ({
  items,
  command,
}) => {
  if (items.length === 0) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: '#86909C' }}>
        未找到匹配的资源
      </div>
    )
  }

  return (
    <div>
      {items.map((item) => (
        <div
          key={item.id}
          onClick={() => command({ id: item.id, label: item.name })}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            cursor: 'pointer',
            borderRadius: 6,
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLElement).style.background = '#F7F8FA'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLElement).style.background = 'transparent'
          }}
        >
          {/* 图标/缩略图 */}
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              background: getResourceColor(item.resourceType),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: 14,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {(item.name || '?').charAt(0)}
          </div>

          {/* 名称和类型 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 500,
                fontSize: 13,
                color: '#1D2129',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.name}
            </div>
            <div
              style={{
                fontSize: 11,
                color: '#86909C',
                marginTop: 2,
              }}
            >
              {getResourceTypeName(item.resourceType)}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// 辅助函数: 获取资源类型颜色
function getResourceColor(type: ResourceType): string {
  switch (type) {
    case 'character':
      return '#722ED1'
    case 'scene_bg':
      return '#00B42A'
    case 'prop':
      return '#FF7D00'
    case 'audio':
      return '#86909C'
    default:
      return '#165DFF'
  }
}

// 辅助函数: 获取资源类型名称
function getResourceTypeName(type: ResourceType): string {
  switch (type) {
    case 'character':
      return '角色'
    case 'scene_bg':
      return '场景'
    case 'prop':
      return '道具'
    case 'audio':
      return '音频'
    default:
      return '未知'
  }
}

export default PromptEditor
