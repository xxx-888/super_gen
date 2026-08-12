/**
 * ImageGenNode - 文生图节点
 *
 * 接收 text（提示词）和 refs（元素引用）输入，输出 image。
 * 调用 creationService.fusion()，参数与 EpisodeDetailPage 创作面板一致。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconImage } from '@arco-design/web-react/icon'
import { Select, Radio, Switch, Button, Tooltip } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import { NodeResultPreview } from './NodeResultPreview'
import { NodePromptField } from './NodePromptDrawer'
import { useNodeModels } from './useNodeModels'
import { useCanvasRuntime } from '../CanvasContext'
import { NODE_REGISTRY } from '../types'
import { ASPECT_RATIOS } from '@/types'

export const ImageGenNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.imageGen
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
              size="mini"
              type="primary"
              shape="circle"
              icon={<span style={{ fontSize: 10 }}>▶</span>}
              onClick={(e) => { e.stopPropagation(); runNode(id) }}
              style={{ width: 18, height: 18, minWidth: 18, padding: 0 }}
              
            />
          </Tooltip>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--color-text-3)' }}>…</span>
        )
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <NodePromptField
          value={d.prompt || ''}
          onChange={(v: string) => updateNodeData(id, { prompt: v })}
          projectId={projectId}
        />
        <Select
          size="small"
          placeholder="选择模型"
          value={d.model || undefined}
          onChange={(v: string) => updateNodeData(id, { model: v })}
          options={models.map((m: any) => ({ label: m.name, value: m.id }))}
          allowClear
          style={{ width: '100%' }}
          notFoundContent="暂无可用模型"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>尺寸</span>
          <Select size="small" value={d.size} onChange={(v) => updateNodeData(id, { size: v })} style={{ flex: 1 }}
            options={ASPECT_RATIOS.map((r) => ({ label: r.value, value: r.value }))} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>数量</span>
          <Radio.Group size="mini" type="button" value={d.count} onChange={(v) => updateNodeData(id, { count: v })}>
            {[1, 2, 3, 4].map((n) => <Radio key={n} value={n}>{n}</Radio>)}
          </Radio.Group>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>分辨率</span>
          <Select size="small" value={d.resolution || '720p'} onChange={(v: string) => updateNodeData(id, { resolution: v })} style={{ flex: 1 }}
            options={['480p', '720p', '768P', '1080p', '2k', '4k'].map(r => ({ label: r, value: r }))} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>质量</span>
          <Radio.Group size="mini" type="button" value={d.quality} onChange={(v) => updateNodeData(id, { quality: v })}>
            <Radio value="standard">快</Radio>
            <Radio value="hd">HD</Radio>
          </Radio.Group>
          <label style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, color: 'var(--color-text-3)', marginLeft: 'auto' }}>
            水印<Switch size="small" checked={d.watermark} onChange={(v) => updateNodeData(id, { watermark: v })} />
          </label>
        </div>
        {d._status === 'failed' && (
          <div style={{ color: 'rgb(var(--danger-6))', fontSize: 11 }}>失败：{d._errorMessage || '未知错误'}</div>
        )}
        <NodeResultPreview urls={d._result} type="image" onRegenerate={() => runNode(id)} />
      </div>
    </BaseNodeShell>
  )
}
