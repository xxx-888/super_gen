/**
 * AdminWorksPage - 画廊作品管理
 *
 * 统计卡 + 搜索/状态筛选/排序 + 批量上下架/删除 + 富详情抽屉 + 视频预览。
 * 删除会级联清理点赞记录(work_likes)。
 */
import React, { useEffect, useState, useCallback } from 'react'
import { Card, Button, Table, Tag, Space, Spin, Input, Select, Message, Popconfirm, Modal, Typography, Grid, Statistic, Drawer, Descriptions } from '@arco-design/web-react'
import { IconRefresh, IconSearch, IconEye, IconDelete, IconVideoCamera, IconCheck, IconClose, IconPlus, IconThumbUp, IconExclamationCircle } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text } = Typography
const { Row, Col } = Grid

const SOURCE_LABEL: Record<string, string> = {
  episode: '集成成片', scene: '分镜视频', manual: '手动上传', canvas: '画布输出',
}

/** 统计卡 */
const StatCard = ({ title, value, icon, sub }: { title: string; value: React.ReactNode; icon?: React.ReactNode; sub?: string }) => (
  <Card style={{ marginBottom: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {icon}
      <Text type="secondary" style={{ fontSize: 13 }}>{title}</Text>
    </div>
    <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8, lineHeight: 1.2 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{sub}</div>}
  </Card>
)

const AdminWorksPage: React.FC = () => {
  const [works, setWorks] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<any>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(15)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [publicFilter, setPublicFilter] = useState<string>('')
  const [sort, setSort] = useState('created_at')
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [preview, setPreview] = useState<any>(null)
  const [detail, setDetail] = useState<any>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { page, page_size: pageSize, sort }
      if (search) params.search = search
      if (publicFilter !== '') params.is_public = publicFilter === 'public'
      const res: any = await adminService.works.list(params)
      const d = res?.data ?? res
      setWorks(d?.items ?? [])
      setTotal(d?.total ?? 0)
      setSummary(d?.summary ?? null)
    } catch {
      setWorks([])
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, publicFilter, sort])

  useEffect(() => { load() }, [load])

  const handleVisibility = async (row: any, isPublic: boolean) => {
    try {
      await adminService.works.setVisibility(row.id, isPublic)
      Message.success(isPublic ? '已上架' : '已下架')
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '操作失败')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await adminService.works.remove(id)
      Message.success('删除成功')
      if (detail?.id === id) setDetail(null)
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  // 批量上下架 / 批量删除
  const handleBatchVisibility = async (isPublic: boolean) => {
    if (!selectedKeys.length) return
    try {
      const res: any = await adminService.works.batchVisibility(selectedKeys, isPublic)
      Message.success(res?.message || '操作成功')
      setSelectedKeys([])
      load()
    } catch { Message.error('批量操作失败') }
  }
  const handleBatchDelete = async () => {
    if (!selectedKeys.length) return
    try {
      const res: any = await adminService.works.batchDelete(selectedKeys)
      Message.success(res?.message || '删除成功')
      setSelectedKeys([])
      setDetail(null)
      load()
    } catch { Message.error('批量删除失败') }
  }

  const columns = [
    {
      title: '作品', dataIndex: 'title', width: 260,
      render: (_: any, row: any) => (
        <Space>
          <div
            style={{ width: 48, height: 64, borderRadius: 4, overflow: 'hidden', background: 'var(--color-fill-3)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); setDetail(row) }}
          >
            {row.cover_url
              ? <img src={row.cover_url} alt={row.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <IconVideoCamera style={{ color: 'var(--color-text-3)' }} />}
          </div>
          <div>
            <div style={{ fontWeight: 600, cursor: 'pointer' }} onClick={() => setDetail(row)}>{row.title}</div>
            {row.video_url
              ? <a onClick={(e) => { e.stopPropagation(); setPreview(row) }} style={{ fontSize: 12 }}>预览视频</a>
              : <Text type="secondary" style={{ fontSize: 12 }}>无视频</Text>}
          </div>
        </Space>
      ),
    },
    {
      title: '作者', dataIndex: 'author', width: 150, ellipsis: true,
      render: (v: any) => v ? (v.nickname || v.email) : <Text type="secondary">未知</Text>,
    },
    {
      title: '状态', dataIndex: 'is_public', width: 90, align: 'center' as const,
      render: (v: boolean) => v
        ? <Tag color="green" icon={<IconCheck />}>已上架</Tag>
        : <Tag color="gray" icon={<IconClose />}>已下架</Tag>,
    },
    { title: '点赞', dataIndex: 'like_count', width: 70, align: 'center' as const, render: (v: number) => v ? <Text>{v}</Text> : <Text type="secondary">0</Text> },
    { title: '浏览', dataIndex: 'view_count', width: 70, align: 'center' as const, render: (v: number) => v ? <Text>{v}</Text> : <Text type="secondary">0</Text> },
    {
      title: '标签', dataIndex: 'tags', width: 150, ellipsis: true,
      render: (v: string[]) => v?.length
        ? <Space size={4} wrap>{v.slice(0, 3).map((t, i) => <Tag key={i} size="small" color="arcoblue">{t}</Tag>)}</Space>
        : <Text type="secondary">-</Text>,
    },
    {
      title: '发布时间', dataIndex: 'published_at', width: 140,
      render: (v: string) => v
        ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>
        : <Text type="secondary">未发布</Text>,
    },
    {
      title: '操作', width: 140, fixed: 'right' as const, render: (_: any, row: any) => (
        <Space size={4}>
          {row.video_url && (
            <Button size="mini" type="text" icon={<IconEye />} title="预览视频" onClick={() => setPreview(row)} />
          )}
          <Button size="mini" type="text" icon={<IconExclamationCircle />} title="作品详情" onClick={() => setDetail(row)} />
          {row.is_public ? (
            <Popconfirm title="确认下架该作品？下架后画廊不再显示。" onOk={() => handleVisibility(row, false)}>
              <Button size="mini" type="text" status="warning" title="下架">下架</Button>
            </Popconfirm>
          ) : (
            <Button size="mini" type="text" status="success" title="上架" onClick={() => handleVisibility(row, true)}>上架</Button>
          )}
          <Popconfirm title="确认删除该作品？点赞记录将一并删除，不可恢复。" onOk={() => handleDelete(row.id)}>
            <Button size="mini" type="text" status="danger" icon={<IconDelete />} title="删除" />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      {/* 汇总统计卡（后端全量口径） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><StatCard title="总作品数" value={summary?.total ?? '-'} icon={<IconVideoCamera style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />} /></Col>
        <Col span={6}><StatCard title="上架中" value={summary?.public ?? '-'} icon={<IconCheck style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />} sub={`下架 ${(summary?.total ?? 0) - (summary?.public ?? 0)} 部`} /></Col>
        <Col span={6}><StatCard title="今日新增" value={summary?.today_new ?? '-'} icon={<IconPlus style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />} /></Col>
        <Col span={6}><StatCard title="累计获赞" value={summary?.total_likes ?? '-'} icon={<IconThumbUp style={{ fontSize: 22, color: 'rgb(var(--red-6))' }} />} /></Col>
      </Row>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <Title heading={5} style={{ margin: 0 }}>画廊作品管理</Title>
        <Space size={8} wrap>
          <Input
            placeholder="按标题搜索"
            style={{ width: 190 }}
            value={search}
            onChange={setSearch}
            onPressEnter={() => { setPage(1); load() }}
            allowClear
            prefix={<IconSearch />}
            onClear={() => { setSearch(''); setPage(1); load() }}
          />
          <Select
            value={publicFilter === '' ? undefined : publicFilter}
            onChange={(v) => { setPublicFilter(v || ''); setPage(1) }}
            placeholder="全部状态"
            style={{ width: 110 }}
            allowClear
          >
            <Select.Option value="public">已上架</Select.Option>
            <Select.Option value="private">已下架</Select.Option>
          </Select>
          <Select
            value={sort}
            onChange={(v) => { setSort(v); setPage(1) }}
            style={{ width: 120 }}
          >
            <Select.Option value="created_at">按创建时间</Select.Option>
            <Select.Option value="published_at">按发布时间</Select.Option>
            <Select.Option value="like_count">按点赞数</Select.Option>
            <Select.Option value="view_count">按浏览量</Select.Option>
          </Select>
          <Popconfirm title={`确认批量上架选中的 ${selectedKeys.length} 部作品？`} disabled={!selectedKeys.length} onOk={() => handleBatchVisibility(true)}>
            <Button status="success" disabled={!selectedKeys.length}>批量上架{selectedKeys.length ? `(${selectedKeys.length})` : ''}</Button>
          </Popconfirm>
          <Popconfirm title={`确认批量下架选中的 ${selectedKeys.length} 部作品？`} disabled={!selectedKeys.length} onOk={() => handleBatchVisibility(false)}>
            <Button status="warning" disabled={!selectedKeys.length}>批量下架{selectedKeys.length ? `(${selectedKeys.length})` : ''}</Button>
          </Popconfirm>
          <Popconfirm title={`确认批量删除选中的 ${selectedKeys.length} 部作品？不可恢复。`} disabled={!selectedKeys.length} onOk={handleBatchDelete}>
            <Button status="danger" icon={<IconDelete />} disabled={!selectedKeys.length}>批量删除</Button>
          </Popconfirm>
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
        </Space>
      </div>

      <Card>
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : (
          <Table
            columns={columns}
            data={works}
            rowKey="id"
            scroll={{ x: 1200 }}
            rowSelection={{
              selectedRowKeys: selectedKeys,
              onChange: (keys: (string | number)[]) => setSelectedKeys(keys.map(String)),
            }}
            pagination={{
              current: page,
              pageSize,
              total,
              showTotal: true,
              showJumper: true,
              sizeCanChange: true,
              sizeOptions: [10, 15, 30, 50],
              onChange: (p: number, ps?: number) => {
                setPage(p)
                if (ps && ps !== pageSize) setPageSize(ps)
              },
            }}
          />
        )}
      </Card>

      {/* 作品详情抽屉 */}
      <Drawer
        title={`作品详情 · ${detail?.title || ''}`} width={560}
        visible={!!detail} onCancel={() => setDetail(null)}
        footer={null}
      >
        {detail && (
          <>
            {/* 封面大图 */}
            {detail.cover_url && (
              <div style={{ borderRadius: 8, overflow: 'hidden', marginBottom: 12, background: '#000' }}>
                <img src={detail.cover_url} alt={detail.title} style={{ width: '100%', maxHeight: 260, objectFit: 'cover', display: 'block' }} />
              </div>
            )}
            {detail.video_url && (
              <video
                src={detail.video_url} poster={detail.cover_url || undefined} controls playsInline preload="metadata"
                style={{ width: '100%', aspectRatio: '16/9', background: '#000', borderRadius: 8, display: 'block', marginBottom: 12 }}
              />
            )}
            <Descriptions column={2} data={[
              { label: '作者', value: detail.author ? (detail.author.nickname || detail.author.email) : '未知' },
              { label: '来源', value: SOURCE_LABEL[detail.source_type] || detail.source_type || '-' },
              { label: '状态', value: detail.is_public ? <Tag color="green">已上架</Tag> : <Tag color="gray">已下架</Tag> },
              { label: '发布时间', value: detail.published_at ? new Date(detail.published_at).toLocaleString('zh-CN') : '未发布' },
              { label: '点赞', value: detail.like_count ?? 0 },
              { label: '浏览', value: detail.view_count ?? 0 },
              { label: '创建时间', value: detail.created_at ? new Date(detail.created_at).toLocaleString('zh-CN') : '-', span: 2 },
            ]} />
            {detail.description && (
              <>
                <Title heading={6} style={{ margin: '14px 0 6px' }}>作品描述</Title>
                <div style={{ fontSize: 13, color: 'var(--color-text-2)', whiteSpace: 'pre-wrap' }}>{detail.description}</div>
              </>
            )}
            {detail.tags?.length > 0 && (
              <>
                <Title heading={6} style={{ margin: '14px 0 6px' }}>标签</Title>
                <Space size={6} wrap>
                  {detail.tags.map((t: string, i: number) => <Tag key={i} color="arcoblue">{t}</Tag>)}
                </Space>
              </>
            )}
          </>
        )}
      </Drawer>

      {/* 视频预览 */}
      <Modal
        title={preview?.title}
        visible={!!preview}
        onCancel={() => setPreview(null)}
        footer={null}
        style={{ width: 720, maxWidth: '92vw' }}
        unmountOnExit
      >
        {preview?.video_url && (
          <video
            key={preview.id}
            src={preview.video_url}
            poster={preview.cover_url || undefined}
            controls
            playsInline
            preload="metadata"
            style={{ width: '100%', aspectRatio: '16/9', background: '#000', borderRadius: 8, display: 'block' }}
          />
        )}
      </Modal>
    </div>
  )
}

export default AdminWorksPage
