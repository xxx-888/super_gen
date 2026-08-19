/**
 * PublishWorkModal - 发布视频到作品展示（画廊）
 *
 * 供多处复用：片段详情页（分镜成片）、视频预览页（生成任务产物）。
 * 发布时自动携带 project_id / episode_id，便于「我的作品」溯源。
 */
import React, { useEffect, useState } from 'react'
import { Modal, Form, Input, Select, Message } from '@arco-design/web-react'
import { showcaseService } from '@/api/services'

export interface PublishTarget {
  videoUrl: string
  coverUrl?: string
  projectId?: string
  episodeId?: string
  defaultTitle?: string
  defaultTags?: string[]
}

interface Props {
  target: PublishTarget | null
  onCancel: () => void
  onPublished?: (work?: any) => void
}

const PublishWorkModal: React.FC<Props> = ({ target, onCancel, onPublished }) => {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (target) {
      form.resetFields()
      form.setFieldsValue({
        title: target.defaultTitle || '',
        description: '',
        tags: target.defaultTags || [],
        cover_url: target.coverUrl || '',
      })
    }
  }, [target, form])

  const handleOk = async () => {
    if (!target) return
    try {
      const v = await form.validate()
      setSaving(true)
      const res: any = await showcaseService.publish({
        title: v.title?.trim() || target.defaultTitle || '未命名作品',
        description: v.description?.trim() || undefined,
        video_url: target.videoUrl,
        cover_url: v.cover_url?.trim() || undefined,
        tags: (v.tags || []).filter(Boolean),
        project_id: target.projectId,
        episode_id: target.episodeId,
      })
      Message.success('已发布到作品展示')
      onCancel()
      onPublished?.(res?.data ?? res)
    } catch (err: any) {
      // 表单校验错误由 Form 展示; API 错误(如重复发布 409)由 axios 拦截器统一提示
      if (err?.errors) return
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="发布到作品展示"
      visible={!!target}
      onCancel={onCancel}
      onOk={handleOk}
      confirmLoading={saving}
      okText="发布"
      cancelText="取消"
      style={{ width: 520, maxWidth: '92vw' }}
    >
      <Form form={form} layout="vertical">
        <Form.Item field="title" label="作品标题" rules={[{ required: true, message: '请填写标题' }]}>
          <Input placeholder="如：林弈的抉择" maxLength={100} allowClear />
        </Form.Item>
        <Form.Item field="description" label="作品描述">
          <Input.TextArea placeholder="介绍一下这个作品（选填）" autoSize={{ minRows: 2, maxRows: 5 }} maxLength={500} />
        </Form.Item>
        <Form.Item field="tags" label="标签">
          <Select mode="tags" placeholder="输入后回车添加，如：古风 / 搞笑" allowClear allowCreate />
        </Form.Item>
        <Form.Item field="cover_url" label="封面图 URL" tooltip="留空将自动从视频截取画面做封面">
          <Input placeholder="https://...（选填）" allowClear />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/** 从任务产物 URL 列表中挑出视频地址 */
export function pickVideoUrl(urls?: string[]): string | undefined {
  if (!urls?.length) return undefined
  return urls.find((u) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u) || /video/i.test(u))
}

/** 从任务产物 URL 列表中挑出图片地址（做封面） */
export function pickImageUrl(urls?: string[]): string | undefined {
  if (!urls?.length) return undefined
  return urls.find((u) => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u) || /image/i.test(u))
}

export default PublishWorkModal
