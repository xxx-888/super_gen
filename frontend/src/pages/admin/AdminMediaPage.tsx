/**
 * AdminMediaPage - 生成媒体资源管理
 *
 * 集中管理所有生成任务输出的图片/视频/音频文件：
 * - 搜索（文件名/URL/提示词/项目/用户）+ 类型/状态筛选
 * - 禁用/启用（禁用的本地文件 /uploads/... 返回 403，云端直链仅标注状态）
 * - 重命名（显示名）、删除（删底层文件并从任务输出移除引用）
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Button, Table, Tag, Space, Input, Select, Message, Popconfirm,
  Modal, Typography, Radio, Tooltip, Grid, Statistic,
} from '@arco-design/web-react'
import {
  IconRefresh, IconSearch, IconDelete, IconEdit, IconVideoCamera,
  IconSound, IconImage, IconLink, IconCheck, IconClose, IconEye, IconPlayArrowFill,
  IconStorage, IconExclamationCircle,
} from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text } = Typography
const { Row, Col } = Grid

const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'task', label: '生成任务输出' },
  { value: 'material', label: '素材库上传' },
  { value: 'asset', label: '项目资产' },
  { value: 'resource', label: '资源主图' },
  { value: 'canvas', label: '画布节点' },
]

const TYPE_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  image: { label: '图片', color: 'arcoblue', icon: <IconImage /> },
  video: { label: '视频', color: 'green', icon: <IconVideoCamera /> },
  audio: { label: '音频', color: 'orange', icon: <IconSound /> },
}

const fmtSize = (v: number | null | undefined) => {
  if (v == null) return '-'
  if (v < 0) return '-'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

const AdminMediaPage: React.FC = () => {
  const [items, setItems] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<any>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(15)
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string | undefined>(undefined)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [renaming, setRenaming] = useState<any>(null)
  const [renameValue, setRenameValue] = useState('')
  const [preview, setPreview] = useState<any>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { page, page_size: pageSize }
      if (typeFilter) params.type = typeFilter
      if (statusFilter) params.status = statusFilter
      if (sourceFilter) params.source = sourceFilter
      if (search) params.search = search
      const res: any = await adminService.media.list(params)
      const d = res?.data ?? res
      setItems(d?.items ?? [])
      setTotal(d?.total ?? 0)
      setSummary(d?.summary ?? null)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, typeFilter, statusFilter, sourceFilter, search])

  useEffect(() => { load() }, [load])

  const handleDisable = async (row: any, disabled: boolean) => {
    try {
      await adminService.media.update({ url: row.url, disabled })
      Message.success(disabled ? '已禁用（本地文件即刻 403）' : '已启用')
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '操作失败')
    }
  }

  // 批量禁用/启用（按 URL 逐个 update；量级可接受）
  const handleBatchDisable = async (disabled: boolean) => {
    const targets = items.filter((i) => selectedKeys.includes(i.url))
    if (!targets.length) return
    let ok = 0
    for (const t of targets) {
      try { await adminService.media.update({ url: t.url, disabled }); ok += 1 } catch { /* 单条失败继续 */ }
    }
    Message.success(`已${disabled ? '禁用' : '启用'} ${ok}/${targets.length} 个文件`)
    setSelectedKeys([])
    load()
  }

  // 批量删除（后端 /media/delete 原生支持 items 数组）
  const handleBatchDelete = async () => {
    const targets = items.filter((i) => selectedKeys.includes(i.url))
    if (!targets.length) return
    try {
      const res: any = await adminService.media.remove(
        targets.map((t) => ({ source: t.source, ref_id: t.ref_id, url: t.url })),
      )
      const d = res?.data ?? res
      Message.success(`已删除（底层文件 ${d?.deleted ?? 0} 个，解除引用 ${d?.unlinked ?? 0} 个）`)
      setSelectedKeys([])
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '批量删除失败')
    }
  }

  const handleRename = async () => {
    if (!renaming || !renameValue.trim()) { setRenaming(null); return }
    try {
      await adminService.media.update({ url: renaming.url, name: renameValue.trim() })
      Message.success('已重命名')
      setRenaming(null)
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '重命名失败')
    }
  }

  const handleDelete = async (row: any) => {
    try {
      const res: any = await adminService.media.remove([{ source: row.source, ref_id: row.ref_id, url: row.url }])
      const d = res?.data ?? res
      Message.success(`已删除（底层文件 ${d?.deleted ?? 0} 个，解除引用 ${d?.unlinked ?? 0} 个）`)
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  // 复制媒体链接。
  // 注意：navigator.clipboard 仅在安全上下文（HTTPS / localhost）下可用，内网 IP /
  // 服务器域名走 HTTP 时它是 undefined，可选链后整体为 undefined 再调 .then 会抛
  // 同步 TypeError，表现为「点了没反应」。因此加 execCommand 兜底（同 ProjectMembersPage）。
  // 本地存储的 URL 是相对路径（/uploads/...），复制时补全为绝对地址方便直接访问。
  const copyLink = (url: string) => {
    const absUrl = /^https?:\/\//.test(url)
      ? url
      : `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(absUrl).then(
        () => Message.success('链接已复制到剪贴板'),
        () => fallbackCopy(absUrl),
      )
      return
    }
    fallbackCopy(absUrl)
  }

  // 兜底复制：临时 textarea + execCommand('copy')，非安全上下文（HTTP 内网）下也能用
  const fallbackCopy = (text: string) => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) {
        Message.success('链接已复制到剪贴板')
      } else {
        Message.error('复制失败，请手动复制：' + text)
      }
    } catch {
      Message.error('复制失败，请手动复制：' + text)
    }
  }

  const columns = [
    {
      title: '文件', dataIndex: 'name', width: 320,
      render: (_: any, row: any) => {
        const meta = TYPE_META[row.type] || TYPE_META.image
        return (
          <Space>
            <div
              onClick={() => setPreview(row)}
              style={{ width: 56, height: 42, borderRadius: 4, overflow: 'hidden', background: 'var(--color-fill-3)',
                       flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              {row.type === 'image'
                ? <img src={row.url} alt={row.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : row.type === 'video'
                  ? (
                    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                      {/* #t=0.5 让浏览器定位到 0.5s 帧作缩略图；preload=metadata 只拉元数据+首屏帧，不下载整个视频 */}
                      <video
                        src={`${row.url}#t=0.5`}
                        preload="metadata"
                        muted
                        playsInline
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
                      />
                      <IconPlayArrowFill style={{ position: 'absolute', right: 3, bottom: 3, color: '#fff', fontSize: 14, filter: 'drop-shadow(0 0 2px rgba(0,0,0,.6))' }} />
                    </div>
                  )
                  : <span style={{ color: 'var(--color-text-3)' }}>{meta.icon}</span>}
            </div>
            <div style={{ minWidth: 0 }}>
              <Text style={{ fontWeight: 600, display: 'block' }} ellipsis>{row.name}</Text>
              <Space size={4}>
                <Tag size="small">{row.storage === 'local' ? '本地' : '云端'}</Tag>
                {row.size === -1 && <Tag size="small" color="red">文件缺失</Tag>}
                {row.size != null && row.size >= 0 && <Text type="secondary" style={{ fontSize: 11 }}>{fmtSize(row.size)}</Text>}
              </Space>
            </div>
          </Space>
        )
      },
    },
    {
      title: '类型', dataIndex: 'type', width: 80, align: 'center' as const,
      render: (v: string) => {
        const m = TYPE_META[v]
        return m ? <Tag color={m.color} icon={m.icon}>{m.label}</Tag> : <Tag>{v}</Tag>
      },
    },
    {
      title: '来源', dataIndex: 'source', width: 100, align: 'center' as const,
      render: (v: string, row: any) => {
        const tip: Record<string, string> = {
          task: '生成任务的输出文件',
          material: '素材库上传',
          asset: '项目音视频资产',
          resource: '角色/场景/道具主图',
          canvas: '画布节点里的媒体',
        }
        const color: Record<string, string> = {
          task: 'arcoblue', material: 'purple', asset: 'cyan', resource: 'green', canvas: 'orange',
        }
        return (
          <Tooltip content={tip[v] || v}>
            <Tag size="small" color={color[v] || 'gray'}>{row.source_label}</Tag>
          </Tooltip>
        )
      },
    },
    {
      title: '生成者', dataIndex: 'user', width: 150, ellipsis: true,
      render: (v: any) => v ? (v.nickname || v.email) : <Text type="secondary">-</Text>,
    },
    {
      title: '所属项目', dataIndex: 'project_title', width: 140, ellipsis: true,
      render: (v: string) => v || <Text type="secondary">-</Text>,
    },
    {
      title: '提示词', dataIndex: 'prompt', width: 200, ellipsis: true,
      render: (v: string) =>
        v ? <Tooltip content={v}><span>{v}</span></Tooltip> : <Text type="secondary">-</Text>,
    },
    {
      title: '状态', dataIndex: 'disabled', width: 90, align: 'center' as const,
      render: (v: boolean) => v
        ? <Tag color="red" icon={<IconClose />}>已禁用</Tag>
        : <Tag color="green" icon={<IconCheck />}>正常</Tag>,
    },
    {
      title: '生成时间', dataIndex: 'created_at', width: 160,
      render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: '操作', width: 220, fixed: 'right' as const, render: (_: any, row: any) => (
        <Space>
          <Button size="small" icon={<IconLink />} onClick={() => copyLink(row.url)}>复制</Button>
          <Button size="small" icon={<IconEdit />} onClick={() => { setRenaming(row); setRenameValue(row.name) }}>重命名</Button>
          {row.disabled ? (
            <Button size="small" type="primary" status="success" onClick={() => handleDisable(row, false)}>启用</Button>
          ) : (
            <Popconfirm title="确认禁用？本地文件将立即无法访问（云端直链仅标注状态）。" onOk={() => handleDisable(row, true)}>
              <Button size="small" status="warning">禁用</Button>
            </Popconfirm>
          )}
          <Popconfirm title="确认删除？将删除存储中的文件并从任务输出移除引用，不可恢复。" onOk={() => handleDelete(row)}>
            <Button size="small" status="danger" icon={<IconDelete />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      {/* 汇总统计卡（后端全量口径） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <IconStorage style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />
              <Text type="secondary" style={{ fontSize: 13 }}>文件总数</Text>
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{summary?.total ?? '-'}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>
              约 {fmtSize(summary?.total_bytes)}
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <IconImage style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />
              <Text type="secondary" style={{ fontSize: 13 }}>图片 / 视频 / 音频</Text>
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>
              {summary ? `${summary.image} / ${summary.video} / ${summary.audio}` : '-'}
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <IconClose style={{ fontSize: 22, color: 'rgb(var(--red-6))' }} />
              <Text type="secondary" style={{ fontSize: 13 }}>已禁用</Text>
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{summary?.disabled ?? '-'}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>禁用的本地文件即刻 403</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <IconLink style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />
              <Text type="secondary" style={{ fontSize: 13 }}>五来源合并</Text>
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>按 URL 去重</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>任务输出 / 素材库 / 资产 / 主图 / 画布</div>
          </Card>
        </Col>
      </Row>

      <Title heading={5} style={{ marginBottom: 16 }}>媒体资源管理</Title>
      <Card>
        <Space size={12} style={{ marginBottom: 16 }} wrap>
          <Radio.Group
            type="button"
            value={typeFilter}
            onChange={(v) => { setTypeFilter(v); setPage(1) }}
          >
            <Radio value="">全部</Radio>
            <Radio value="image">图片</Radio>
            <Radio value="video">视频</Radio>
            <Radio value="audio">音频</Radio>
          </Radio.Group>
          <Select
            value={statusFilter || undefined}
            onChange={(v) => { setStatusFilter(v || ''); setPage(1) }}
            style={{ width: 120 }}
            placeholder="全部状态"
            allowClear
          >
            <Select.Option value="normal">正常</Select.Option>
            <Select.Option value="disabled">已禁用</Select.Option>
          </Select>
          <Select
            value={sourceFilter}
            onChange={(v) => { setSourceFilter(v); setPage(1) }}
            style={{ width: 140 }}
            placeholder="全部来源"
            allowClear
          >
            {SOURCE_OPTIONS.map((s) => <Select.Option key={s.value} value={s.value}>{s.label}</Select.Option>)}
          </Select>
          <Input.Search
            searchButton
            placeholder="搜索文件名 / 提示词 / 项目 / 用户"
            style={{ width: 280 }}
            value={searchInput}
            onChange={setSearchInput}
            onSearch={(v) => { setSearch(v); setPage(1) }}
            onClear={() => { setSearchInput(''); setSearch(''); setPage(1) }}
            allowClear
          />
          <Popconfirm title={`确认批量禁用选中的 ${selectedKeys.length} 个文件？`} disabled={!selectedKeys.length} onOk={() => handleBatchDisable(true)}>
            <Button status="warning" disabled={!selectedKeys.length}>批量禁用{selectedKeys.length ? `(${selectedKeys.length})` : ''}</Button>
          </Popconfirm>
          <Popconfirm title={`确认批量启用选中的 ${selectedKeys.length} 个文件？`} disabled={!selectedKeys.length} onOk={() => handleBatchDisable(false)}>
            <Button status="success" disabled={!selectedKeys.length}>批量启用</Button>
          </Popconfirm>
          <Popconfirm
            title={`确认批量删除选中的 ${selectedKeys.length} 个文件？将删除底层文件并解除全部引用，不可恢复。`}
            disabled={!selectedKeys.length}
            onOk={handleBatchDelete}
          >
            <Button status="danger" icon={<IconDelete />} disabled={!selectedKeys.length}>批量删除</Button>
          </Popconfirm>
          <Button icon={<IconRefresh />} onClick={load} />
        </Space>

        <Table
          loading={loading}
          columns={columns}
          data={items}
          rowKey={(row: any) => row.url}
          size="small"
          scroll={{ x: 1500 }}
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
            sizeOptions: [15, 30, 50],
            onChange: (p: number, ps?: number) => {
              setPage(p)
              if (ps && ps !== pageSize) setPageSize(ps)
            },
          }}
        />
      </Card>

      {/* 重命名弹窗 */}
      <Modal
        title="重命名媒体"
        visible={!!renaming}
        onOk={handleRename}
        onCancel={() => setRenaming(null)}
        okText="保存"
        cancelText="取消"
      >
        <Input
          value={renameValue}
          onChange={setRenameValue}
          placeholder="输入显示名称"
          maxLength={200}
        />
      </Modal>

      {/* 预览弹窗 */}
      <Modal
        title={preview?.name || '预览'}
        visible={!!preview}
        footer={null}
        onCancel={() => setPreview(null)}
        style={{ width: 'auto', maxWidth: '80vw' }}
      >
        {preview?.type === 'image' && (
          <img src={preview.url} alt={preview.name} style={{ maxWidth: '76vw', maxHeight: '70vh', display: 'block' }} />
        )}
        {preview?.type === 'video' && (
          <video src={preview.url} controls autoPlay style={{ maxWidth: '76vw', maxHeight: '70vh', display: 'block' }} />
        )}
        {preview?.type === 'audio' && (
          <div style={{ paddingTop: 12 }}><audio src={preview.url} controls style={{ width: 420 }} /></div>
        )}
        <div style={{ marginTop: 12 }}>
          <Space size={4}><IconEye /><Text type="secondary">{preview?.url}</Text></Space>
        </div>
      </Modal>
    </div>
  )
}

export default AdminMediaPage
