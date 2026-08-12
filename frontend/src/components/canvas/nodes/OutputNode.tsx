/**
 * OutputNode - 输出/发布节点
 *
 * 接收 video 输入，可发布到作品展示（showcaseService.publish）。
 * 不调用生成 API，只是终端节点。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconShareExternal } from '@arco-design/web-react/icon'
import { Button, Tag, Message } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import { NodeResultPreview } from './NodeResultPreview'
import { NODE_REGISTRY } from '../types'
import { useCanvasRuntime } from '../CanvasContext'
import { showcaseService } from '@/api/services'

export const OutputNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.output
  const d = data as any
  const [publishing, setPublishing] = React.useState(false)
  const { updateNodeData, deleteNode } = useCanvasRuntime()

  const handlePublish = async () => {
    const videoUrl = d._result?.[0]
    if (!videoUrl) { Message.warning('请先连线视频输入'); return }
    setPublishing(true)
    try {
      await showcaseService.publish({
        title: d._title || '画布作品',
        video_url: videoUrl,
        tags: ['画布创作'],
      })
      updateNodeData(id, { published: true })
      Message.success('已发布到作品展示')
    } catch (e: any) {
      Message.error(e?.message || '发布失败')
    } finally { setPublishing(false) }
  }

  return (
    <BaseNodeShell
      label={meta.label}
      color={meta.color}
      icon={<IconShareExternal style={{ fontSize: 14 }} />}
      selected={selected}
      inputs={meta.inputs}
      outputs={meta.outputs}
      status={d._status}
      onDelete={() => deleteNode(id)}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
        {d._result?.length ? (
          <>
            <NodeResultPreview urls={d._result} type="video" />
            {d.published && <Tag size="small" color="green">已发布</Tag>}
            <Button size="small" type="primary" long icon={<IconShareExternal />}
              loading={publishing} onClick={handlePublish} disabled={d.published}>
              {d.published ? '已发布' : '发布到作品展示'}
            </Button>
          </>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--color-text-3)', padding: '8px 0', textAlign: 'center' }}>
            连线视频到此节点
            <br />即可发布成片
          </div>
        )}
      </div>
    </BaseNodeShell>
  )
}
