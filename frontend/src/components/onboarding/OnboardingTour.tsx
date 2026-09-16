/**
 * OnboardingTour - 首次登录分步引导（聚光灯高亮）
 *
 * 自研轻量实现（不引入 driver.js 等依赖，与 Arco 主题 token 统一）：
 * - 有 selector 的步骤：目标元素滚动到视野并高亮（四边留 8px 的「光洞」，
 *   其余区域用超大 box-shadow 压暗）
 * - 无 selector 的步骤：居中欢迎/收尾卡片
 * - 上一步 / 下一步 / 跳过；完成与跳过都会回调（由父组件负责持久化）
 */
import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Button, Space } from '@arco-design/web-react'

export interface TourStep {
  selector?: string
  title: string
  content: React.ReactNode
  nextText?: string
}

interface Rect { top: number; left: number; width: number; height: number }

const VISIBLE_RECT: Rect = { top: -1, left: -1, width: 0, height: 0 }

const OnboardingTour: React.FC<{
  steps: TourStep[]
  visible: boolean
  onDone: () => void
  onSkip: () => void
}> = ({ steps, visible, onDone, onSkip }) => {
  const [idx, setIdx] = useState(0)
  const [rect, setRect] = useState<Rect>(VISIBLE_RECT)
  const step = steps[idx]

  const measure = useCallback(() => {
    if (!step?.selector) { setRect(VISIBLE_RECT); return }
    const el = document.querySelector(step.selector)
    if (!el || !(el instanceof HTMLElement)) { setRect(VISIBLE_RECT); return }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // 滚动后再量一次几何（scrollIntoView 是异步平滑滚动，监听 scroll 结束太绕，
    // 这里 200ms 后重测已足够平滑结束）
    setTimeout(() => {
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }, 220)
    const r = el.getBoundingClientRect()
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
  }, [step?.selector])

  useLayoutEffect(() => { if (visible) { setIdx(0) } }, [visible])

  useEffect(() => {
    if (!visible) return
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [visible, measure])

  if (!visible || !step) return null

  const isSpot = rect.top >= 0
  const pad = 8
  const holeStyle: React.CSSProperties | null = isSpot ? {
    position: 'fixed',
    top: rect.top - pad, left: rect.left - pad,
    width: rect.width + pad * 2, height: rect.height + pad * 2,
    borderRadius: 10,
    boxShadow: '0 0 0 9999px rgba(15, 20, 40, 0.55)',
    border: '1.5px solid rgb(var(--primary-6))',
    transition: 'all .25s ease',
    pointerEvents: 'none',
    zIndex: 1000,
  } : null

  // 提示卡定位：优先放光洞下方，放不下放上方；无光洞则居中
  let cardStyle: React.CSSProperties
  if (!isSpot) {
    cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', margin: 0 }
  } else {
    const below = rect.top + rect.height + 20
    const putBelow = below + 210 < window.innerHeight
    cardStyle = {
      top: putBelow ? below : Math.max(16, rect.top - 210),
      left: Math.min(
        Math.max(12, rect.left + rect.width / 2 - 170),
        window.innerWidth - 352,
      ),
      width: 340, margin: 0,
    }
  }

  return (
    <>
      {holeStyle && <div style={holeStyle} />}
      <div style={{
        position: 'fixed', zIndex: 1001,
        background: 'var(--color-bg-2)',
        borderRadius: 10, padding: '18px 20px 14px',
        boxShadow: '0 10px 34px rgba(0,0,0,.28)',
        transition: 'all .25s ease',
        ...cardStyle,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{
            background: 'rgb(var(--primary-6))', color: '#fff', borderRadius: '50%',
            width: 22, height: 22, fontSize: 12, display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', fontWeight: 700,
          }}>{idx + 1}</span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{step.title}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-3)' }}>{idx + 1} / {steps.length}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-2)', lineHeight: 1.8, marginBottom: 14 }}>
          {step.content}
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Button size="small" type="text" onClick={onSkip}>跳过引导</Button>
          <Space size={8} style={{ marginLeft: 'auto' }}>
            {idx > 0 && <Button size="small" onClick={() => setIdx(idx - 1)}>上一步</Button>}
            <Button size="small" type="primary" onClick={() => (idx === steps.length - 1 ? onDone() : setIdx(idx + 1))}>
              {step.nextText || (idx === steps.length - 1 ? '完成' : '下一步')}
            </Button>
          </Space>
        </div>
      </div>
    </>
  )
}

export default OnboardingTour
