/**
 * ProjectJoinPage - 通过邀请链接加入项目
 *
 * 访问 /projects/join?token=xxx 时展示此页：
 * 1. 先调 GET /projects/join?token=xxx 查项目信息
 * 2. 若需密码，输入密码
 * 3. 点"加入项目"调 POST /projects/join 完成加入
 * 4. 加入成功跳转到项目详情
 *
 * 未登录时提示先登录。
 */
import React, { useEffect, useState } from 'react'
import { Card, Spin, Input, Button, Message, Typography, Empty, Tag } from '@arco-design/web-react'
import { IconLock, IconUserGroup, IconCheckCircle } from '@arco-design/web-react/icon'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { projectService } from '@/api/services'

const { Title, Text } = Typography

const ProjectJoinPage: React.FC = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') || ''

  const [loading, setLoading] = useState(true)
  const [info, setInfo] = useState<any>(null)
  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [joining, setJoining] = useState(false)
  const [joined, setJoined] = useState(false)

  // 登录状态
  const isLoggedIn = !!localStorage.getItem('access_token')

  useEffect(() => {
    if (!token) { setError('缺少邀请 token'); setLoading(false); return }
    loadInfo()
  }, [token])

  const loadInfo = async () => {
    setLoading(true)
    try {
      const res: any = await projectService.getJoinInfo(token)
      const r = res?.data ?? res
      setInfo(r)
    } catch (e: any) {
      setError(e?.response?.data?.detail || '邀请链接无效或已失效')
    } finally {
      setLoading(false)
    }
  }

  const handleJoin = async () => {
    setJoining(true)
    try {
      const res: any = await projectService.joinByInvite(token, password)
      const r = res?.data ?? res
      Message.success(`已加入项目：${r.project_name}`)
      setJoined(true)
      // 2 秒后跳转
      setTimeout(() => navigate(`/projects/${r.project_id}`), 1500)
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      if (typeof detail === 'string' && detail.includes('已是')) {
        Message.info('你已是该项目成员，即将跳转')
        setJoined(true)
        setTimeout(() => navigate(`/projects/${info?.project_id}`), 1500)
      } else {
        Message.error(detail || '加入失败')
      }
    } finally {
      setJoining(false)
    }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} tip="加载中..." /></div>

  // 未登录
  if (!isLoggedIn) {
    return (
      <div style={{ maxWidth: 480, margin: '60px auto' }}>
        <Card>
          <Empty description="请先登录后再加入项目" />
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Button type="primary" onClick={() => navigate(`/login?redirect=/projects/join?token=${token}`)}>
              去登录
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  // 错误（token 无效）
  if (error) {
    return (
      <div style={{ maxWidth: 480, margin: '60px auto' }}>
        <Card>
          <Empty description={error} />
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Button onClick={() => navigate('/projects')}>返回项目列表</Button>
          </div>
        </Card>
      </div>
    )
  }

  // 加入成功
  if (joined) {
    return (
      <div style={{ maxWidth: 480, margin: '60px auto' }}>
        <Card>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <IconCheckCircle style={{ fontSize: 56, color: 'rgb(var(--success-6))' }} />
            <Title heading={4} style={{ marginTop: 16 }}>加入成功！</Title>
            <Text type="secondary">即将跳转到项目「{info?.project_name}」...</Text>
          </div>
        </Card>
      </div>
    )
  }

  // 展示项目信息 + 加入按钮
  return (
    <div style={{ maxWidth: 480, margin: '60px auto' }}>
      <Card>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <IconUserGroup style={{ fontSize: 48, color: 'rgb(var(--primary-6))' }} />
          <Title heading={4} style={{ marginTop: 12 }}>加入项目</Title>
        </div>

        <div style={{ background: 'var(--color-fill-2)', padding: 16, borderRadius: 8, marginBottom: 16 }}>
          <Text style={{ fontSize: 18, fontWeight: 600 }}>{info?.project_name}</Text>
          <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 13 }}>
            {info?.description || '暂无描述'}
          </Text>
          {info?.has_password && (
            <Tag color="orange" size="small" style={{ marginTop: 8 }}>
              <IconLock /> 需要访问密码
            </Tag>
          )}
        </div>

        {info?.has_password && (
          <div style={{ marginBottom: 16 }}>
            <Text style={{ display: 'block', marginBottom: 6 }}>访问密码</Text>
            <Input.Password
              value={password}
              onChange={setPassword}
              placeholder="请输入访问密码"
              onPressEnter={handleJoin}
            />
          </div>
        )}

        <Button type="primary" long size="large" loading={joining} onClick={handleJoin}>
          加入项目
        </Button>
        <Button long type="text" style={{ marginTop: 8 }} onClick={() => navigate('/projects')}>
          取消
        </Button>
      </Card>
    </div>
  )
}

export default ProjectJoinPage
