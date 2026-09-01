/**
 * ForgotPasswordPage - 忘记密码
 *
 * 通过手机短信验证码重置密码（对齐后端 /auth/forgot-password/reset）：
 * 输入绑定的手机号 → 获取验证码(60s 倒计时) → 填验证码与新密码 → 提交
 */
import React, { useEffect, useState } from 'react'
import { Form, Input, Button, Typography, Message } from '@arco-design/web-react'
import { IconLock, IconPhone, IconSafe } from '@arco-design/web-react/icon'
import { Link, useNavigate } from 'react-router-dom'
import { authService } from '@/api/services'
import { useSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography

const PHONE_RE = /^1[3-9]\d{9}$/

const ForgotPasswordPage: React.FC = () => {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const navigate = useNavigate()
  const siteConfig = useSiteConfig()

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const handleSendCode = async () => {
    const phone = form.getFieldValue('phone')
    if (!phone || !PHONE_RE.test(phone)) {
      Message.error('请先输入正确的手机号')
      return
    }
    setSending(true)
    try {
      await authService.sendSmsCode(phone, 'reset_password')
      Message.success('验证码已发送，5分钟内有效')
      setCountdown(60)
    } catch (error: any) {
      const detail = error?.response?.data?.detail
      Message.error(typeof detail === 'string' && detail ? detail : '验证码发送失败，请稍后重试')
      console.error('Send sms code failed:', error)
    } finally {
      setSending(false)
    }
  }

  const handleReset = async (values: Record<string, any>) => {
    const v = form.getFieldsValue()
    const phone = values?.phone || v?.phone
    const code = values?.code || v?.code
    const newPassword = values?.new_password || v?.new_password
    if (!phone || !code || !newPassword) {
      Message.error('请填写所有必填字段')
      return
    }
    setLoading(true)
    try {
      await authService.resetPasswordBySms({ phone, code, new_password: newPassword })
      Message.success('密码重置成功，请使用新密码登录')
      setTimeout(() => navigate('/login'), 800)
    } catch (error: any) {
      const detail = error?.response?.data?.detail
      Message.error(typeof detail === 'string' && detail ? detail : '重置失败，请稍后重试')
      console.error('Reset password failed:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* 左侧品牌区（与登录/注册一致） */}
      <div style={{
        flex: '0 0 480px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1a1f2e',
        padding: 48,
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          top: -180,
          right: -120,
          width: 420,
          height: 420,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(22,93,255,0.12) 0%, transparent 70%)',
        }} />
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 380 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: '#fff', marginBottom: 36 }}>
            {siteConfig.site_name}
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#fff', lineHeight: 1.35, marginBottom: 14 }}>
            找回密码
          </h1>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', lineHeight: 1.65 }}>
            使用注册时绑定的手机号接收验证码，验证通过后即可设置新密码
          </p>
        </div>
      </div>

      {/* 右侧表单区 */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fff',
        padding: 40,
      }}>
        <div style={{ width: '100%', maxWidth: 360 }}>
          <div style={{ marginBottom: 32 }}>
            <Title heading={4} style={{ margin: 0, fontWeight: 600 }}>重置密码</Title>
            <Text type="secondary" style={{ marginTop: 6, fontSize: 14 }}>验证手机号后设置新密码</Text>
          </div>

          <Form
            form={form}
            onSubmit={handleReset}
            layout="vertical"
            requiredSymbol={false}
            size="large"
          >
            <Form.Item
              field="phone"
              rules={[
                { required: true, message: '请输入绑定的手机号' },
                { match: PHONE_RE, message: '请输入有效的手机号' },
              ]}
            >
              <Input placeholder="绑定的手机号" prefix={<IconPhone />} maxLength={11} />
            </Form.Item>

            <Form.Item
              field="code"
              rules={[
                { required: true, message: '请输入短信验证码' },
                { match: /^\d{4,6}$/, message: '验证码为 4-6 位数字' },
              ]}
            >
              <Input
                placeholder="短信验证码"
                maxLength={6}
                suffix={
                  <Button
                    size="small"
                    type="text"
                    loading={sending}
                    disabled={countdown > 0}
                    onClick={handleSendCode}
                    style={{ padding: '0 4px' }}
                  >
                    {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
                  </Button>
                }
              />
            </Form.Item>

            <Form.Item
              field="new_password"
              rules={[{ required: true, message: '请输入新密码' }, { minLength: 8, message: '密码至少8个字符' }]}
            >
              <Input.Password placeholder="新密码（至少8个字符）" prefix={<IconSafe />} />
            </Form.Item>

            <Form.Item
              field="confirm_password"
              dependencies={['new_password']}
              rules={[
                { required: true, message: '请再次输入新密码' },
                {
                  validator: (value, callback) => {
                    const pwd = form.getFieldValue('new_password')
                    if (value && pwd && value !== pwd) {
                      callback('两次输入的密码不一致')
                    } else {
                      callback()
                    }
                  },
                },
              ]}
            >
              <Input.Password placeholder="再次输入新密码" prefix={<IconLock />} />
            </Form.Item>

            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" long loading={loading} size="large">
                重置密码
              </Button>
            </Form.Item>
          </Form>

          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <Link to="/login" style={{ color: 'rgb(var(--primary-6))', fontWeight: 500, fontSize: 13, textDecoration: 'none' }}>
              返回登录
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ForgotPasswordPage
