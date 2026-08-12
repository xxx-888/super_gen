/**
 * NodePromptDrawer - 节点提示词编辑抽屉
 *
 * 节点内空间太小（240px），提示词编辑器和 @引用列表无法正常展示。
 * 改为：节点内只显示截断预览 + "编辑"按钮，点击弹出此抽屉（全屏宽度）。
 * 抽屉里有完整的 PromptEditorLite，@引用列表有足够空间展示。
 */
import React from 'react'
import { Drawer, Typography } from '@arco-design/web-react'
import { IconEdit } from '@arco-design/web-react/icon'
import PromptEditorLite from '@/components/editor/PromptEditorLite'
import { truncatePromptText } from '@/utils/prompt'

const { Text } = Typography

export const NodePromptField: React.FC<{
  value: string
  onChange: (v: string) => void
  projectId?: string
  placeholder?: string
}> = ({ value, onChange, projectId, placeholder = '点击输入画面描述…输入 @ 引用素材' }) => {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      {/* 节点内紧凑预览 */}
      <div
        onClick={() => setOpen(true)}
        style={{
          minHeight: 36, padding: '4px 8px', borderRadius: 4, cursor: 'pointer',
          background: 'var(--color-fill-2)', border: '1px dashed var(--color-border)',
          fontSize: 12, color: value ? 'var(--color-text-1)' : 'var(--color-text-3)',
          lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
          transition: 'border-color 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgb(var(--primary-5))' }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)' }}
      >
        {value ? truncatePromptText(value, 120) : <span style={{ opacity: 0.6 }}>📝 {placeholder}</span>}
      </div>

      {/* 全屏编辑抽屉 */}
      <Drawer
        title={<span><IconEdit /> 编辑提示词</span>}
        visible={open}
        onCancel={() => setOpen(false)}
        width={720}
        footer={null}
        maskClosable={true}
        unmountOnExit
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
          输入画面描述，输入 @ 可引用项目中的角色/场景/道具资源
        </Text>
        <PromptEditorLite
          value={value || ''}
          onChange={(v: string) => { onChange(v) }}
          placeholder={placeholder}
          minHeight={300}
          projectId={projectId}
        />
      </Drawer>
    </>
  )
}

export default NodePromptField
