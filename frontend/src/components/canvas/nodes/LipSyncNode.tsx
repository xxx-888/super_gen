/**
 * LipSyncNode - 对口型节点
 *
 * 接收 video 和 audio 输入，输出对口型后的 video。
 * 调用 creationService.lipSync()。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconSound } from '@arco-design/web-react/icon'
import { Select, Button, Tooltip } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import { NodeResultPreview } from './NodeResultPreview'
import { useNodeModels } from './useNodeModels'
import { useCanvasRuntime } from '../CanvasContext'
import { NODE_REGISTRY } from '../types'

export const LipSyncNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.lipSync
  const d = data as any
  const { runNode, updateNodeData, deleteNode, projectId } = useCanvasRuntime()
  const models = useNodeModels('image_to_video')

  return (
    <BaseNodeShell
      label={meta.label}
      color={meta.color}
      icon={<IconSound style={{ fontSize: 14 }} />}
      selected={selected}
      inputs={meta.inputs}
      outputs={meta.outputs}
      status={d._status}
      onDelete={() => deleteNode(id)}
      actions={
        d._status !== 'running' ? (
          <Tooltip content="运行节点">
            <Button size="mini" type="primary" shape="circle"
              icon={<span style={{ fontSize: 10 }}>▶</span>}
              onClick={(e) => { e.stopPropagation(); runNode(id) }}
              style={{ width: 18, height: 18, minWidth: 18, padding: 0 }}
               />
          </Tooltip>
        ) : <span style={{ fontSize: 10, color: 'var(--color-text-3)' }}>…</span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Select size="small" placeholder="模型" value={d.model || undefined} onChange={(v) => updateNodeData(id, { model: v })}
          options={models.map((m: any) => ({ label: m.name, value: m.id }))}
          allowClear style={{ width: '100%' }} />
        <div style={{ fontSize: 11, color: 'var(--color-text-3)', padding: '2px 0' }}>
          将视频和音频合成对口型视频
        </div>
        {d._status === 'failed' && (
          <div style={{ color: 'rgb(var(--danger-6))', fontSize: 11 }}>失败：{d._errorMessage || '未知错误'}</div>
        )}
        <NodeResultPreview urls={d._result} type="video" onRegenerate={() => runNode(id)} />
      </div>
    </BaseNodeShell>
  )
}
