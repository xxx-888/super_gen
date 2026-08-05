/**
 * 统一状态中文化映射
 *
 * 各业务实体的状态值 → 中文标签 + 颜色
 * 用于渲染时把英文状态转成中文显示。
 */

// 项目状态: draft/producing/completed/archived
export const PROJECT_STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'gray' },
  producing: { label: '制作中', color: 'arcoblue' },
  completed: { label: '已完成', color: 'green' },
  archived: { label: '已归档', color: 'gray' },
}

// 分镜状态: pending/ready/generating/completed/failed
export const SCENE_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: '待处理', color: 'gray' },
  ready: { label: '就绪', color: 'arcoblue' },
  generating: { label: '生成中', color: 'orange' },
  completed: { label: '已完成', color: 'green' },
  failed: { label: '失败', color: 'red' },
}

// 任务状态: pending/processing/completed/failed/cancelled
export const TASK_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: '等待中', color: 'gray' },
  processing: { label: '处理中', color: 'orange' },
  completed: { label: '已完成', color: 'green' },
  failed: { label: '失败', color: 'red' },
  cancelled: { label: '已取消', color: 'gray' },
}

// 集状态: asset/pending_submit/video_editing/completed
export const EPISODE_STATUS: Record<string, { label: string; color: string }> = {
  asset: { label: '资产准备', color: 'gray' },
  pending_submit: { label: '待提交', color: 'orange' },
  video_editing: { label: '视频编辑', color: 'arcoblue' },
  completed: { label: '已完成', color: 'green' },
}

// 通用：任意状态值 → 中文（兜底：原值）
export function statusLabel(status: string, map: Record<string, { label: string; color: string }>): string {
  return map[status]?.label || status
}

export function statusColor(status: string, map: Record<string, { label: string; color: string }>): string {
  return map[status]?.color || 'gray'
}
