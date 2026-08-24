/**
 * DailyBars - 近 7 日任务趋势柱状图（纯 CSS，后台/用户仪表盘共用）
 * 蓝柱 = 每日任务总量，柱底红色叠加 = 失败数，悬停看明细
 */
import React from 'react'
import { Tooltip, Typography } from '@arco-design/web-react'

const { Text } = Typography

export interface DailyBarItem {
  date: string
  count: number
  failed: number
}

const DailyBars: React.FC<{ data?: DailyBarItem[] }> = ({ data }) => {
  const list = data || []
  const max = Math.max(1, ...list.map((d) => d.count))
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 150, paddingTop: 8 }}>
      {list.map((d) => {
        const h = Math.max(d.count > 0 ? 6 : 2, Math.round((d.count / max) * 110))
        const failedH = d.count > 0 ? Math.max(d.failed > 0 ? 3 : 0, Math.round((d.failed / d.count) * h)) : 0
        return (
          <Tooltip key={d.date} content={`${d.date}：${d.count} 个任务${d.failed ? `（失败 ${d.failed}）` : ''}`}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 5, height: '100%' }}>
              <div style={{ fontSize: 11, color: 'var(--color-text-3)' }}>{d.count || ''}</div>
              <div style={{ width: '100%', maxWidth: 44, height: h, borderRadius: '4px 4px 0 0', background: 'rgb(var(--arcoblue-5))', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden' }}>
                {failedH > 0 && <div style={{ width: '100%', height: failedH, background: 'rgb(var(--danger-6))' }} />}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-3)', whiteSpace: 'nowrap' }}>{d.date}</div>
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}

export default DailyBars
