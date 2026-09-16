/**
 * AdminTemplatesPage - 后台向导模板管理（M9）
 *
 * 两个 Tab：
 * 1. 示例项目：把任意项目标记为官方示例（设题材/简介/排序），或下架；
 *    被标记的项目从用户项目列表消失，仅在模板库供一键克隆
 * 2. 剧本模板：题材剧本的增删改查（含上下架开关）
 * 页顶统计卡：示例/模板规模与被使用情况（两份列表数据前端汇总）
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, Form, Grid, Input, InputNumber, Message, Modal, Select, Space,
  Switch, Table, Tabs, Tag, Typography,
} from '@arco-design/web-react'
import {
  IconApps, IconBook, IconCopy, IconPlus, IconRefresh, IconThunderbolt,
} from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Text } = Typography
const { Row, Col } = Grid

const GENRES = ['都市甜宠', '古风玄幻', '悬疑反转', '战神赘婿', '穿越重生', '家庭伦理', '励志逆袭', '校园青春']

const AdminTemplatesPage: React.FC = () => {
  const [stats, setStats] = useState<{ examples: any[]; scripts: any[] }>({ examples: [], scripts: [] })

  const loadStats = useCallback(async () => {
    try {
      const [ex, sc]: any[] = await Promise.all([
        adminService.templates.listProjects(),
        adminService.templates.listScripts(),
      ])
      setStats({ examples: Array.isArray(ex) ? ex : ex?.items || [], scripts: Array.isArray(sc) ? sc : sc?.items || [] })
    } catch { /* 拦截器提示 */ }
  }, [])
  useEffect(() => { loadStats() }, [loadStats])

  const statCard = (title: string, value: React.ReactNode, icon: React.ReactNode, sub?: React.ReactNode) => (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {icon}
        <Text type="secondary" style={{ fontSize: 13 }}>{title}</Text>
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8, lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{sub}</div>}
    </Card>
  )

  const ex = stats.examples
  const sc = stats.scripts
  const cloneTotal = ex.reduce((s: number, r: any) => s + (r.use_count || 0), 0)
  const useTotal = sc.reduce((s: number, r: any) => s + (r.use_count || 0), 0)
  const activeScripts = sc.filter((r: any) => r.is_active).length

  return (
    <div>
      {/* 汇总统计卡（示例/模板规模与被使用情况） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>{statCard('官方示例项目', ex.length,
          <IconApps style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />,
          `覆盖题材 ${new Set(ex.map((r: any) => r.template_genre).filter(Boolean)).size} 个`)}</Col>
        <Col span={6}>{statCard('累计克隆次数', cloneTotal,
          <IconCopy style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />,
          '示例项目被用户一键克隆')}</Col>
        <Col span={6}>{statCard('剧本模板', sc.length,
          <IconBook style={{ fontSize: 22, color: 'rgb(var(--purple-6))' }} />,
          `上架 ${activeScripts} · 已下架 ${sc.length - activeScripts}`)}</Col>
        <Col span={6}>{statCard('模板创建次数', useTotal,
          <IconThunderbolt style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />,
          '用户用剧本模板创建项目')}</Col>
      </Row>

      <Tabs defaultActiveTab="projects">
        <Tabs.TabPane key="projects" title="官方示例项目">
          <ProjectsTab onChanged={loadStats} />
        </Tabs.TabPane>
        <Tabs.TabPane key="scripts" title="剧本模板">
          <ScriptsTab onChanged={loadStats} />
        </Tabs.TabPane>
      </Tabs>
    </div>
  )
}

// ==================== Tab 1：官方示例项目 ====================

const ProjectsTab: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  // 标记新示例
  const [candidates, setCandidates] = useState<any[]>([])
  const [pickId, setPickId] = useState<string | undefined>(undefined)
  const [genre, setGenre] = useState<string>(GENRES[0])
  const [desc, setDesc] = useState('')
  const [sort, setSort] = useState(0)
  const [saving, setSaving] = useState(false)
  // 编辑已有示例
  const [editRow, setEditRow] = useState<any>(null)
  const [editForm] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d: any = await adminService.templates.listProjects()
      setRows(Array.isArray(d) ? d : d?.items || [])
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const loadCandidates = useCallback(async (kw: string) => {
    try {
      const d: any = await adminService.projects({ page: 1, page_size: 20, search: kw || undefined })
      const items = d?.items || []
      setCandidates(items.map((p: any) => ({ label: `${p.name}（${p.id.slice(0, 8)}…）`, value: p.id, raw: p })))
    } catch { /* 忽略 */ }
  }, [])

  const handleMark = async () => {
    if (!pickId) { Message.warning('请先选择要标记的项目'); return }
    setSaving(true)
    try {
      await adminService.templates.setProjectMeta(pickId, {
        is_template: true, template_genre: genre,
        template_desc: desc || undefined, template_sort: sort,
      })
      Message.success('已标记为官方示例项目')
      setPickId(undefined); setDesc(''); setSort(0)
      load()
      onChanged?.()
    } catch { /* 拦截器提示 */ } finally { setSaving(false) }
  }

  const handleSaveEdit = async () => {
    try {
      const v = await editForm.validate()
      await adminService.templates.setProjectMeta(editRow.id, {
        is_template: true,
        template_genre: v.template_genre, template_desc: v.template_desc,
        template_sort: v.template_sort,
      })
      Message.success('已保存')
      setEditRow(null)
      load()
      onChanged?.()
    } catch (err: any) {
      if (err?.errors) return
    }
  }

  const handleUnmark = (row: any) => {
    Modal.confirm({
      title: '下架示例项目',
      content: `「${row.name}」将回到普通项目（模板库不再展示，已克隆的项目不受影响）。`,
      okButtonProps: { status: 'warning' },
      onOk: async () => {
        await adminService.templates.setProjectMeta(row.id, {
          is_template: false, template_genre: row.template_genre,
          template_desc: row.template_desc, template_sort: row.template_sort || 0,
        })
        Message.success('已下架')
        load()
      onChanged?.()
      },
    })
  }

  return (
    <div>
      <Card title="标记新示例" style={{ marginBottom: 16 }}>
        <Space size={12} wrap>
          <Select
            style={{ width: 320 }} placeholder="搜索并选择项目（按名称）" showSearch allowClear
            filterOption={false} value={pickId}
            onSearch={loadCandidates} onChange={setPickId}
          >
            {candidates.map((c: any) => <Select.Option key={c.value} value={c.value}>{c.label}</Select.Option>)}
          </Select>
          <Select style={{ width: 140 }} value={genre} onChange={setGenre}>
            {GENRES.map((g) => <Select.Option key={g} value={g}>{g}</Select.Option>)}
          </Select>
          <Input style={{ width: 360 }} placeholder="模板卡片简介（可选）" value={desc} onChange={setDesc} maxLength={200} />
          <InputNumber style={{ width: 100 }} value={sort} onChange={(v) => setSort(v || 0)} min={0} />
          <Button type="primary" loading={saving} disabled={!pickId} onClick={handleMark}>标记为示例</Button>
        </Space>
        <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 8 }}>
          被标记的项目不出现在任何用户的项目列表/看板里，仅在模板库展示；克隆会复制完整创作树（剧本/角色/场景/道具/集/分镜）。
        </div>
      </Card>

      <Card title={`已上架示例（${rows.length}）`} extra={<Button size="small" icon={<IconRefresh />} onClick={load}>刷新</Button>}>
        <Table
          rowKey="id" loading={loading} data={rows} pagination={false}
          size="small"
          columns={[
            { title: '名称', dataIndex: 'name', ellipsis: true,
              render: (v: string) => <Text style={{ fontWeight: 500 }}>{v}</Text> },
            { title: '题材', dataIndex: 'template_genre', width: 110,
              render: (v: string) => v ? <Tag color="arcoblue" size="small">{v}</Tag> : '-' },
            { title: '简介', dataIndex: 'template_desc', ellipsis: true, width: 300 },
            { title: '内容', width: 150, render: (_: any, r: any) => (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {r.script_count ?? 0}剧本 / {r.scene_count ?? 0}分镜 / {r.character_count ?? 0}角色
              </Text>
            ) },
            { title: '排序', dataIndex: 'template_sort', width: 70 },
            { title: '克隆次数', dataIndex: 'use_count', width: 90 },
            { title: '操作', width: 160, render: (_: any, r: any) => (
              <Space size={4}>
                <Button size="mini" onClick={() => {
                  setEditRow(r)
                  editForm.setFieldsValue({
                    template_genre: r.template_genre || GENRES[0],
                    template_desc: r.template_desc || '',
                    template_sort: r.template_sort || 0,
                  })
                }}>编辑</Button>
                <Button size="mini" status="warning" onClick={() => handleUnmark(r)}>下架</Button>
              </Space>
            ) },
          ]}
        />
      </Card>

      <Modal title="编辑示例信息" visible={!!editRow} onCancel={() => setEditRow(null)}
        onOk={handleSaveEdit} okText="保存" cancelText="取消">
        <Form form={editForm} layout="vertical">
          <Form.Item field="template_genre" label="题材">
            <Select>{GENRES.map((g) => <Select.Option key={g} value={g}>{g}</Select.Option>)}</Select>
          </Form.Item>
          <Form.Item field="template_desc" label="模板卡片简介">
            <Input.TextArea rows={3} maxLength={200} showWordLimit />
          </Form.Item>
          <Form.Item field="template_sort" label="排序（小的在前）">
            <InputNumber min={0} style={{ width: 120 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ==================== Tab 2：剧本模板 ====================

const ScriptsTab: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [editVisible, setEditVisible] = useState(false)
  const [editId, setEditId] = useState<string | null>(null) // null = 新建
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d: any = await adminService.templates.listScripts()
      setRows(Array.isArray(d) ? d : d?.items || [])
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditId(null)
    form.resetFields()
    form.setFieldsValue({ genre: GENRES[0], episode_count: 1, sort_order: 0, is_active: true, tags: [] })
    setEditVisible(true)
  }

  const openEdit = (r: any) => {
    setEditId(r.id)
    form.resetFields()
    form.setFieldsValue({
      genre: r.genre, title: r.title, logline: r.logline, description: r.description,
      tags: r.tags || [], content: r.content, episode_count: r.episode_count,
      sort_order: r.sort_order, is_active: r.is_active,
    })
    setEditVisible(true)
  }

  const handleSave = async () => {
    try {
      const v = await form.validate()
      setSaving(true)
      const payload = { ...v }
      if (editId) await adminService.templates.updateScript(editId, payload)
      else await adminService.templates.createScript({ ...payload, id: `custom-${Date.now().toString(36)}` })
      Message.success(editId ? '已保存' : '已创建')
      setEditVisible(false)
      load()
      onChanged?.()
    } catch (err: any) {
      if (err?.errors) return
    } finally { setSaving(false) }
  }

  const handleDelete = (r: any) => {
    Modal.confirm({
      title: '删除剧本模板',
      content: `确定删除《${r.title}》？已用它创建的项目不受影响。使用过的模板建议改用「下架」。`,
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        await adminService.templates.deleteScript(r.id)
        Message.success('已删除')
        load()
      onChanged?.()
      },
    })
  }

  return (
    <Card title={`剧本模板（${rows.length}）`}
      extra={<Space>
        <Button size="small" icon={<IconRefresh />} onClick={load}>刷新</Button>
        <Button size="small" type="primary" icon={<IconPlus />} onClick={openCreate}>新建模板</Button>
      </Space>}>
      <Table
        rowKey="id" loading={loading} data={rows} pagination={false} size="small"
        columns={[
          { title: 'ID', dataIndex: 'id', width: 170,
            render: (v: string) => <Text copyable style={{ fontSize: 12 }}>{v}</Text> },
          { title: '题材', dataIndex: 'genre', width: 100,
            render: (v: string) => <Tag size="small" color="arcoblue">{v}</Tag> },
          { title: '标题', dataIndex: 'title', ellipsis: true,
            render: (v: string) => <Text style={{ fontWeight: 500 }}>《{v}》</Text> },
          { title: '梗概', dataIndex: 'logline', ellipsis: true, width: 320 },
          { title: '字数', width: 80, render: (_: any, r: any) => (r.content?.length ?? 0) },
          { title: '使用', dataIndex: 'use_count', width: 70 },
          { title: '排序', dataIndex: 'sort_order', width: 60 },
          { title: '上架', dataIndex: 'is_active', width: 80,
            render: (v: boolean, r: any) => (
              <Switch size="small" checked={v} onChange={async (c) => {
                try {
                  await adminService.templates.updateScript(r.id, { is_active: c })
                  Message.success(c ? '已上架' : '已下架')
                  load()
      onChanged?.()
                } catch { /* 拦截器提示 */ }
              }} />
            ) },
          { title: '操作', width: 130, render: (_: any, r: any) => (
            <Space size={4}>
              <Button size="mini" onClick={() => openEdit(r)}>编辑</Button>
              <Button size="mini" status="danger" onClick={() => handleDelete(r)}>删除</Button>
            </Space>
          ) },
        ]}
      />

      <Modal title={editId ? '编辑剧本模板' : '新建剧本模板'} visible={editVisible}
        onCancel={() => setEditVisible(false)} onOk={handleSave} confirmLoading={saving}
        okText="保存" cancelText="取消" style={{ width: 680 }}>
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item field="genre" label="题材" rules={[{ required: true }]} style={{ width: 160 }}>
              <Select showSearch allowCreate>{GENRES.map((g) => <Select.Option key={g} value={g}>{g}</Select.Option>)}</Select>
            </Form.Item>
            <Form.Item field="title" label="标题" rules={[{ required: true }]} style={{ width: 380 }}>
              <Input placeholder="如：咖啡厅的心动预告" maxLength={100} />
            </Form.Item>
          </Space>
          <Form.Item field="logline" label="一句话梗概">
            <Input placeholder="25-40 字最能打的钩子" maxLength={120} />
          </Form.Item>
          <Form.Item field="description" label="适用说明（模板卡片展示）">
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
          <Form.Item field="content" label="剧本正文" rules={[{ required: true, message: '请填写剧本正文' }]}>
            <Input.TextArea rows={12} placeholder="场景/对白格式的剧本正文，用户使用后将预填到剧本编辑器" style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item field="episode_count" label="建议集数" initialValue={1}>
              <InputNumber min={1} max={999} style={{ width: 110 }} />
            </Form.Item>
            <Form.Item field="sort_order" label="排序" initialValue={0}>
              <InputNumber min={0} style={{ width: 110 }} />
            </Form.Item>
            <Form.Item field="is_active" label="上架" triggerPropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  )
}

export default AdminTemplatesPage
