/**
 * MaterialNode - 素材节点
 *
 * 从项目素材库选择角色/场景/道具，输出 image 和 ref 句柄。
 * 复用 MaterialPickerModal（与其他页面的素材选择体验一致）。
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconImage } from '@arco-design/web-react/icon'
import { Button, Tag, Message, Radio } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import MaterialPickerModal, { type MaterialPickResult } from '@/components/material/MaterialPickerModal'
import { NODE_REGISTRY } from '../types'
import { useCanvasRuntime } from '../CanvasContext'

const CLASS_OPTIONS = [
  { value: 'character', label: '角色' },
  { value: 'scene', label: '场景' },
  { value: 'prop', label: '物品' },
]

export const MaterialNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.material
  const d = data as any
  const [pickerVisible, setPickerVisible] = React.useState(false)
  const { projectId, updateNodeData, deleteNode } = useCanvasRuntime()

  const handlePicked = (result: MaterialPickResult) => {
    updateNodeData(id, {
      name: result.name,
      image_url: result.image_url || '',
      resource_id: result.resource_id,
      material_id: result.material_id || undefined,
      classType: result.type,
    })
    setPickerVisible(false)
    Message.success(`已选择：${result.name}`)
  }

  const classLabel = CLASS_OPTIONS.find(c => c.value === d.classType)?.label || '角色'

  return (
    <>
      <BaseNodeShell
        label={meta.label}
        color={meta.color}
        icon={<IconImage style={{ fontSize: 14 }} />}
        selected={selected}
        outputs={meta.outputs}
        status={d._status}
        onDelete={() => deleteNode(id)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* 类型切换 */}
          <Radio.Group
            size="mini" type="button"
            value={d.classType || 'character'}
            onChange={(v: string) => updateNodeData(id, { classType: v, name: '', image_url: '', resource_id: '' })}
            style={{ width: '100%' }}
          >
            {CLASS_OPTIONS.map(c => <Radio key={c.value} value={c.value}>{c.label}</Radio>)}
          </Radio.Group>

          {d.image_url ? (
            <>
              <div style={{ position: 'relative', borderRadius: 4, overflow: 'hidden', aspectRatio: d.classType === 'character' ? '1' : '16/9' }}>
                <img src={d.image_url} alt={d.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Tag size="small" color="green">{classLabel}</Tag>
                <span style={{ fontSize: 12, color: 'var(--color-text-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.name || '未命名'}
                </span>
              </div>
              <Button size="mini" type="text" long onClick={() => setPickerVisible(true)}>更换素材</Button>
            </>
          ) : (
            <Button
              size="small"
              type="dashed"
              long
              icon={<IconImage />}
              onClick={() => {
                if (!projectId) { Message.warning('请先选择项目'); return }
                setPickerVisible(true)
              }}
            >
              选择{classLabel}素材
            </Button>
          )}
        </div>
      </BaseNodeShell>
      {pickerVisible && projectId && (
        <MaterialPickerModal
          visible={pickerVisible}
          classType={(d.classType as 'character' | 'scene' | 'prop') || 'character'}
          projectId={projectId}
          onSelect={handlePicked}
          onCancel={() => setPickerVisible(false)}
        />
      )}
    </>
  )
}
