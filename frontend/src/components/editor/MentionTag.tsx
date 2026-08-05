/**
 * MentionTag - @引用标签组件
 *
 * 在提示词编辑器中显示的彩色标签，代表对资源的引用
 */
import React from 'react'
import { Tooltip, Tag } from '@arco-design/web-react'
import type { ResourceType } from '@/types'

interface MentionTagProps {
  /** 资源类型 */
  type: ResourceType

  /** 显示名称 */
  name: string

  /** 资源ID */
  id: string

  /** 缩略图URL(可选) */
  imageUrl?: string | null

  /** 点击回调 */
  onClick?: () => void

  /** 是否可移除 */
  removable?: boolean

  /** 移除回调 */
  onRemove?: () => void
}

const MentionTag: React.FC<MentionTagProps> = ({
  type,
  name,
  id,
  imageUrl,
  onClick,
  removable = false,
  onRemove,
}) => {
  // 根据类型获取颜色配置
  const getTypeConfig = (type: ResourceType) => {
    switch (type) {
      case 'character':
        return {
          color: '#722ED1',
          bgColor: 'rgba(114, 46, 209, 0.08)',
          borderColor: '#722ED1',
          label: '角色',
        }
      case 'scene_bg':
        return {
          color: '#00B42A',
          bgColor: 'rgba(0, 180, 42, 0.08)',
          borderColor: '#00B42A',
          label: '场景',
        }
      case 'prop':
        return {
          color: '#FF7D00',
          bgColor: 'rgba(255, 125, 0, 0.08)',
          borderColor: '#FF7D00',
          label: '道具',
        }
      case 'audio':
        return {
          color: '#86909C',
          bgColor: 'rgba(134, 144, 156, 0.08)',
          borderColor: '#86909C',
          label: '音频',
        }
      default:
        return {
          color: '#165DFF',
          bgColor: 'rgba(22, 93, 255, 0.08)',
          borderColor: '#165DFF',
          label: '资源',
        }
    }
  }

  const config = getTypeConfig(type)

  const content = (
    <span
      className={`mention-tag ${type}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        margin: '0 2px',
        border: `1px solid ${config.borderColor}`,
        borderRadius: 4,
        background: config.bgColor,
        color: config.color,
        fontSize: 'inherit',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 150ms ease',
        verticalAlign: 'middle',
        userSelect: 'none',
      }}
      onClick={onClick}
    >
      {/* 缩略图或图标 */}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={name}
          style={{
            width: 18,
            height: 18,
            borderRadius: 3,
            objectFit: 'cover',
            border: `1px solid ${config.borderColor}33`,
          }}
        />
      ) : (
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 3,
            background: config.color,
            color: 'white',
            fontSize: 11,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {name.charAt(0)}
        </span>
      )}

      {/* 名称 */}
      <span style={{ fontWeight: 500 }}>{name}</span>

      {/* 移除按钮 */}
      {removable && (
        <span
          onClick={(e) => {
            e.stopPropagation()
            onRemove?.()
          }}
          style={{
            marginLeft: 2,
            fontSize: 14,
            lineHeight: 1,
            opacity: 0.6,
            cursor: 'pointer',
          }}
        >
          ×
        </span>
      )}
    </span>
  )

  // 如果有点击事件，包裹Tooltip
  if (onClick) {
    return (
      <Tooltip content={`查看${config.label}: ${name}`} position="top">
        {content}
      </Tooltip>
    )
  }

  return content
}

export default MentionTag
