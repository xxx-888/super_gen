/**
 * ImportPreviewModal - AI 剧本导入预览弹窗
 *
 * 上传文件经 AI 处理后（清理水印 + 分集识别），展示处理结果供用户确认：
 * - 顶部：显示 AI 删除的水印行（删除线样式）
 * - 中间：分集预览卡片（标题可编辑 + 内容预览）
 * - 底部：选择创建方式（N 个独立剧本 / 合并为一个 / 取消）
 */
import React, { useState } from 'react'
import { Modal, Input, Button, Space, Typography, Message, Tag, Spin } from '@arco-design/web-react'
import { IconCheckCircle, IconDelete, IconClose } from '@arco-design/web-react/icon'

const { Text, Title } = Typography

export interface ProcessedEpisode {
  title: string
  content: string
}

export interface ProcessedResult {
  episodes: ProcessedEpisode[]
  removed_lines: string[]
}

interface ImportPreviewModalProps {
  visible: boolean
  filename: string
  processed: ProcessedResult | null
  onCancel: () => void
  /** 创建 N 个独立剧本 */
  onBatchCreate: (episodes: ProcessedEpisode[]) => Promise<void>
  /** 合并为一个剧本（用清理后的完整内容） */
  onMergeToOne: (content: string) => Promise<void>
}

const ImportPreviewModal: React.FC<ImportPreviewModalProps> = ({
  visible, filename, processed, onCancel, onBatchCreate, onMergeToOne,
}) => {
  const [episodes, setEpisodes] = useState<ProcessedEpisode[]>([])
  const [submitting, setSubmitting] = useState(false)

  // processed 变化时同步到本地可编辑状态
  React.useEffect(() => {
    if (visible && processed) {
      setEpisodes(processed.episodes.map(ep => ({ ...ep })))
    }
  }, [visible, processed])

  const handleTitleChange = (i: number, title: string) => {
    setEpisodes(prev => prev.map((ep, idx) => idx === i ? { ...ep, title } : ep))
  }

  const handleBatchCreate = async () => {
    setSubmitting(true)
    try {
      await onBatchCreate(episodes)
    } finally {
      setSubmitting(false)
    }
  }

  const handleMerge = async () => {
    setSubmitting(true)
    try {
      // 合并所有集为一个完整内容
      const merged = episodes.map(ep => `# ${ep.title}\n\n${ep.content}`).join('\n\n---\n\n')
      await onMergeToOne(merged)
    } finally {
      setSubmitting(false)
    }
  }

  if (!processed) return null
  const epCount = episodes.length
  const removedCount = processed.removed_lines?.length || 0

  return (
    <Modal
      visible={visible}
      onCancel={onCancel}
      title={`AI 导入预览 · ${filename}`}
      style={{ width: 680 }}
    >
      <>
      {/* AI 清理的水印行 */}
      {removedCount > 0 ? (
        <div style={{ marginBottom: 16, padding: 12, background: 'var(--color-fill-2)', borderRadius: 8 }}>
          <Space style={{ marginBottom: 8 }}>
            <IconDelete style={{ color: 'rgb(var(--danger-6))' }} />
            <Text bold>AI 识别并清理了 {removedCount} 行无关内容：</Text>
          </Space>
          <div style={{ maxHeight: 80, overflow: 'auto' }}>
            {processed.removed_lines.map((line, i) => (
              <div key={i} style={{
                textDecoration: 'line-through',
                color: 'var(--color-text-3)',
                fontSize: 12,
                padding: '2px 0',
              }}>
                {line}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 分集预览 */}
      <div style={{ marginBottom: 12 }}>
        <Space>
          <IconCheckCircle style={{ color: 'rgb(var(--success-6))' }} />
          <Text bold>AI 识别出 {epCount} 集</Text>
          {removedCount === 0 && <Tag color="green" size="small">内容干净，无需清理</Tag>}
        </Space>
      </div>

      {/* 每集卡片 */}
      <div style={{ maxHeight: 360, overflowY: 'auto', marginBottom: 16 }}>
        {episodes.map((ep, i) => (
          <div key={i} style={{
            marginBottom: 12, padding: 12, borderRadius: 8,
            border: '1px solid var(--color-border)', background: 'var(--color-bg-1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Tag color="arcoblue" size="small">第 {i + 1} 集</Tag>
              <Input
                value={ep.title}
                onChange={(v) => handleTitleChange(i, v)}
                style={{ flex: 1, fontWeight: 600 }}
                size="small"
              />
              <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {ep.content.length} 字
              </Text>
            </div>
            <div style={{
              fontSize: 12, color: 'var(--color-text-3)', lineHeight: 1.6,
              maxHeight: 80, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'pre-wrap',
            }}>
              {ep.content.slice(0, 200)}{ep.content.length > 200 ? '...' : ''}
            </div>
          </div>
        ))}
      </div>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button onClick={onCancel} disabled={submitting}>取消</Button>
        {epCount > 1 && (
          <Button
            type="primary"
            loading={submitting}
            onClick={handleBatchCreate}
          >
            创建 {epCount} 个独立剧本
          </Button>
        )}
        <Button
          type={epCount > 1 ? 'outline' : 'primary'}
          loading={submitting}
          onClick={handleMerge}
        >
          {epCount > 1 ? '合并为一个剧本' : '确认导入'}
        </Button>
      </div>
      </>
    </Modal>
  )
}

export default ImportPreviewModal
