/**
 * NotificationBell - 顶栏通知铃铛
 *
 * 未读数 30s 轮询; 下拉面板展示最近 8 条, 支持单条/全部已读与跳转。
 * 生成完成/失败、充值到账、发票审核结果都走同一通道。
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Dropdown, Spin, Message } from '@arco-design/web-react'
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

const TYPE_META: Record<string, { color: string; label: string }> = {
  generation: { color: 'rgb(var(--primary-6))', label: '生成' },
  recharge: { color: 'rgb(var(--warning-6))', label: '充值' },
  invoice: { color: 'rgb(var(--success-6))', label: '发票' },
  system: { color: 'var(--color-text-3)', label: '系统' },
}

const timeAgo = (iso?: string) => {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

const NotificationBell: React.FC = () => {
  const navigate = useNavigate()
  const [unread, setUnread] = React.useState(0)
  const [items, setItems] = React.useState<NotificationItem[]>([])
  const [loading, setLoading] = React.useState(false)

  const refreshCount = React.useCallback(async () => {
    try {
      const res: any = await notificationService.unreadCount()
      setUnread(res?.unread ?? 0)
    } catch { /* 静默: 未登录或网络抖动 */ }
  }, [])

  const refreshList = React.useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await notificationService.list({ limit: 8 })
      setItems(Array.isArray(res) ? res : res?.items || [])
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!localStorage.getItem('access_token')) return
    refreshCount()
    const timer = setInterval(refreshCount, 30_000)
    return () => clearInterval(timer)
  }, [refreshCount])

  const handleItemClick = async (item: NotificationItem) => {
    if (!item.is_read) {
      try {
        await notificationService.markRead(item.id)
        setUnread((u) => Math.max(0, u - 1))
        setItems((list) => list.map((n) => (n.id === item.id ? { ...n, is_read: true } : n)))
      } catch { /* ignore */ }
    }
    if (item.link) navigate(item.link)
  }

  const handleReadAll = async () => {
    try {
      await notificationService.readAll()
      setUnread(0)
      setItems((list) => list.map((n) => ({ ...n, is_read: true })))
      Message.success('已全部标记为已读')
    } catch { Message.error('操作失败') }
  }

  const panel = (
    <div
      style={{
        width: 360, background: 'var(--color-bg-1)', borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)', border: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 16px', borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span style={{ fontWeight: 600 }}>通知中心</span>
        <Button type="text" size="mini" onClick={handleReadAll} disabled={unread === 0}>
          全部已读
        </Button>
      </div>
      <div style={{ maxHeight: 380, overflowY: 'auto' }}>
        {loading && items.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
        ) : items.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-3)' }}>
            <IconNotification style={{ fontSize: 28, marginBottom: 8 }} />
            <div>暂无通知</div>
          </div>
        ) : (
          items.map((item) => {
            const meta = TYPE_META[item.type] || TYPE_META.system
            return (
              <div
                key={item.id}
                onClick={() => handleItemClick(item)}
                style={{
                  padding: '10px 16px', cursor: 'pointer', display: 'flex', gap: 10,
                  borderBottom: '1px solid var(--color-border-2)',
                  background: item.is_read ? 'transparent' : 'var(--color-fill-1)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-fill-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = item.is_read ? 'transparent' : 'var(--color-fill-1)')}
              >
                <div style={{
                  flexShrink: 0, marginTop: 3, fontSize: 11, padding: '0 6px',
                  height: 18, lineHeight: '18px', borderRadius: 9,
                  color: meta.color, background: 'var(--color-fill-2)',
                }}>{meta.label}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 13, fontWeight: item.is_read ? 400 : 600,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{item.title}</div>
                  {item.content && (
                    <div style={{
                      fontSize: 12, color: 'var(--color-text-3)', marginTop: 2,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{item.content}</div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--color-text-4)', marginTop: 2 }}>{timeAgo(item.created_at)}</div>
                </div>
                {!item.is_read && (
                  <div style={{ width: 8, height: 8, borderRadius: 4, background: 'rgb(var(--danger-6))', marginTop: 6, flexShrink: 0 }} />
                )}
              </div>
            )
          })
        )}
      </div>
      <div
        style={{ textAlign: 'center', padding: 8, fontSize: 12, cursor: 'pointer', color: 'var(--color-text-3)' }}
        onClick={() => navigate('/notifications')}
      >
        查看全部通知
      </div>
    </div>
  )

  return (
    <Dropdown
      droplist={panel}
      position="br"
      trigger="click"
      popupVisible={undefined}
      onVisibleChange={(v) => { if (v) refreshList() }}
    >
      <Badge count={unread} maxCount={99}>
        <Button type="text" icon={<IconNotification />} className="header-icon-btn" />
      </Badge>
    </Dropdown>
  )
}

export default NotificationBell
