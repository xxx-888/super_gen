/**
 * RegisterPage - 注册页面
 *
 * 字段对齐后端 RegisterRequest: email + nickname + password(min 8) + phone + sms_code
 * 手机短信验证码：获取验证码按钮带 60s 倒计时（后端同手机号同用途也有冷却）
 * 使用 Arco Form.useForm() 确保正确获取表单值
 */
import React, { useEffect, useState } from 'react'
import { Form, Input, Button, Typography, Message, Checkbox } from '@arco-design/web-react'
import { IconUser, IconLock, IconEmail, IconPhone } from '@arco-design/web-react/icon'
import { Link, useNavigate } from 'react-router-dom'
import { apiClient } from '@/api/client'
import { authService } from '@/api/services'
import ClickCaptcha from '@/components/common/ClickCaptcha'
import { setAccessToken, saveUser } from '@/utils/auth'
import { useSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography

const PHONE_RE = /^1[3-9]\d{9}$/

const RegisterPage: React.FC = () => {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [agreed, setAgreed] = useState(false)
  const [captchaVisible, setCaptchaVisible] = useState(false)
  const navigate = useNavigate()
  const siteConfig = useSiteConfig()

  // 60s 重发倒计时
  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  // 点「获取验证码」→ 先过点选人机验证，再真实发送
  const handleSendCode = () => {
    const phone = form.getFieldValue('phone')
    if (!phone || !PHONE_RE.test(phone)) {
      Message.error('请先输入正确的手机号')
      return
    }
    setCaptchaVisible(true)
  }

  const doSendCode = async (captchaToken: string) => {
    const phone = form.getFieldValue('phone')
    setSending(true)
    try {
      await authService.sendSmsCode(phone, 'register', captchaToken)
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

  const handleRegister = async (values: Record<string, any>) => {
    // 未勾选协议不允许注册
    if (!agreed) {
      Message.warning('请先阅读并同意《用户服务协议》与《隐私政策》')
      return
    }
    // 双保险：优先用 onSubmit 传的 values，后备用 form.getFieldsValue()
    const formValues = form.getFieldsValue()
    const email = values?.email || formValues?.email
    const password = values?.password || formValues?.password
    const nickname = values?.nickname || formValues?.nickname
    const phone = values?.phone || formValues?.phone
    const smsCode = values?.sms_code || formValues?.sms_code

    if (!email || !password || !nickname || !phone || !smsCode) {
      Message.error('请填写所有必填字段')
      return
    }

    setLoading(true)
    try {
      // apiClient.post 返回的是后端 body (TokenResponse)
      const res: any = await apiClient.post('/auth/register', {
        email,
        nickname,
        password,
        phone,
        sms_code: smsCode,
      })

      // 注册成功直接登录
      setAccessToken(res.access_token)
      localStorage.setItem('refresh_token', res.refresh_token)

      // 获取用户信息
      const user: any = await apiClient.get('/auth/me')
      saveUser(user)

      Message.success('注册成功')
      navigate('/dashboard')
    } catch (error: any) {
      // 认证接口失败由页面自行展示后端返回的具体原因（拦截器不再统一处理 /auth/* 错误）
      const detail = error?.response?.data?.detail
      const status = error?.response?.status
      // 后端常见错误文案 → 中文友好提示
      const friendly: Record<string, string> = {
        'Email already registered': '该邮箱已被注册',
        '管理员已关闭注册，请联系管理员创建账号': '管理员已关闭注册，请联系管理员创建账号',
      }
      const raw = typeof detail === 'string' ? detail : ''
      const msg = friendly[raw]
        || raw
        || (status === 409 ? '该邮箱或手机号已被注册' : '注册失败，请稍后重试')
      Message.error(msg)
      console.error('Register failed:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* 左侧品牌区 */}
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
        <div style={{
          position: 'absolute',
          bottom: -120,
          left: -80,
          width: 340,
          height: 340,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(114,46,209,0.08) 0%, transparent 70%)',
        }} />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 380 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: '#fff', marginBottom: 36 }}>
            {siteConfig.site_name}
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#fff', lineHeight: 1.35, marginBottom: 14 }}>
            开始创作
          </h1>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', lineHeight: 1.65, marginBottom: 36 }}>
            注册账号，开启 AI 短剧制作之旅
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {['免费试用全部功能', '支持本地模型部署', '数据安全可控', '团队协作支持'].map((item) => (
              <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'rgba(255,255,255,0.65)' }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4a90ff', flexShrink: 0 }} />
                {item}
              </div>
            ))}
          </div>
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
            <Title heading={4} style={{ margin: 0, fontWeight: 600 }}>创建账号</Title>
            <Text type="secondary" style={{ marginTop: 6, fontSize: 14 }}>填写以下信息完成注册</Text>
          </div>

          <Form
            form={form}
            onSubmit={handleRegister}
            layout="vertical"
            requiredSymbol={false}
            size="large"
          >
            <Form.Item
              field="nickname"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input placeholder="你的名字" prefix={<IconUser />} />
            </Form.Item>

            <Form.Item
              field="email"
              rules={[
                { required: true, message: '请输入邮箱地址' },
                { type: 'email', message: '请输入有效的邮箱地址' },
              ]}
            >
              <Input placeholder="name@company.com" prefix={<IconEmail />} />
            </Form.Item>

            <Form.Item
              field="phone"
              rules={[
                { required: true, message: '请输入手机号' },
                { match: /^1[3-9]\d{9}$/, message: '请输入有效的手机号' },
              ]}
            >
              <Input placeholder="手机号（用于验证与找回密码）" prefix={<IconPhone />} maxLength={11} />
            </Form.Item>

            <Form.Item
              field="sms_code"
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
              field="password"
              rules={[
                { required: true, message: '请输入密码' },
                { minLength: 8, message: '密码至少8个字符' },
              ]}
            >
              <Input.Password placeholder="至少8个字符" prefix={<IconLock />} />
            </Form.Item>

            <Form.Item
              field="confirmPassword"
              rules={[
                { required: true, message: '请再次输入密码' },
                {
                  validator: (value, callback) => {
                    const pwd = form.getFieldValue('password')
                    if (value && pwd && value !== pwd) {
                      callback('两次输入的密码不一致')
                    } else {
                      callback()
                    }
                  },
                },
              ]}
            >
              <Input.Password placeholder="再次输入密码" prefix={<IconLock />} />
            </Form.Item>

            <Form.Item style={{ marginBottom: 12 }}>
              <Checkbox checked={agreed} onChange={setAgreed} style={{ fontSize: 13 }}>
                我已阅读并同意
                <Link to="/terms" target="_blank" style={{ color: 'rgb(var(--primary-6))' }}>《用户服务协议》</Link>
                与
                <Link to="/privacy" target="_blank" style={{ color: 'rgb(var(--primary-6))' }}>《隐私政策》</Link>
              </Checkbox>
            </Form.Item>

            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" long loading={loading} size="large" disabled={!agreed}>
                注册
              </Button>
            </Form.Item>
          </Form>

          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>已有账号？</Text>{' '}
            <Link to="/login" style={{ color: 'rgb(var(--primary-6))', fontWeight: 500, fontSize: 13, textDecoration: 'none' }}>
              立即登录
            </Link>
          </div>

          {/* 底部公共链接导航 */}
          <div style={{ textAlign: 'center', marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--color-border-2)' }}>
            <Link to="/terms" target="_blank" style={{ color: 'var(--color-text-3)', fontSize: 12, textDecoration: 'none' }}>用户服务协议</Link>
            <span style={{ color: 'var(--color-border-2)', margin: '0 10px', fontSize: 12 }}>·</span>
            <Link to="/privacy" target="_blank" style={{ color: 'var(--color-text-3)', fontSize: 12, textDecoration: 'none' }}>隐私政策</Link>
            <span style={{ color: 'var(--color-border-2)', margin: '0 10px', fontSize: 12 }}>·</span>
            <Link to="/contact" style={{ color: 'var(--color-text-3)', fontSize: 12, textDecoration: 'none' }}>联系我们</Link>
          </div>
        </div>
      </div>

      {/* 发送短信前置：点选人机验证 */}
      <ClickCaptcha
        visible={captchaVisible}
        purpose="register"
        onCancel={() => setCaptchaVisible(false)}
        onSuccess={(token) => {
          setCaptchaVisible(false)
          doSendCode(token)
        }}
      />
    </div>
  )
}

export default RegisterPage
