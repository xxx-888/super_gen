/**
 * PromptPreviewPanel - 提示词预览面板
 *
 * 显示:
 * 1. 展开后的完整提示词(展开@引用)
 * 2. Token数量估算
 * 3. 质量评估
 * 4. 引用的资源列表
 */
import React from 'react'
import { Card, Tag, Progress, Space, List, Typography } from '@arco-design/web-react'
import {
  IconEye,
  IconCheckCircle,
  IconExclamationCircle,
  IconInfoCircle,
} from '@arco-design/web-react/icon'

import type { PromptPreview } from '@/stores'

interface PromptPreviewPanelProps {
  data: PromptPreview
}

const { Text, Paragraph } = Typography

const PromptPreviewPanel: React.FC<PromptPreviewPanelProps> = ({ data }) => {
  // 获取质量评估配置
  const getQualityConfig = (quality: string) => {
    switch (quality) {
      case 'good':
        return {
          color: '#00B42A',
          icon: <IconCheckCircle />,
          text: '提示词质量良好',
          status: 'success',
        }
      case 'acceptable':
        return {
          color: '#FF7D00',
          icon: <IconExclamationCircle />,
          text: '提示词质量可接受',
          status: 'warning',
        }
      case 'too_long':
        return {
          color: '#F53F3F',
          icon: <IconExclamationCircle />,
          text: '提示词过长，可能被截断',
          status: 'danger',
        }
      case 'too_short':
        return {
          color: '#F53F3F',
          icon: <IconExclamationCircle />,
          text: '提示词过短，可能影响生成质量',
          status: 'danger',
        }
      default:
        return {
          color: '#86909C',
          icon: <IconInfoCircle />,
          text: '未知状态',
          status: 'default',
        }
    }
  }

  const qualityConfig = getQualityConfig(data.estimated_quality)

  // Token使用率(假设上限1000)
  const tokenPercent = Math.min((data.token_count / 1000) * 100, 100)
  const tokenColor =
    data.token_count > 1000 ? '#F53F3F' : data.token_count > 800 ? '#FF7D00' : '#00B42A'

  return (
    <Card
      title={
        <Space>
          <IconEye />
          提示词预览
        </Space>
      }
      size="small"
      style={{ marginTop: 20 }}
    >
      {/* 质量评估 */}
      <div style={{ marginBottom: 16 }}>
        <Space align="center">
          <span style={{ color: qualityConfig.color }}>{qualityConfig.icon}</span>
          <Text strong style={{ color: qualityConfig.color }}>
            {qualityConfig.text}
          </Text>
        </Space>
      </div>

      {/* Token统计 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Token 数量</Text>
          <Text strong>{data.token_count} / ~1000</Text>
        </div>
        <Progress
          percent={tokenPercent}
          size="small"
          color={tokenColor}
          showText={false}
        />
      </div>

      {/* 引用的资源 */}
      {data.referenced_resources.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            已引用资源 ({data.referenced_resources.length})
          </Text>
          <List
            size="small"
            dataSource={data.referenced_resources}
            renderItem={(item) => (
              <List.Item style={{ padding: '4px 0', border: 'none' }}>
                <Space size={8}>
                  <Tag
                    color={
                      item.type === 'character'
                        ? 'purple'
                        : item.type === 'scene_bg'
                        ? 'green'
                        : item.type === 'prop'
                        ? 'orangered'
                        : 'gray'
                    }
                  >
                    {item.type === 'character'
                      ? '角色'
                      : item.type === 'scene_bg'
                      ? '场景'
                      : item.type === 'prop'
                      ? '道具'
                      : '音频'}
                  </Tag>
                  <Text>{item.name}</Text>
                </Space>
              </List.Item>
            )}
          />
        </div>
      )}

      {/* 展开后的完整提示词 */}
      <div>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          展开后的完整提示词
        </Text>
        <Paragraph
          style={{
            background: 'var(--color-bg-2)',
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.7,
            maxHeight: 200,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {data.expanded_prompt || '(暂无内容)'}
        </Paragraph>
      </div>

      {/* 原始提示词对比 */}
      <div style={{ marginTop: 12 }}>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          原始提示词(含@引用)
        </Text>
        <Paragraph
          style={{
            background: 'var(--color-bg-2)',
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.7,
            maxHeight: 150,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'monospace',
          }}
        >
          {data.original_prompt || '(暂无内容)'}
        </Paragraph>
      </div>
    </Card>
  )
}

export default PromptPreviewPanel
