/**
 * NotificationsPage - 通知中心列表页
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Button, Tabs, Empty, Spin, Message } from '@arco-design/web-react'
import { IconNotification } from '@arco-design/web-react/icon'
import { notificationService } from '../../api/services'

interface NotificationItem {
  id: string
  type: string
  title: string
  content?: string
  link?: string
  is_read: boolean
  created_at?: string
}

const fmtTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : ''

const NotificationsPage: React.FC = () => {
  const navigate = useNavigate()
  const [items, setItems] = React.useState<NotificationItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [activeType, setActiveType] = React.useState<string>('all')

  const load = React.useCallback(async (type: string) => {
    setLoading(true)
    try {
      const params: any = { limit: 100 }
      if (type !== 'all') params.type = type
      const res: any = await notificationService.list(params)
      setItems(Array.isArray(res) ? res : res?.items || [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])

  React.useEffect(() => { load(activeType) }, [activeType, load])

  const handleClick = async (item: NotificationItem) => {
    if (!item.is_read) {
      try {
        await notificationService.markRead(item.id)
        setItems((l) => l.map((n) => (n.id === item.id ? { ...n, is_read: true } : n)))
      } catch { /* ignore */ }
    }
    if (item.link) navigate(item.link)
  }

  const handleReadAll = async () => {
    try {
      await notificationService.readAll()
      Message.success('已全部标记为已读')
      load(activeType)
    } catch { Message.error('操作失败') }
  }

  return (
    <Card
      title="通知中心"
      extra={
        <Button size="small" onClick={handleReadAll} disabled={!items.some((i) => !i.is_read)}>
          全部已读
        </Button>
      }
    >
      <Tabs activeTab={activeType} onChange={setActiveType} style={{ marginBottom: 12 }}>
        <Tabs.TabPane key="all" title="全部" />
        <Tabs.TabPane key="generation" title="生成任务" />
        <Tabs.TabPane key="recharge" title="充值" />
        <Tabs.TabPane key="invoice" title="发票" />
        <Tabs.TabPane key="system" title="系统" />
      </Tabs>

      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : items.length === 0 ? (
        <Empty icon={<IconNotification />} description="暂无通知" />
      ) : (
        <div>
          {items.map((item) => (
            <div
              key={item.id}
              onClick={() => handleClick(item)}
              style={{
                padding: '12px 16px', borderRadius: 6, cursor: 'pointer', marginBottom: 8,
                border: '1px solid var(--color-border)',
                background: item.is_read ? 'transparent' : 'var(--color-fill-1)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!item.is_read && (
                  <div style={{ width: 8, height: 8, borderRadius: 4, background: 'rgb(var(--danger-6))', flexShrink: 0 }} />
                )}
                <span style={{ fontWeight: item.is_read ? 400 : 600, fontSize: 14 }}>{item.title}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-4)' }}>
                  {fmtTime(item.created_at)}
                </span>
              </div>
              {item.content && (
                <div style={{ fontSize: 13, color: 'var(--color-text-3)', marginTop: 4 }}>{item.content}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

export default NotificationsPage
