/**
 * PromptNode - 提示词节点
 *
 * 输入画面描述，支持 @引用角色/场景/道具。
 * 输出 text 句柄，可连线到 ImageGenNode / VideoGenNode / TTSNode。
 * 复用 PromptEditorLite（与项目其他页面的提示词编辑器一致）。
 */
import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { IconEdit } from '@arco-design/web-react/icon'
import { BaseNodeShell } from '../BaseNodeShell'
import PromptEditorLite from '@/components/editor/PromptEditorLite'
import { NODE_REGISTRY } from '../types'
import { useCanvasRuntime } from '../CanvasContext'

export const PromptNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.prompt
  const d = data as any
  const { projectId, updateNodeData, deleteNode } = useCanvasRuntime()
  return (
    <BaseNodeShell
      label={meta.label}
      color={meta.color}
      icon={<IconEdit style={{ fontSize: 14 }} />}
      selected={selected}
      outputs={meta.outputs}
      status={d._status}
      onDelete={() => deleteNode(id)}
    >
      <PromptEditorLite
        value={d.text || ''}
        onChange={(v: string) => { updateNodeData(id, { text: v }) }}
        placeholder="描述画面…输入 @ 引用素材"
        minHeight={60}
        projectId={projectId}
      />
    </BaseNodeShell>
  )
}
