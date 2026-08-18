/**
 * TTSNode - 语音合成节点
 *
 * 接收 text 输入，输出 audio。
 * 调用 creationService.tts()。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconSound } from '@arco-design/web-react/icon'
import { Select, Input, Button, Tooltip } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import { NodeResultPreview } from './NodeResultPreview'
import { NodePromptField } from './NodePromptDrawer'
import { NodeUploadButton } from './NodeUploadButton'
import { useNodeModels } from './useNodeModels'
import { useCanvasRuntime } from '../CanvasContext'
import { NODE_REGISTRY } from '../types'

export const TTSNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.tts
  const d = data as any
  const { runNode, updateNodeData, deleteNode, projectId } = useCanvasRuntime()
  const models = useNodeModels('tts')

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
        <NodeResultPreview urls={d._result} type="audio" onRegenerate={() => runNode(id)} />
        <Select size="small" placeholder="音色模型" value={d.model || undefined} onChange={(v: string) => updateNodeData(id, { model: v })}
          options={models.map((m: any) => ({ label: m.name, value: m.id }))}
          allowClear style={{ width: '100%' }} notFoundContent="暂无可用模型" />
        <Input size="mini" placeholder="音色 ID（可选）" value={d.voice_id || ''} onChange={(v) => updateNodeData(id, { voice_id: v })} />
        {d._status === 'failed' && (
          <div style={{ color: 'rgb(var(--danger-6))', fontSize: 11 }}>失败：{d._errorMessage || '未知错误'}</div>
        )}
        <NodeUploadButton projectId={projectId} />
        <NodePromptField
          value={d.text || ''}
          onChange={(v: string) => updateNodeData(id, { text: v })}
          projectId={projectId}
          placeholder="输入配音文本…"
        />
      </div>
    </BaseNodeShell>
  )
}
