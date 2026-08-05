/**
 * RegisterPage - 注册页面
 *
 * 字段对齐后端 UserCreate: email + nickname + password(min 8)
 * 使用 Arco Form.useForm() 确保正确获取表单值
 */
import React, { useState } from 'react'
import { Form, Input, Button, Typography, Message } from '@arco-design/web-react'
import { IconUser, IconLock, IconEmail } from '@arco-design/web-react/icon'
import { Link, useNavigate } from 'react-router-dom'
import { apiClient } from '@/api/client'
import { setAccessToken, saveUser } from '@/utils/auth'
import { useSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography

const RegisterPage: React.FC = () => {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const siteConfig = useSiteConfig()

  const handleRegister = async (values: Record<string, any>) => {
    // 双保险：优先用 onSubmit 传的 values，后备用 form.getFieldsValue()
    const formValues = form.getFieldsValue()
    const email = values?.email || formValues?.email
    const password = values?.password || formValues?.password
    const nickname = values?.nickname || formValues?.nickname

    if (!email || !password || !nickname) {
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

            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" long loading={loading} size="large">
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
        </div>
      </div>
    </div>
  )
}

export default RegisterPage
