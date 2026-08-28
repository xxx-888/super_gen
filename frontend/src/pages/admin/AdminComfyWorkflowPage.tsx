/**
 * AdminComfyWorkflowPage - ComfyUI 工作流库
 *
 * 导入 ComfyUI 工作流 JSON（UI/API 格式自动识别）→ 解析元信息 →
 * 导出为可直接执行的格式：API 格式（POST /prompt 或 curl 直接跑）或
 * UI 格式（加载回 ComfyUI 编辑器）。为后续 comfyui 适配器执行铺路。
 */
import React, { useEffect, useState } from 'react'
import {
  Button, Card, Collapse, Descriptions, Drawer, Empty, Grid, Input, Message,
  Modal, Popconfirm, Select, Space, Spin, Statistic, Switch, Table, Tag,
  Typography, Upload,
} from '@arco-design/web-react'
import {
  IconPlus, IconDelete, IconDownload, IconEye, IconRefresh, IconEdit,
  IconSearch, IconApps, IconCheckCircle, IconShareAlt,
} from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text } = Typography
const { TextArea } = Input
const { Row, Col } = Grid

const AdminComfyWorkflowPage: React.FC = () => {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // 筛选
  const [search, setSearch] = useState('')
  const [formatFilter, setFormatFilter] = useState<string | undefined>(undefined)
  const [enabledFilter, setEnabledFilter] = useState<string | undefined>(undefined)
  // 导入
  const [importVisible, setImportVisible] = useState(false)
  const [importName, setImportName] = useState('')
  const [importDesc, setImportDesc] = useState('')
  const [importJson, setImportJson] = useState('')
  const [importing, setImporting] = useState(false)
  // 编辑（名称/描述；graph 需删了重新导入）
  const [editing, setEditing] = useState<any>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  // 详情
  const [detail, setDetail] = useState<any>(null)
  const [detailVisible, setDetailVisible] = useState(false)

  const load = async (opts?: { search?: string; format?: string; enabled?: string }) => {
    setLoading(true)
    try {
      const params: any = {}
      const s = opts?.search !== undefined ? opts.search : search
      const f = opts?.format !== undefined ? opts.format : formatFilter
      const e = opts?.enabled !== undefined ? opts.enabled : enabledFilter
      if (s) params.search = s
      if (f) params.format = f
      if (e != null && e !== '') params.enabled = e === '1'
      const d: any = await adminService.comfyWorkflows.list(params)
      setRows(Array.isArray(d) ? d : [])
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const handleImport = async () => {
    if (!importJson.trim()) { Message.warning('请粘贴工作流 JSON 或选择文件'); return }
    setImporting(true)
    try {
      const graph = JSON.parse(importJson)
      const r: any = await adminService.comfyWorkflows.create({
        name: importName || '未命名工作流',
        description: importDesc || undefined,
        graph,
      })
      Message.success(`导入成功：识别为 ${r.format === 'ui' ? 'UI（编辑器）' : 'API（执行）'}格式，共 ${r.node_count} 个节点`)
      setImportVisible(false)
      setImportName(''); setImportDesc(''); setImportJson('')
      load()
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || e?.message || '导入失败：JSON 解析错误或格式不识别')
    } finally {
      setImporting(false)
    }
  }

  const openDetail = async (id: string) => {
    try {
      const d: any = await adminService.comfyWorkflows.get(id)
      setDetail(d)
      setDetailVisible(true)
    } catch { /* 拦截器提示 */ }
  }

  const openEdit = (r: any) => {
    setEditing(r)
    setEditName(r.name || '')
    setEditDesc(r.description || '')
  }

  const handleEditSave = async () => {
    if (!editing) return
    if (!editName.trim()) { Message.warning('名称不能为空'); return }
    setEditSaving(true)
    try {
      await adminService.comfyWorkflows.update(editing.id, { name: editName.trim(), description: editDesc.trim() || undefined })
      Message.success('已保存')
      setEditing(null)
      load()
    } catch { Message.error('保存失败') } finally { setEditSaving(false) }
  }

  const toggleEnabled = async (id: string, enabled: boolean) => {
    try {
      await adminService.comfyWorkflows.update(id, { is_enabled: enabled })
      setRows(prev => prev.map((r) => r.id === id ? { ...r, is_enabled: enabled } : r))
    } catch { load() }
  }

  // 统计卡（当前筛选口径）
  const statTotal = rows.length
  const statEnabled = rows.filter((r) => r.is_enabled).length
  const statApi = rows.filter((r) => r.format === 'api').length
  const statNodes = rows.reduce((s, r) => s + (r.node_count || 0), 0)

  const columns = [
    {
      title: '名称', dataIndex: 'name', width: 230,
      render: (v: string, r: any) => (
        <div style={{ minWidth: 0 }}>
          <Space size={6}>
            <Text style={{ fontWeight: 600, maxWidth: 120 }} ellipsis>{v}</Text>
            <Tag size="small" color={r.format === 'api' ? 'green' : 'arcoblue'}>{r.format === 'api' ? 'API' : 'UI'}</Tag>
          </Space>
          {r.description && <Text type="secondary" style={{ fontSize: 11, display: 'block' }} ellipsis>{r.description}</Text>}
        </div>
      ),
    },
    { title: '节点数', dataIndex: 'node_count', width: 70, align: 'center' as const },
    { title: '模型', dataIndex: 'models', ellipsis: true, render: (v: string[]) => (v || []).map((m) => <Tag key={m} size="small">{m}</Tag>) },
    { title: '采样', dataIndex: 'sampler', width: 170, ellipsis: true, render: (v: any) => v ? `${v.sampler_name || ''} ${v.steps || ''}步 cfg${v.cfg ?? ''}` : '-' },
    { title: '启用', dataIndex: 'is_enabled', width: 70, align: 'center' as const, render: (v: boolean, r: any) => (
      <Switch size="small" checked={v} onChange={(c) => toggleEnabled(r.id, c)} />
    ) },
    {
      title: '操作', width: 190, fixed: 'right' as const, render: (_: any, r: any) => (
        <Space size={4}>
          <Button size="mini" type="text" icon={<IconEye />} title="详情" onClick={() => openDetail(r.id)} />
          <Button size="mini" type="text" icon={<IconEdit />} title="编辑名称/描述" onClick={() => openEdit(r)} />
          <a href={adminService.comfyWorkflows.exportUrl(r.id, 'api')} target="_blank" rel="noreferrer" title="导出 API 格式（可直接执行）">
            <Button size="mini" type="text" icon={<IconDownload />} />
          </a>
          <a href={adminService.comfyWorkflows.exportUrl(r.id, 'ui')} target="_blank" rel="noreferrer" title="导出 UI 格式（回编辑器）">
            <Button size="mini" type="text" icon={<IconShareAlt />} />
          </a>
          <Popconfirm title="删除该工作流？" onOk={async () => {
            await adminService.comfyWorkflows.delete(r.id); Message.success('已删除'); load()
          }}>
            <Button size="mini" type="text" status="danger" icon={<IconDelete />} title="删除" />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      {/* 汇总统计卡 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconApps style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>工作流总数</Text>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{statTotal}</div>
        </Card></Col>
        <Col span={6}><Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconCheckCircle style={{ fontSize: 22, color: 'rgb(var(--green-6))' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>启用中</Text>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{statEnabled}</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>禁用 {statTotal - statEnabled} 个</div>
        </Card></Col>
        <Col span={6}><Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconDownload style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>API 格式 / UI 格式</Text>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{statApi} / {statTotal - statApi}</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>UI 格式导出时自动转换</div>
        </Card></Col>
        <Col span={6}><Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconShareAlt style={{ fontSize: 22, color: 'rgb(var(--purple-6))' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>节点总数</Text>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{statNodes}</div>
        </Card></Col>
      </Row>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Title heading={5} style={{ margin: 0 }}>ComfyUI 工作流</Title>
        <Space size={8} wrap>
          <Input
            placeholder="搜索名称 / 描述"
            style={{ width: 180 }}
            value={search}
            onChange={setSearch}
            allowClear
            prefix={<IconSearch />}
            onPressEnter={() => load({ search })}
            onClear={() => { setSearch(''); load({ search: '' }) }}
          />
          <Select
            placeholder="格式" style={{ width: 100 }} allowClear value={formatFilter}
            onChange={(v) => { setFormatFilter(v); load({ format: v }) }}
          >
            <Select.Option value="api">API 格式</Select.Option>
            <Select.Option value="ui">UI 格式</Select.Option>
          </Select>
          <Select
            placeholder="状态" style={{ width: 90 }} allowClear value={enabledFilter}
            onChange={(v) => { setEnabledFilter(v); load({ enabled: v }) }}
          >
            <Select.Option value="1">启用</Select.Option>
            <Select.Option value="0">禁用</Select.Option>
          </Select>
          <Button icon={<IconRefresh />} onClick={() => load({})}>刷新</Button>
          <Button type="primary" icon={<IconPlus />} onClick={() => setImportVisible(true)}>导入工作流</Button>
        </Space>
      </div>

      <Card>
        <Table columns={columns} data={rows} rowKey="id" loading={loading}
          pagination={{ pageSize: 10, showTotal: true, sizeCanChange: true, sizeOptions: [10, 20, 50] }}
          noDataElement={
            <Empty description={
              <span>还没有工作流。到 ComfyUI 里 <b>工作流菜单 → 导出（API 格式）</b> 或界面右上角导出 JSON，粘贴导入即可；
                UI 格式会自动转换为可执行 API 格式</span>
            } />
          } />
      </Card>

      {/* 导入弹窗 */}
      <Modal title="导入 ComfyUI 工作流" visible={importVisible} onCancel={() => setImportVisible(false)}
        onOk={handleImport} confirmLoading={importing} okText="导入" cancelText="取消"
        style={{ width: 640 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Input placeholder="工作流名称，如：SDXL 文生图-角色立绘" value={importName} onChange={setImportName} />
          <Input placeholder="描述（可选）" value={importDesc} onChange={setImportDesc} />
          <TextArea rows={10} placeholder='粘贴 ComfyUI 导出的工作流 JSON（自动识别 UI 格式 / API 格式）'
            value={importJson} onChange={setImportJson}
            style={{ fontFamily: 'monospace', fontSize: 12 }} />
          <Space>
            <Upload
              accept=".json,application/json"
              fileList={[]}
              customRequest={({ file }: any) => {
                const reader = new FileReader()
                reader.onload = () => {
                  setImportJson(String(reader.result || ''))
                  if (!importName) setImportName((file.name || '').replace(/\.json$/i, ''))
                }
                reader.readAsText(file.originFile || file)
              }}
            >
              <Button size="small">选择 JSON 文件</Button>
            </Upload>
            <Text type="secondary" style={{ fontSize: 12 }}>
              支持占位符：{'{{prompt}}'} {'{{negative}}'} {'{{seed}}'} {'{{width}}'} {'{{height}}'} {'{{model}}'}（导出时可替换）
            </Text>
          </Space>
        </Space>
      </Modal>

      {/* 编辑弹窗（名称/描述；graph 变更需删了重新导入） */}
      <Modal title={`编辑工作流：${editing?.name || ''}`} visible={!!editing}
        onCancel={() => setEditing(null)} onOk={handleEditSave}
        confirmLoading={editSaving} okText="保存" cancelText="取消">
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Input placeholder="工作流名称" value={editName} onChange={setEditName} maxLength={120} />
          <Input.TextArea placeholder="描述（可选）" value={editDesc} onChange={setEditDesc} maxLength={500} rows={3} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            工作流内容（节点图）不支持在线修改，需要调整请删除后重新导入
          </Text>
        </Space>
      </Modal>

      {/* 详情抽屉 */}
      <Drawer title={detail ? `工作流：${detail.name}` : ''} width={720}
        visible={detailVisible} onCancel={() => setDetailVisible(false)} footer={null}>
        {detail && (
          <div>
            <Descriptions column={2} data={[
              { label: '格式', value: <Tag color={detail.format === 'api' ? 'green' : 'arcoblue'}>{detail.format === 'api' ? 'API（可直接执行）' : 'UI（自动转换）'}</Tag> },
              { label: '节点数', value: detail.node_count },
              ...(detail.meta?.sampler ? [{ label: '采样器', value: `${detail.meta.sampler.sampler_name || '-'} · ${detail.meta.sampler.steps || '-'}步 · cfg ${detail.meta.sampler.cfg ?? '-'}` }] : []),
              { label: '导入时间', value: detail.created_at ? new Date(detail.created_at).toLocaleString('zh-CN') : '-' },
              ...(detail.description ? [{ label: '描述', value: detail.description, span: 2 }] : []),
            ]} />
            {(detail.meta?.models || []).length > 0 && (
              <Space size={6} wrap style={{ marginTop: 8 }}>
                {(detail.meta.models as string[]).map((m) => <Tag key={m} color="cyan">{m}</Tag>)}
              </Space>
            )}
            {(detail.convert_warnings || []).length > 0 && (
              <div style={{ padding: 8, borderRadius: 6, background: 'rgb(var(--warning-1))', margin: '12px 0' }}>
                {(detail.convert_warnings as string[]).map((w, i) => <div key={i} style={{ fontSize: 12, color: 'rgb(var(--warning-6))' }}>⚠ {w}</div>)}
              </div>
            )}
            <Collapse defaultActiveKey={['api']} style={{ marginTop: 8 }}>
              <Collapse.Item header="可执行 API 格式（POST 到 ComfyUI 的 /prompt）" name="api">
                <pre style={{ maxHeight: 300, overflow: 'auto', fontSize: 11, background: 'var(--color-fill-2)', padding: 10, borderRadius: 6, margin: 0 }}>
                  {JSON.stringify(detail.api_preview, null, 1)}
                </pre>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  执行命令示例：<code>curl -X POST http://你的ComfyUI:8188/prompt -H 'Content-Type: application/json' -d @workflow-api.json</code>
                </Text>
              </Collapse.Item>
              <Collapse.Item header="原始工作流 JSON（导入时的内容）" name="raw">
                <pre style={{ maxHeight: 300, overflow: 'auto', fontSize: 11, background: 'var(--color-fill-2)', padding: 10, borderRadius: 6, margin: 0 }}>
                  {JSON.stringify(detail.graph, null, 1)}
                </pre>
              </Collapse.Item>
            </Collapse>
          </div>
        )}
      </Drawer>
    </div>
  )
}

export default AdminComfyWorkflowPage
