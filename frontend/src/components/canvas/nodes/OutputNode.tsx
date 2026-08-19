/**
 * OutputNode - 输出/发布节点
 *
 * 实时解析上游连线（React Flow edges/nodes）的结果视频：上游生成节点跑完后
 * 自动出现预览和「发布到作品展示」按钮 —— 输出节点自身不执行、没有 _result，
 * 发布地址始终取上游产出。上游重新生成后按钮自动恢复（可发布新视频）。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { useEdges, useNodes } from '@xyflow/react'
import { IconShareExternal } from '@arco-design/web-react/icon'
import { Button, Tag, Message, Input, Spin } from '@arco-design/web-react'
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
  const edges = useEdges()
  const nodes = useNodes()

  // 实时解析上游连线的结果视频（上游生成完成即自动出现，无需手动刷新）
  const upstream = React.useMemo(() => {
    const edge = edges.find((e) => e.target === id)
    if (!edge) return null
    const src = nodes.find((n) => n.id === edge.source)
    if (!src) return null
    const sd: any = src.data
    return {
      url: sd._result?.[0],
      label: NODE_REGISTRY[src.type as keyof typeof NODE_REGISTRY]?.label || '上游',
      running: sd._status === 'running',
    }
  }, [edges, nodes, id])

  // 已发布的视频 = 上游当前结果（上游重新生成后按钮自动恢复，可发布新视频）
  const publishedCurrent = !!(d.publishedUrl && upstream?.url && d.publishedUrl === upstream.url)

  const handlePublish = async () => {
    if (!upstream?.url) {
      Message.warning(upstream ? `请等待${upstream.label}生成视频` : '请先连线视频输入')
      return
    }
    if (!d.title?.trim()) { Message.warning('请先填写作品标题'); return }
    setPublishing(true)
    try {
      await showcaseService.publish({
        title: d.title.trim(),
        video_url: upstream.url,
        tags: ['画布创作'],
      })
      updateNodeData(id, { publishedUrl: upstream.url })
      Message.success('已发布到作品展示')
    } catch {
      // API 错误（含重复发布/积分不足）由 axios 拦截器统一提示
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
      status={publishedCurrent ? 'completed' : upstream?.url ? d._status : undefined}
      onDelete={() => deleteNode(id)}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
        {!upstream ? (
          <div style={{ fontSize: 11, color: 'var(--color-text-3)', padding: '8px 0', textAlign: 'center' }}>
            连线视频到此节点
            <br />即可发布成片
          </div>
        ) : !upstream.url ? (
          <div style={{ padding: '12px 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            {upstream.running
              ? <><Spin size={16} /><span style={{ fontSize: 11, color: 'var(--color-text-3)' }}>{upstream.label}生成中…</span></>
              : <span style={{ fontSize: 11, color: 'var(--color-text-3)' }}>等待{upstream.label}生成视频</span>}
          </div>
        ) : (
          <>
            <NodeResultPreview urls={[upstream.url]} type="video" />
            <Input
              size="mini"
              value={d.title || ''}
              placeholder="作品标题（发布用）"
              maxLength={60}
              onChange={(v: string) => updateNodeData(id, { title: v })}
            />
            {publishedCurrent ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Tag size="small" color="green" style={{ flexShrink: 0 }}>已发布</Tag>
                <span style={{ fontSize: 11, color: 'var(--color-text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={d.title}>「{d.title}」已上架画廊</span>
              </div>
            ) : (
              <Button size="small" type="primary" long icon={<IconShareExternal />}
                loading={publishing} onClick={handlePublish}>
                {d.publishedUrl ? '发布新视频' : '发布到作品展示'}
              </Button>
            )}
          </>
        )}
      </div>
    </BaseNodeShell>
  )
}
