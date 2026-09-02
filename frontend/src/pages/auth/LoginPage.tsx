/**
 * LoginPage - 登录页面
 *
 * 使用 Arco Design Form.useForm() 确保正确获取表单值
 * 登录后调 GET /auth/me 获取用户信息
 */
import React, { useState } from 'react'
import { Form, Input, Button, Typography, Checkbox, Message } from '@arco-design/web-react'
import { IconUser, IconLock } from '@arco-design/web-react/icon'
import { Link, useNavigate } from 'react-router-dom'
import { apiClient } from '@/api/client'
import { setAccessToken, saveUser } from '@/utils/auth'
import { useSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography

// 「记住密码」本地存储 key（与 token 体系分离，仅前端记忆账号密码）
const REMEMBER_KEY = 'remembered_credentials'

const LoginPage: React.FC = () => {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const navigate = useNavigate()
  const siteConfig = useSiteConfig()

  // 渲染前同步读取「记住的账号密码」——用 initialValues 声明式回填，
  // 避免 useEffect + setFieldsValue 的字段注册时序问题（Arco Form 字段在渲染后才注册，
  // 挂载时 setFieldsValue 会被静默丢弃）。
  const remembered = (() => {
    try {
      const raw = localStorage.getItem(REMEMBER_KEY)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  })()
  const [remember, setRemember] = useState<boolean>(!!remembered)

  const handleLogin = async (values: Record<string, any>) => {
    // 未勾选协议不允许登录
    if (!agreed) {
      Message.warning('请先阅读并同意《用户服务协议》与《隐私政策》')
      return
    }
    // 双保险：优先用 onSubmit 传的 values，后备用 form.getFieldsValue()
    const formValues = form.getFieldsValue()
    const email = values?.email || formValues?.email
    const password = values?.password || formValues?.password

    if (!email || !password) {
      Message.error('请输入邮箱和密码')
      return
    }

    setLoading(true)
    try {
      // apiClient.post 返回的是 response.data（响应拦截器已处理，即后端 body）
      const res: any = await apiClient.post('/auth/login', { email, password })

      // res 直接就是 TokenResponse: { access_token, refresh_token, token_type, expires_in }
      setAccessToken(res.access_token)
      localStorage.setItem('refresh_token', res.refresh_token)

      // 登录成功后获取用户信息
      const user: any = await apiClient.get('/auth/me')
      saveUser(user)

      // 「记住密码」：勾选则保存账号密码，否则清理旧记录
      if (remember) {
        localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email, password }))
      } else {
        localStorage.removeItem(REMEMBER_KEY)
      }

      Message.success('登录成功')
      navigate('/dashboard')
    } catch (error: any) {
      // 认证接口失败由页面自行展示后端返回的具体原因（拦截器不再统一处理 /auth/* 错误）
      const detail = error?.response?.data?.detail
      const status = error?.response?.status
      // 后端常见错误文案 → 中文友好提示
      const friendly: Record<string, string> = {
        'Invalid email or password': '邮箱或密码错误',
        'Account is disabled': '该账号已被禁用，请联系管理员',
      }
      const raw = typeof detail === 'string' ? detail : ''
      const msg = friendly[raw]
        || raw
        || (status === 401 ? '邮箱或密码错误' : '登录失败，请稍后重试')
      Message.error(msg)
      console.error('Login failed:', error)
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
        {/* 背景装饰 */}
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

        {/* 品牌内容 */}
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 380 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: '#fff', marginBottom: 36 }}>
            {siteConfig.site_name}
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#fff', lineHeight: 1.35, marginBottom: 14 }}>
            短剧生成工作台
          </h1>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', lineHeight: 1.65, marginBottom: 36 }}>
            从剧本到成片，一站式 AI 短剧制作流程管理
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {['智能分镜生成', '多模型资源管理', '@引用提示词编辑器', 'ComfyUI 工作流集成'].map((item) => (
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
          {/* 标题区 */}
          <div style={{ marginBottom: 32 }}>
            <Title heading={4} style={{ margin: 0, fontWeight: 600 }}>
              欢迎回来
            </Title>
            <Text type="secondary" style={{ marginTop: 6, fontSize: 14 }}>
              登录你的账号以继续
            </Text>
          </div>

          {/* 表单 —— 使用 Arco Form.useForm() 标准写法 */}
          <Form
            form={form}
            onSubmit={handleLogin}
            layout="vertical"
            requiredSymbol={false}
            size="large"
            initialValues={remembered ? { email: remembered.email, password: remembered.password } : undefined}
          >
            <Form.Item
              field="email"
              rules={[
                { required: true, message: '请输入邮箱地址' },
                { type: 'email', message: '请输入有效的邮箱地址' },
              ]}
            >
              <Input placeholder="name@company.com" prefix={<IconUser />} />
            </Form.Item>

            <Form.Item
              field="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password placeholder="输入密码" prefix={<IconLock />} />
            </Form.Item>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Checkbox checked={remember} onChange={setRemember}>记住密码</Checkbox>
              <Link to="/forgot" style={{ color: 'rgb(var(--primary-6))', fontSize: 13, textDecoration: 'none' }}>忘记密码？</Link>
            </div>

            <div style={{ marginBottom: 20 }}>
              <Checkbox checked={agreed} onChange={setAgreed} style={{ fontSize: 13 }}>
                我已阅读并同意
                <Link to="/terms" target="_blank" style={{ color: 'rgb(var(--primary-6))' }}>《用户服务协议》</Link>
                与
                <Link to="/privacy" target="_blank" style={{ color: 'rgb(var(--primary-6))' }}>《隐私政策》</Link>
              </Checkbox>
            </div>

            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" long loading={loading} size="large" disabled={!agreed}>
                登录
              </Button>
            </Form.Item>
          </Form>

          {/* 底部注册链接 */}
          {siteConfig.allow_register && (
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>还没有账号？</Text>{' '}
            <Link to="/register" style={{ color: 'rgb(var(--primary-6))', fontWeight: 500, fontSize: 13, textDecoration: 'none' }}>
              注册新账号
            </Link>
          </div>
          )}

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
    </div>
  )
}

export default LoginPage
