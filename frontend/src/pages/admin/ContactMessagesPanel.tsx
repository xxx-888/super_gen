/**
 * ContactMessagesPanel - 联系我们留言管理（后台系统设置「用户留言」Tab）
 *
 * 列表：类型/处理状态筛选 + 搜索（称呼/联系方式/内容）+ 分页
 * 操作：详情（完整内容 + 处理备注编辑）、标记已处理/取消、删除
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, Input, Message, Modal, Popconfirm, Radio, Space, Table, Tag, Typography,
} from '@arco-design/web-react'
import { IconRefresh, IconSearch, IconDelete, IconEye } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Text, Paragraph } = Typography

const TYPE_MAP: Record<string, { label: string; color: string }> = {
  suggestion: { label: '功能建议', color: 'arcoblue' },
  bug: { label: '问题反馈', color: 'orangered' },
  cooperation: { label: '商务合作', color: 'green' },
  other: { label: '其他', color: 'gray' },
}

const ContactMessagesPanel: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [list, setList] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<any>({ total: 0, unhandled: 0 })
  const [page, setPage] = useState(1)
  const [typeFilter, setTypeFilter] = useState('')
  const [handledFilter, setHandledFilter] = useState('false')
  const [search, setSearch] = useState('')
  const PAGE_SIZE = 15

  const [detail, setDetail] = useState<any>(null)
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await adminService.contactMessages({
        page, page_size: PAGE_SIZE,
        msg_type: typeFilter || undefined,
        handled: handledFilter === 'all' ? undefined : handledFilter,
        search: search.trim() || undefined,
      })
      setList(res?.items ?? [])
      setTotal(res?.total ?? 0)
      setSummary(res?.summary ?? { total: 0, unhandled: 0 })
    } catch { /* 拦截器已提示 */ } finally { setLoading(false) }
  }, [page, typeFilter, handledFilter, search])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [typeFilter, handledFilter])

  // 搜索防抖
  useEffect(() => {
    setPage(1)
    const t = setTimeout(() => load(), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const toggleHandled = async (row: any) => {
    try {
      await adminService.updateContactMessage(row.id, { is_handled: !row.is_handled })
      Message.success(row.is_handled ? '已标记为未处理' : '已标记为已处理')
      load()
    } catch { Message.error('操作失败') }
  }

  const remove = async (row: any) => {
    try {
      await adminService.deleteContactMessage(row.id)
      Message.success('已删除')
      load()
    } catch { Message.error('删除失败') }
  }

  const saveNote = async () => {
    if (!detail) return
    setSavingNote(true)
    try {
      await adminService.updateContactMessage(detail.id, { admin_note: note })
      Message.success('备注已保存')
      setDetail(null)
      load()
    } catch { Message.error('保存失败') } finally { setSavingNote(false) }
  }

  const columns = [
    {
      title: '类型', dataIndex: 'msg_type', width: 96,
      render: (v: string) => {
        const t = TYPE_MAP[v] || TYPE_MAP.other
        return <Tag size="small" color={t.color}>{t.label}</Tag>
      },
    },
    { title: '称呼', dataIndex: 'name', width: 100, ellipsis: true, render: (v: string) => v || <Text type="secondary">-</Text> },
    { title: '联系方式', dataIndex: 'contact', width: 150, ellipsis: true, render: (v: string) => v ? <Text copyable={{ text: v }} style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary">-</Text> },
    {
      title: '内容', dataIndex: 'content', ellipsis: true,
      render: (v: string) => <Paragraph style={{ margin: 0, fontSize: 13 }} ellipsis={{ rows: 2 }}>{v}</Paragraph>,
    },
    {
      title: '提交时间', dataIndex: 'created_at', width: 150,
      render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-',
    },
    {
      title: '状态', dataIndex: 'is_handled', width: 88,
      render: (v: boolean) => <Tag size="small" color={v ? 'green' : 'orange'}>{v ? '已处理' : '未处理'}</Tag>,
    },
    {
      title: '操作', key: 'ops', width: 150,
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button size="mini" type="text" icon={<IconEye />} onClick={() => { setDetail(row); setNote(row.admin_note || '') }}>详情</Button>
          <Button size="mini" type="text" status={row.is_handled ? 'warning' : 'success'} onClick={() => toggleHandled(row)}>
            {row.is_handled ? '撤销' : '处理'}
          </Button>
          <Popconfirm title="确认删除该留言？" onOk={() => remove(row)}>
            <Button size="mini" type="text" status="danger" icon={<IconDelete />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="用户留言（联系我们）"
      extra={<Space size={12}>
        <Text type="secondary" style={{ fontSize: 13 }}>共 {summary.total ?? 0} 条 · 未处理 <Text type="warning">{summary.unhandled ?? 0}</Text></Text>
        <Button size="small" icon={<IconRefresh />} loading={loading} onClick={load}>刷新</Button>
      </Space>}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <Space size={12} style={{ flexWrap: 'wrap' }}>
          <Radio.Group type="button" size="small" value={handledFilter} onChange={setHandledFilter}>
            <Radio value="false">未处理</Radio>
            <Radio value="true">已处理</Radio>
            <Radio value="all">全部</Radio>
          </Radio.Group>
          <Radio.Group type="button" size="small" value={typeFilter} onChange={setTypeFilter}>
            <Radio value="">全部类型</Radio>
            {Object.entries(TYPE_MAP).map(([k, v]) => <Radio key={k} value={k}>{v.label}</Radio>)}
          </Radio.Group>
        </Space>
        <Input
          size="small" style={{ width: 220 }} allowClear
          prefix={<IconSearch />} placeholder="搜索内容/称呼/联系方式"
          value={search} onChange={setSearch}
        />
      </div>

      <Table
        size="small" rowKey="id" loading={loading}
        data={list} columns={columns as any}
        pagination={{
          total, pageSize: PAGE_SIZE, current: page,
          onChange: setPage, size: 'small', showTotal: true,
        }}
      />

      {/* 留言详情 */}
      <Modal
        title={`留言详情 · ${detail ? (TYPE_MAP[detail.msg_type]?.label || detail.msg_type) : ''}`}
        visible={!!detail}
        onCancel={() => setDetail(null)}
        onOk={saveNote}
        okText="保存备注"
        cancelText="关闭"
        confirmLoading={savingNote}
        style={{ width: 560 }}
      >
        {detail && (
          <div>
            <Space size={16} style={{ marginBottom: 12, fontSize: 13 }}>
              <Text type="secondary">称呼：</Text><Text>{detail.name || '-'}</Text>
              <Text type="secondary">联系方式：</Text><Text>{detail.contact || '-'}</Text>
            </Space>
            <div style={{
              background: 'var(--color-fill-1)', borderRadius: 6, padding: '12px 14px',
              maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.8,
            }}>
              {detail.content}
            </div>
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <Text type="secondary">
                提交于 {detail.created_at ? new Date(detail.created_at).toLocaleString('zh-CN') : '-'} · IP {detail.ip || '-'}
              </Text>
            </div>
            <div style={{ marginTop: 14 }}>
              <Text type="secondary" style={{ fontSize: 13 }}>处理备注（仅后台可见）</Text>
              <Input.TextArea
                style={{ marginTop: 6 }} rows={3} maxLength={500} showWordLimit
                placeholder="记录处理进展/回复方式等"
                value={note} onChange={setNote}
              />
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}

export default ContactMessagesPanel
