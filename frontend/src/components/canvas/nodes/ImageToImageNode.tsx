/**
 * ImageToImageNode - 图生图节点
 *
 * 参考上传/连线的图片生成新图（如：服装不变、脸型更换）。
 * 需配置 gpt-image 系列模型（OpenAI Images Edits 协议）。
 * 参考图优先连线上游，其次节点内直接上传（存节点 data.ref_image）。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconImage } from '@arco-design/web-react/icon'
import { Select, Radio, Switch, Button, Tooltip } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import { NodeResultPreview } from './NodeResultPreview'
import { NodePromptField } from './NodePromptDrawer'
import { NodeRefUpload } from './NodeRefUpload'
import { useNodeModels } from './useNodeModels'
import { useCanvasRuntime } from '../CanvasContext'
import { NODE_REGISTRY } from '../types'
import { ASPECT_RATIOS } from '@/types'

export const ImageToImageNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.imageToImage
  const d = data as any
  const { runNode, updateNodeData, deleteNode, projectId } = useCanvasRuntime()
  const models = useNodeModels('text_to_image')

  return (
    <BaseNodeShell
      label={meta.label}
      color={meta.color}
      icon={<IconImage style={{ fontSize: 14 }} />}
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
        <NodeResultPreview urls={d._result} type="image" onRegenerate={() => runNode(id)} />
        <NodeRefUpload
          accept="image/*"
          value={d.ref_image}
          onChange={(url) => updateNodeData(id, { ref_image: url || '' })}
          label="参考图（服装/人物保持）"
        />
        <Select
          size="small" placeholder="选择模型（需 gpt-image 系列）"
          value={d.model || undefined}
          onChange={(v: string) => updateNodeData(id, { model: v })}
          options={models.map((m: any) => ({ label: m.name, value: m.id }))}
          allowClear style={{ width: '100%' }} notFoundContent="暂无可用模型"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>尺寸</span>
          <Select size="small" value={d.size} onChange={(v) => updateNodeData(id, { size: v })} style={{ flex: 1 }}
            options={ASPECT_RATIOS.map((r) => ({ label: r.value, value: r.value }))} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>质量</span>
          <Radio.Group size="mini" type="button" value={d.quality} onChange={(v) => updateNodeData(id, { quality: v })}>
            <Radio value="standard">快</Radio>
            <Radio value="hd">HD</Radio>
          </Radio.Group>
        </div>
        {d._status === 'failed' && (
          <div style={{ color: 'rgb(var(--danger-6))', fontSize: 11 }}>失败：{d._errorMessage || '未知错误'}</div>
        )}
        <NodePromptField
          value={d.prompt || ''}
          onChange={(v: string) => updateNodeData(id, { prompt: v })}
          projectId={projectId}
          placeholder="描述要改什么，如：保持服装与姿势不变，把脸换成参考图的人脸…"
        />
      </div>
    </BaseNodeShell>
  )
}
