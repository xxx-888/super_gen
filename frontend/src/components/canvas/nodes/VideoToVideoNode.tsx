/**
 * VideoToVideoNode - 视频生视频节点
 *
 * 参考上传/连线的视频生成新视频（穿着/动作/场景保持），可连"新脸参考图"
 * 更换人物面部。走 MiniMax H3 参考视频（reference_video）。
 * 注意：参考视频需公网可访问 URL（配置文件服务器后本地上传自动转公网），
 * 本地 /uploads 视频会被渠道跳过（任务日志有警告）。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconVideoCamera } from '@arco-design/web-react/icon'
import { Select, Radio, Switch, InputNumber, Button, Tooltip } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import { NodeResultPreview } from './NodeResultPreview'
import { NodePromptField } from './NodePromptDrawer'
import { NodeRefUpload } from './NodeRefUpload'
import { useNodeModels } from './useNodeModels'
import { useCanvasRuntime } from '../CanvasContext'
import { NODE_REGISTRY } from '../types'
import { ASPECT_RATIOS } from '@/types'

const RESOLUTIONS = ['480p', '720p', '768P', '1080p', '2k', '4k']

export const VideoToVideoNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.videoToVideo
  const d = data as any
  const { runNode, updateNodeData, deleteNode, projectId } = useCanvasRuntime()
  const models = useNodeModels('image_to_video')

  return (
    <BaseNodeShell
      label={meta.label}
      color={meta.color}
      icon={<IconVideoCamera style={{ fontSize: 14 }} />}
      selected={selected}
      inputs={meta.inputs}
      outputs={meta.outputs}
      status={d._status}
      onDelete={() => deleteNode(id)}
      actions={
        d._status !== 'running' ? (
          <Tooltip content="运行节点">
            <Button
              size="mini" type="primary" shape="circle"
              icon={<span style={{ fontSize: 10 }}>▶</span>}
              onClick={(e) => { e.stopPropagation(); runNode(id) }}
              style={{ width: 18, height: 18, minWidth: 18, padding: 0 }}
            />
          </Tooltip>
        ) : <span style={{ fontSize: 10, color: 'var(--color-text-3)' }}>…</span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <NodeResultPreview urls={d._result} type="video" onRegenerate={() => runNode(id)} />
        <NodeRefUpload
          accept="video/*"
          value={d.ref_video}
          onChange={(url) => updateNodeData(id, { ref_video: url || '' })}
          label="参考视频（穿着/动作保持，需公网 URL）"
        />
        <NodeRefUpload
          accept="image/*"
          value={d.ref_face}
          onChange={(url) => updateNodeData(id, { ref_face: url || '' })}
          label="新脸参考图（可选，换脸用）"
        />
        <Select
          size="small" placeholder="选择图生视频模型"
          value={d.model || undefined}
          onChange={(v: string) => updateNodeData(id, { model: v })}
          options={models.map((m: any) => ({ label: m.name, value: m.id }))}
          allowClear style={{ width: '100%' }} notFoundContent="暂无可用模型"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>时长</span>
          <InputNumber size="mini" min={2} max={15} value={d.duration}
            onChange={(v) => updateNodeData(id, { duration: v })} style={{ flex: 1 }} />
          <span style={{ color: 'var(--color-text-3)', fontSize: 11 }}>秒</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>比例</span>
          <Select size="small" value={d.size} onChange={(v) => updateNodeData(id, { size: v })} style={{ flex: 1 }}
            options={ASPECT_RATIOS.map((r) => ({ label: r.value, value: r.value }))} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>分辨率</span>
          <Select size="small" value={d.resolution || '720p'} onChange={(v) => updateNodeData(id, { resolution: v })} style={{ flex: 1 }}
            options={RESOLUTIONS.map((r) => ({ label: r, value: r }))} />
        </div>
        {d._status === 'failed' && (
          <div style={{ color: 'rgb(var(--danger-6))', fontSize: 11 }}>失败：{d._errorMessage || '未知错误'}</div>
        )}
        <NodePromptField
          value={d.prompt || ''}
          onChange={(v: string) => updateNodeData(id, { prompt: v })}
          projectId={projectId}
          placeholder="如：人物穿着与动作和参考视频一致，面部替换为新脸参考图的人物…"
        />
      </div>
    </BaseNodeShell>
  )
}
