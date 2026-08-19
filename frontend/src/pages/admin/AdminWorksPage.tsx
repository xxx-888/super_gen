/**
 * AdminWorksPage - 画廊作品管理
 *
 * 管理公开画廊的作品：搜索/按状态筛选、视频预览、上架/下架、删除。
 * 删除会级联清理点赞记录(work_likes)。
 */
import React, { useEffect, useState, useCallback } from 'react'
import { Card, Button, Table, Tag, Space, Spin, Input, Select, Message, Popconfirm, Modal, Typography } from '@arco-design/web-react'
import { IconRefresh, IconSearch, IconEye, IconDelete, IconVideoCamera, IconCheck, IconClose } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text } = Typography

const AdminWorksPage: React.FC = () => {
  const [works, setWorks] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(15)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [publicFilter, setPublicFilter] = useState<string>('')
  const [preview, setPreview] = useState<any>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { page, page_size: pageSize }
      if (search) params.search = search
      if (publicFilter !== '') params.is_public = publicFilter === 'public'
      const res: any = await adminService.works.list(params)
      const d = res?.data ?? res
      setWorks(d?.items ?? [])
      setTotal(d?.total ?? 0)
    } catch {
      setWorks([])
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, publicFilter])

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
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  const columns = [
    {
      title: '作品', dataIndex: 'title', width: 280,
      render: (_: any, row: any) => (
        <Space>
          <div style={{ width: 48, height: 64, borderRadius: 4, overflow: 'hidden', background: 'var(--color-fill-3)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {row.cover_url
              ? <img src={row.cover_url} alt={row.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <IconVideoCamera style={{ color: 'var(--color-text-3)' }} />}
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>{row.title}</div>
            {row.video_url
              ? <a onClick={(e) => { e.stopPropagation(); setPreview(row) }} style={{ fontSize: 12 }}>预览视频</a>
              : <Text type="secondary" style={{ fontSize: 12 }}>无视频</Text>}
          </div>
        </Space>
      ),
    },
    {
      title: '作者', dataIndex: 'author', width: 180, ellipsis: true,
      render: (v: any) => v ? (v.nickname || v.email) : <Text type="secondary">未知</Text>,
    },
    {
      title: '状态', dataIndex: 'is_public', width: 90, align: 'center' as const,
      render: (v: boolean) => v
        ? <Tag color="green" icon={<IconCheck />}>已上架</Tag>
        : <Tag color="gray" icon={<IconClose />}>已下架</Tag>,
    },
    { title: '点赞', dataIndex: 'like_count', width: 80, align: 'center' as const },
    { title: '浏览', dataIndex: 'view_count', width: 80, align: 'center' as const },
    {
      title: '标签', dataIndex: 'tags', width: 160, ellipsis: true,
      render: (v: string[]) => v?.length
        ? <Space size={4} wrap>{v.slice(0, 3).map((t, i) => <Tag key={i} size="small" color="arcoblue">{t}</Tag>)}</Space>
        : <Text type="secondary">-</Text>,
    },
    {
      title: '发布时间', dataIndex: 'published_at', width: 170,
      render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : <Text type="secondary">未发布</Text>,
    },
    {
      title: '操作', width: 170, fixed: 'right' as const, render: (_: any, row: any) => (
        <Space>
          {row.video_url && (
            <Button size="small" icon={<IconEye />} onClick={() => setPreview(row)}>预览</Button>
          )}
          {row.is_public ? (
            <Popconfirm title="确认下架该作品？下架后画廊不再显示。" onOk={() => handleVisibility(row, false)}>
              <Button size="small" status="warning">下架</Button>
            </Popconfirm>
          ) : (
            <Button size="small" type="primary" status="success" onClick={() => handleVisibility(row, true)}>上架</Button>
          )}
          <Popconfirm title="确认删除该作品？点赞记录将一并删除，不可恢复。" onOk={() => handleDelete(row.id)}>
            <Button size="small" status="danger" icon={<IconDelete />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <Title heading={5} style={{ margin: 0 }}>画廊作品管理</Title>
        <Space>
          <Input
            placeholder="按标题搜索"
            style={{ width: 200 }}
            value={search}
            onChange={setSearch}
            onPressEnter={() => { setPage(1); load() }}
            allowClear
            prefix={<IconSearch />}
          />
          <Select
            value={publicFilter === '' ? undefined : publicFilter}
            onChange={(v) => { setPublicFilter(v || ''); setPage(1) }}
            placeholder="全部状态"
            style={{ width: 130 }}
            allowClear
          >
            <Select.Option value="public">已上架</Select.Option>
            <Select.Option value="private">已下架</Select.Option>
          </Select>
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
        </Space>
      </div>

      <Card>
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : (
          <Table
            columns={columns}
            data={works}
            rowKey="id"
            pagination={{
              current: page,
              pageSize,
              total,
              showTotal: true,
              onChange: (p: number) => setPage(p),
            }}
          />
        )}
      </Card>

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
