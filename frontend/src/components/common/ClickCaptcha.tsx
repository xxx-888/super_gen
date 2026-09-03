/**
 * ClickCaptcha - 点选人机验证（发短信验证码前置）
 *
 * 流程：打开即拉挑战（SVG + 3 个目标字）→ 用户按顺序点击图中文字
 * （每次点击落标记）→ 满 3 个自动提交校验 → 通过回调一次性
 * captcha_token 给父组件（父组件凭此调 sendSmsCode）。
 * 未通过自动清空重来，连续失败自动「换一张」。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button, Message, Modal, Spin, Tag, Typography } from '@arco-design/web-react'
import { IconRefresh } from '@arco-design/web-react/icon'
import { authService } from '@/api/services'

const { Text } = Typography

const W = 300
const H = 120

type Props = {
  visible: boolean
  purpose: 'register' | 'reset_password'
  onCancel: () => void
  /** 验证通过，返回一次性 captcha_token */
  onSuccess: (token: string) => void
}

const ClickCaptcha: React.FC<Props> = ({ visible, purpose, onCancel, onSuccess }) => {
  const [loading, setLoading] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [captchaId, setCaptchaId] = useState('')
  const [svg, setSvg] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [points, setPoints] = useState<Array<[number, number]>>([])
  const [failCount, setFailCount] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setPoints([])
    try {
      const res: any = await authService.captchaChallenge(purpose)
      setCaptchaId(res.captcha_id)
      setSvg(res.svg || '')
      setTargets(res.targets || [])
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      Message.error(typeof detail === 'string' && detail ? detail : '验证码加载失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [purpose])

  useEffect(() => {
    if (visible) {
      setFailCount(0)
      load()
    }
  }, [visible, load])

  const handleClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!captchaId || verifying || points.length >= 3) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.round(e.clientX - rect.left)
    const y = Math.round(e.clientY - rect.top)
    const next = [...points, [x, y] as [number, number]]
    setPoints(next)
    if (next.length < 3) return

    // 满 3 个自动提交
    setVerifying(true)
    try {
      const res: any = await authService.captchaVerify(captchaId, next)
      Message.success('验证通过')
      onSuccess(res.captcha_token)
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      Message.error(typeof detail === 'string' && detail ? detail : '验证未通过，请重试')
      const fc = failCount + 1
      setFailCount(fc)
      setPoints([])
      if (fc >= 2) {
        // 连续失败换一张，防死循环
        setTimeout(() => { setFailCount(0); load() }, 600)
      }
    } finally {
      setVerifying(false)
    }
  }

  return (
    <Modal
      title="安全验证"
      visible={visible}
      onCancel={onCancel}
      footer={null}
      style={{ width: 360 }}
      unmountOnExit
    >
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>请按顺序点击：</Text>
        {targets.map((t, i) => (
          <Tag key={i} color={points.length > i ? 'green' : 'arcoblue'}
              style={{ fontSize: 14, padding: '0 8px' }}>
            {i + 1}. {t}
          </Tag>
        ))}
      </div>

      {loading ? (
        <div style={{ width: W, height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-fill-2)', borderRadius: 8 }}>
          <Spin tip="加载中..." />
        </div>
      ) : (
        <div
          onClick={handleClick}
          style={{
            width: W, height: H, position: 'relative', borderRadius: 8,
            overflow: 'hidden', cursor: 'pointer', boxShadow: '0 0 0 1px var(--color-border-2)',
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        >
          {/* 点击标记（覆盖层不能挡住点击目标判定——标记 pointerEvents none） */}
          {points.map(([x, y], i) => (
            <span key={i} style={{
              position: 'absolute', left: x - 11, top: y - 11, width: 22, height: 22,
              borderRadius: '50%', background: 'rgb(var(--primary-6))', color: '#fff',
              fontSize: 12, lineHeight: '20px', textAlign: 'center', pointerEvents: 'none',
              border: '1px solid #fff',
            }}>{i + 1}</span>
          ))}
          {verifying && (
            <div style={{
              position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
            }}><Spin /></div>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {points.length === 0 ? '点击图中文字完成验证' : `已点 ${points.length}/3`}
        </Text>
        <Button size="mini" type="text" icon={<IconRefresh />} onClick={() => { setPoints([]); load() }}>
          换一张
        </Button>
      </div>
    </Modal>
  )
}

export default ClickCaptcha
