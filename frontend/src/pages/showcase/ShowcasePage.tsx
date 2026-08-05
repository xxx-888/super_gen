/**
 * ShowcasePage - 作品展示 (M6)
 *
 * 对标目标网站 work_showcase: 公开作品瀑布流画廊.
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Spin, Typography, Grid, Tag, Empty, Button, Space, Input, Message, Modal,
} from '@arco-design/web-react'
import { IconVideoCamera, IconHeart, IconEye, IconRefresh, IconSearch } from '@arco-design/web-react/icon'
import { showcaseService } from '@/api/services'

const { Title, Text } = Typography
const { Row, Col } = Grid

const ShowcasePage: React.FC = () => {
  const [works, setWorks] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<any>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await showcaseService.public({ page, page_size: 24, tag: search || undefined })
      const d = res?.data ?? res
      setWorks(d?.items ?? [])
      setTotal(d?.total ?? 0)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [page, search])

  useEffect(() => { load() }, [load])

  const handleLike = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const res: any = await showcaseService.like(id)
      const r = res?.data ?? res
      setWorks(ws => ws.map(w => w.id === id ? { ...w, like_count: r.like_count } : w))
    } catch { /* ignore */ }
  }

  const openDetail = async (id: string) => {
    try {
      const res: any = await showcaseService.get(id)
      setDetail(res?.data ?? res)
    } catch { /* ignore */ }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title heading={5} style={{ margin: 0 }}>作品展示</Title>
        <Space>
          <Input.Search placeholder="按标签搜索" style={{ width: 180 }} value={search} onChange={setSearch} onSearch={load} allowClear />
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
        </Space>
      </div>

      {loading ? <Spin dot style={{ display: 'block', margin: '60px auto' }} /> :
       works.length === 0 ? <Empty description="暂无公开作品" style={{ marginTop: 60 }} /> :
       <Row gutter={[16, 16]}>
         {works.map((w) => (
           <Col key={w.id} xs={12} sm={8} md={6} lg={4}>
             <Card
               size="small" hoverable
               onClick={() => openDetail(w.id)}
               cover={
                 <div style={{ aspectRatio: '3/4', background: 'var(--color-fill-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
                   {w.cover_url ? (
                     <img src={w.cover_url} alt={w.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                   ) : (
                     <IconVideoCamera style={{ fontSize: 36, color: 'var(--color-text-3)' }} />
                   )}
                   {/* 标题覆盖 */}
                   <div style={{
                     position: 'absolute', bottom: 0, left: 0, right: 0,
                     background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
                     padding: '20px 10px 8px', color: '#fff',
                   }}>
                     <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>{w.title}</div>
                   </div>
                 </div>
               }
             >
               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                 <Space size="small">
                   {w.tags?.slice(0, 2).map((t: string, i: number) => (
                     <Tag key={i} size="small" color="arcoblue">{t}</Tag>
                   ))}
                 </Space>
                 <Space size="small" style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
                   <span><IconHeart style={{ marginRight: 2 }} onClick={(e) => handleLike(w.id, e)} />{w.like_count}</span>
                   <span><IconEye style={{ marginRight: 2 }} />{w.view_count}</span>
                 </Space>
               </div>
             </Card>
           </Col>
         ))}
       </Row>
      }

      {/* 分页 */}
      {total > 24 && (
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Space>
            <Button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button>
            <Text type="secondary">第 {page} 页 / 共 {Math.ceil(total / 24)} 页 ({total})</Text>
            <Button disabled={page * 24 >= total} onClick={() => setPage(p => p + 1)}>下一页</Button>
          </Space>
        </div>
      )}

      {/* 详情弹窗 */}
      <Modal
        title={detail?.title}
        visible={!!detail}
        onCancel={() => setDetail(null)}
        footer={null}
        width={640}
      >
        {detail && (
          <div>
            <div style={{ aspectRatio: '16/9', background: 'var(--color-fill-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, marginBottom: 12 }}>
              <IconVideoCamera style={{ fontSize: 48, color: 'var(--color-text-3)' }} />
            </div>
            {detail.description && <Text>{detail.description}</Text>}
            <div style={{ marginTop: 12 }}>
              <Space>
                {detail.tags?.map((t: string, i: number) => <Tag key={i} color="arcoblue">{t}</Tag>)}
                <Text type="secondary">👍 {detail.like_count} · 👁 {detail.view_count}</Text>
              </Space>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default ShowcasePage
