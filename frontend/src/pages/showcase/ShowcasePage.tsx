/**
 * ShowcasePage - 作品展示 (M6)
 *
 * 对标目标网站 work_showcase: 公开作品瀑布流画廊.
 * - 公开画廊: 详情弹窗直接播放 video_url (无视频时回退封面/占位)
 * - 点赞需登录, 同一作品重复点击为「点赞/取消」切换, 已赞时红心高亮
 * - 我的作品(登录后可见): 管理自己发布的作品 — 编辑/上架/下架/删除
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Spin, Typography, Grid, Tag, Empty, Button, Space, Input, Message, Modal,
  Tabs, Form, Popconfirm, Switch, Select, Pagination,
} from '@arco-design/web-react'
import {
  IconVideoCamera, IconHeart, IconEye, IconRefresh, IconSearch,
  IconEdit, IconDelete, IconUpload, IconDownload,
} from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { showcaseService, workbenchService } from '@/api/services'
import { useCurrentUser } from '@/utils/auth'

const { Title, Text } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

const ShowcasePage: React.FC = () => {
  const [tab, setTab] = useState<string>('public')
  const [works, setWorks] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')          // 标签搜索（沿用）
  const [titleSearch, setTitleSearch] = useState('') // 标题/描述搜索（新）
  const [sortBy, setSortBy] = useState('latest')
  const [detail, setDetail] = useState<any>(null)
  const [liking, setLiking] = useState<Set<string>>(new Set())
  const navigate = useNavigate()
  const user = useCurrentUser()

  // 我的作品: 编辑弹窗
  const [myWorks, setMyWorks] = useState<any[]>([])
  const [myLoading, setMyLoading] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await showcaseService.public({
        page, page_size: 24,
        tag: search || undefined,
        search: titleSearch || undefined,
        sort: sortBy,
      })
      const d = res?.data ?? res
      setWorks(d?.items ?? [])
      setTotal(d?.total ?? 0)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [page, search, titleSearch, sortBy])

  const loadMyWorks = useCallback(async () => {
    if (!user) return
    setMyLoading(true)
    try {
      const res: any = await workbenchService.myWorks()
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setMyWorks(Array.isArray(list) ? list : [])
    } catch { /* ignore */ } finally { setMyLoading(false) }
  }, [user])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === 'mine') loadMyWorks() }, [tab, loadMyWorks])

  // 点赞/取消点赞: 后端按 work_likes 记录切换, 返回最新 { like_count, liked }
  const applyLike = (id: string, likeCount: number, liked: boolean) => {
    setWorks(ws => ws.map(w => w.id === id ? { ...w, like_count: likeCount, liked_by_me: liked } : w))
    setDetail((d: any) => (d && d.id === id ? { ...d, like_count: likeCount, liked_by_me: liked } : d))
  }

  const handleLike = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!user) {
      Message.warning('请先登录后再点赞')
      navigate('/login')
      return
    }
    if (liking.has(id)) return  // 防双击抖动
    setLiking(s => new Set(s).add(id))
    try {
      const res: any = await showcaseService.like(id)
      const r = res?.data ?? res
      applyLike(id, r.like_count, !!r.liked)
    } catch { /* ignore */ } finally {
      setLiking(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  const openDetail = async (id: string) => {
    try {
      const res: any = await showcaseService.get(id)
      setDetail(res?.data ?? res)
    } catch { /* ignore */ }
  }

  // ===== 我的作品管理 =====
  const openEdit = (w: any) => {
    setEditing(w)
    form.resetFields()
    form.setFieldsValue({
      title: w.title,
      description: w.description || '',
      tags: w.tags || [],
      cover_url: w.cover_url || '',
      is_public: !!w.is_public,
    })
  }

  const handleSave = async () => {
    if (!editing) return
    try {
      const v = await form.validate()
      setSaving(true)
      await showcaseService.update(editing.id, {
        title: v.title?.trim(),
        description: v.description?.trim() || null,
        tags: (v.tags || []).filter(Boolean),
        cover_url: v.cover_url?.trim() || null,
        is_public: !!v.is_public,
      })
      Message.success('保存成功')
      setEditing(null)
      loadMyWorks()
      load()  // 上下架状态变化会同步影响公开画廊
    } catch (err: any) {
      if (err?.errors) return  // API 错误由 axios 拦截器统一提示
    } finally {
      setSaving(false)
    }
  }

  const handleTogglePublic = async (w: any) => {
    try {
      await showcaseService.update(w.id, { is_public: !w.is_public })
      Message.success(w.is_public ? '已下架' : '已上架')
      loadMyWorks()
      load()
    } catch { /* 拦截器统一提示 */ }
  }

  const handleDelete = async (id: string) => {
    try {
      await showcaseService.delete(id)
      Message.success('删除成功')
      loadMyWorks()
      load()
    } catch { /* 拦截器统一提示 */ }
  }

  const heartStyle = (liked: boolean): React.CSSProperties => ({
    marginRight: 2,
    cursor: 'pointer',
    color: liked ? 'rgb(var(--danger-6))' : undefined,
  })

  const renderCover = (w: any) => (
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
  )

  return (
    <div>
      <Tabs activeTab={tab} onChange={setTab} style={{ marginBottom: 8 }}>
        <TabPane key="public" title={<span><IconVideoCamera /> 公开画廊</span>} />
        {user && <TabPane key="mine" title={<span><IconEdit /> 我的作品</span>} />}
      </Tabs>

      {tab === 'public' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
            <Title heading={5} style={{ margin: 0 }}>作品展示{total ? <Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>（{total} 部）</Text> : null}</Title>
            <Space size={8} wrap>
              <Input
                placeholder="搜索标题 / 描述"
                style={{ width: 180 }}
                value={titleSearch}
                onChange={setTitleSearch}
                allowClear
                prefix={<IconSearch />}
                onPressEnter={() => { setPage(1); load() }}
                onClear={() => { setTitleSearch(''); setPage(1); setTimeout(load, 0) }}
              />
              <Input.Search placeholder="按标签筛选" style={{ width: 150 }} value={search} onChange={setSearch} onSearch={() => { setPage(1); load() }} allowClear />
              <Select value={sortBy} style={{ width: 110 }} onChange={(v) => { setSortBy(v); setPage(1) }}>
                <Select.Option value="latest">最新发布</Select.Option>
                <Select.Option value="likes">最多点赞</Select.Option>
                <Select.Option value="views">最多浏览</Select.Option>
              </Select>
              <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
            </Space>
          </div>

          {loading ? <Spin dot style={{ display: 'block', margin: '60px auto' }} /> :
           works.length === 0 ? <Empty description="暂无公开作品" style={{ marginTop: 60 }} /> :
           <Row gutter={[16, 16]}>
             {works.map((w) => (
               <Col key={w.id} xs={12} sm={8} md={6} lg={4}>
                 <Card size="small" hoverable onClick={() => openDetail(w.id)} cover={renderCover(w)}>
                   <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                     <Space size="small">
                       {w.tags?.slice(0, 2).map((t: string, i: number) => (
                         <Tag key={i} size="small" color="arcoblue">{t}</Tag>
                       ))}
                     </Space>
                     <Space size="small" style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
                       <span><IconHeart style={heartStyle(!!w.liked_by_me)} onClick={(e) => handleLike(w.id, e)} />{w.like_count}</span>
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
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
              <Pagination
                current={page}
                pageSize={24}
                total={total}
                showTotal
                showJumper
                onChange={(p: number) => setPage(p)}
              />
            </div>
          )}
        </>
      )}

      {tab === 'mine' && user && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <Title heading={5} style={{ margin: 0 }}>我的作品 <Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>共 {myWorks.length} 个</Text></Title>
            <Button icon={<IconRefresh />} onClick={loadMyWorks}>刷新</Button>
          </div>

          {myLoading ? <Spin dot style={{ display: 'block', margin: '60px auto' }} /> :
           myWorks.length === 0 ? <Empty description="还没有发布过作品——可在片段管理、视频预览或画布中发布成片" style={{ marginTop: 60 }} /> :
           <Row gutter={[16, 16]}>
             {myWorks.map((w) => (
               <Col key={w.id} xs={12} sm={8} md={6} lg={4}>
                 <Card
                   size="small" hoverable
                   cover={renderCover(w)}
                 >
                   <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                     <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                       <Space size="small">
                         {w.is_public
                           ? <Tag size="small" color="green">已上架</Tag>
                           : <Tag size="small" color="gray">已下架</Tag>}
                         {w.tags?.slice(0, 1).map((t: string, i: number) => (
                           <Tag key={i} size="small" color="arcoblue">{t}</Tag>
                         ))}
                       </Space>
                       <Space size="small" style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
                         <span><IconHeart style={{ marginRight: 2 }} />{w.like_count}</span>
                         <span><IconEye style={{ marginRight: 2 }} />{w.view_count}</span>
                       </Space>
                     </div>
                     <Space size={4}>
                       <Button size="mini" type="text" icon={<IconEdit />} onClick={() => openEdit(w)}>编辑</Button>
                       <Popconfirm
                         title={w.is_public ? '确认下架？下架后画廊不再显示。' : '确认上架到公开画廊？'}
                         onOk={() => handleTogglePublic(w)}
                       >
                         <Button size="mini" type="text" icon={w.is_public ? <IconDownload /> : <IconUpload />}>
                           {w.is_public ? '下架' : '上架'}
                         </Button>
                       </Popconfirm>
                       <Popconfirm title="确认删除该作品？不可恢复。" onOk={() => handleDelete(w.id)}>
                         <Button size="mini" type="text" status="danger" icon={<IconDelete />}>删除</Button>
                       </Popconfirm>
                     </Space>
                   </div>
                 </Card>
               </Col>
             ))}
           </Row>
          }
        </>
      )}

      {/* 详情弹窗: 有视频直接播放 */}
      <Modal
        title={detail?.title}
        visible={!!detail}
        onCancel={() => setDetail(null)}
        footer={null}
        style={{ width: 720, maxWidth: '92vw' }}
        unmountOnExit
      >
        {detail && (
          <div>
            {detail.video_url ? (
              <video
                key={detail.id}
                src={detail.video_url}
                poster={detail.cover_url || undefined}
                controls
                playsInline
                preload="metadata"
                style={{ width: '100%', aspectRatio: '16/9', background: '#000', borderRadius: 8, marginBottom: 12, display: 'block' }}
              />
            ) : (
              <div style={{ aspectRatio: '16/9', background: 'var(--color-fill-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
                {detail.cover_url ? (
                  <img src={detail.cover_url} alt={detail.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <IconVideoCamera style={{ fontSize: 48, color: 'var(--color-text-3)' }} />
                )}
              </div>
            )}
            {detail.description && <Text>{detail.description}</Text>}
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Space>
                {detail.tags?.map((t: string, i: number) => <Tag key={i} color="arcoblue">{t}</Tag>)}
              </Space>
              <Space size="large" style={{ fontSize: 13, color: 'var(--color-text-3)' }}>
                <span style={{ cursor: 'pointer' }} onClick={(e) => handleLike(detail.id, e)}>
                  <IconHeart style={heartStyle(!!detail.liked_by_me)} />{detail.like_count}
                </span>
                <span><IconEye style={{ marginRight: 2 }} />{detail.view_count}</span>
              </Space>
            </div>
          </div>
        )}
      </Modal>

      {/* 我的作品编辑弹窗 */}
      <Modal
        title={`编辑作品：${editing?.title || ''}`}
        visible={!!editing}
        onCancel={() => setEditing(null)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        style={{ width: 520, maxWidth: '92vw' }}
      >
        <Form form={form} layout="vertical">
          <Form.Item field="title" label="标题" rules={[{ required: true, message: '请填写标题' }]}>
            <Input maxLength={100} allowClear />
          </Form.Item>
          <Form.Item field="description" label="描述">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={500} />
          </Form.Item>
          <Form.Item field="tags" label="标签">
            <Select mode="tags" placeholder="输入后回车添加" allowClear allowCreate />
          </Form.Item>
          <Form.Item field="cover_url" label="封面图 URL">
            <Input placeholder="https://..." allowClear />
          </Form.Item>
          <Form.Item field="is_public" label="上架到公开画廊" triggerPropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ShowcasePage
