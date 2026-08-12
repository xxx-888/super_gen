/**
 * VideoGenNode - 图生视频节点
 *
 * 接收 image（图片）和 text（提示词）输入，输出 video。
 * 调用 creationService.imageToVideo()。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconVideoCamera } from '@arco-design/web-react/icon'
import { Select, Radio, Switch, InputNumber, Button, Tooltip } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import { NodeResultPreview } from './NodeResultPreview'
import { useCanvasRuntime } from '../CanvasContext'
import { NodePromptField } from './NodePromptDrawer'
import { useNodeModels } from './useNodeModels'
import { NODE_REGISTRY } from '../types'
import { ASPECT_RATIOS } from '@/types'

const RESOLUTIONS = ['480p', '720p', '768P', '1080p', '2k', '4k']

export const VideoGenNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.videoGen
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
        <Select
          size="mini"
          placeholder="模型"
          value={d.model || undefined}
          onChange={(v) => updateNodeData(id, { model: v })}
          options={models.map((m: any) => ({ label: m.name, value: m.id }))}
          allowClear
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>时长</span>
          <InputNumber size="mini" min={2} max={60} value={d.duration} onChange={(v) => updateNodeData(id, { duration: v })} style={{ flex: 1 }} />
          <span style={{ color: 'var(--color-text-3)', fontSize: 11 }}>秒</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>比例</span>
          <Select size="small" value={d.size} onChange={(v) => updateNodeData(id, { size: v })} style={{ flex: 1 }}
            options={ASPECT_RATIOS.map((r) => ({ label: r.value, value: r.value }))} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--color-text-3)', fontSize: 11, width: 32 }}>清晰</span>
          <Select size="small" value={d.resolution} onChange={(v) => updateNodeData(id, { resolution: v })} style={{ flex: 1 }}
            options={RESOLUTIONS.map((r) => ({ label: r, value: r }))} />
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
        <NodeResultPreview urls={d._result} type="video" onRegenerate={() => runNode(id)} />
      </div>
    </BaseNodeShell>
  )
}
