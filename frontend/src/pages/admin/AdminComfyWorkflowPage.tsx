/**
 * AdminComfyWorkflowPage - ComfyUI 工作流库
 *
 * 导入 ComfyUI 工作流 JSON（UI/API 格式自动识别）→ 解析元信息 →
 * 导出为可直接执行的格式：API 格式（POST /prompt 或 curl 直接跑）或
 * UI 格式（加载回 ComfyUI 编辑器）。为后续 comfyui 适配器执行铺路。
 */
import React, { useEffect, useState } from 'react'
import {
  Button, Card, Empty, Input, Message, Modal, Popconfirm, Space, Spin,
  Switch, Table, Tag, Typography, Upload,
} from '@arco-design/web-react'
import { IconPlus, IconDelete, IconDownload, IconEye, IconRefresh } from '@arco-design/web-react/icon'
import { apiClient } from '@/api/client'

const { Title, Text } = Typography
const { TextArea } = Input

const AdminComfyWorkflowPage: React.FC = () => {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [importVisible, setImportVisible] = useState(false)
  const [importName, setImportName] = useState('')
  const [importDesc, setImportDesc] = useState('')
  const [importJson, setImportJson] = useState('')
  const [importing, setImporting] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [detailVisible, setDetailVisible] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const d: any = await apiClient.get('/admin/comfyui-workflows')
      setRows(Array.isArray(d) ? d : [])
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const handleImport = async () => {
    if (!importJson.trim()) { Message.warning('请粘贴工作流 JSON 或选择文件'); return }
    try {
      const graph = JSON.parse(importJson)
      const r: any = await apiClient.post('/admin/comfyui-workflows', {
        name: importName || '未命名工作流',
        description: importDesc || null,
        graph,
      })
      Message.success(`导入成功：识别为 ${r.format === 'ui' ? 'UI（编辑器）' : 'API（执行）'}格式，共 ${r.node_count} 个节点`)
      setImportVisible(false)
      setImportName(''); setImportDesc(''); setImportJson('')
      load()
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || e?.message || '导入失败：JSON 解析错误或格式不识别')
    }
  }

  const openDetail = async (id: string) => {
    try {
      const d: any = await apiClient.get(`/admin/comfyui-workflows/${id}`)
      setDetail(d)
      setDetailVisible(true)
    } catch { /* 拦截器提示 */ }
  }

  const toggleEnabled = async (id: string, enabled: boolean) => {
    try {
      await apiClient.put(`/admin/comfyui-workflows/${id}`, { is_enabled: enabled })
      setRows(prev => prev.map((r) => r.id === id ? { ...r, is_enabled: enabled } : r))
    } catch { load() }
  }

  const columns = [
    { title: '名称', dataIndex: 'name', width: 180, render: (v: string, r: any) => (
      <Space size={6}>
        <Text style={{ fontWeight: 600 }}>{v}</Text>
        <Tag size="small" color={r.format === 'api' ? 'green' : 'arcoblue'}>{r.format === 'api' ? 'API' : 'UI'}</Tag>
      </Space>
    ) },
    { title: '节点数', dataIndex: 'node_count', width: 80, align: 'center' as const },
    { title: '模型', dataIndex: 'models', ellipsis: true, render: (v: string[]) => (v || []).map((m) => <Tag key={m} size="small">{m}</Tag>) },
    { title: '采样', dataIndex: 'sampler', width: 190, ellipsis: true, render: (v: any) => v ? `${v.sampler_name || ''} ${v.steps || ''}步 cfg${v.cfg ?? ''}` : '-' },
    { title: '启用', dataIndex: 'is_enabled', width: 80, render: (v: boolean, r: any) => (
      <Switch size="small" checked={v} onChange={(c) => toggleEnabled(r.id, c)} />
    ) },
    { title: '操作', width: 240, render: (_: any, r: any) => (
      <Space size="small">
        <Button size="mini" icon={<IconEye />} onClick={() => openDetail(r.id)}>详情</Button>
        <a href={`/api/v1/admin/comfyui-workflows/${r.id}/export?format=api`} target="_blank" rel="noreferrer">
          <Button size="mini" icon={<IconDownload />}>导出API</Button>
        </a>
        <a href={`/api/v1/admin/comfyui-workflows/${r.id}/export?format=ui`} target="_blank" rel="noreferrer">
          <Button size="mini" icon={<IconDownload />}>导出UI</Button>
        </a>
        <Popconfirm title="删除该工作流？" onOk={async () => {
          await apiClient.delete(`/admin/comfyui-workflows/${r.id}`); Message.success('已删除'); load()
        }}>
          <Button size="mini" status="danger" icon={<IconDelete />} />
        </Popconfirm>
      </Space>
    ) },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title heading={5} style={{ margin: 0 }}>ComfyUI 工作流</Title>
        <Space>
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<IconPlus />} onClick={() => setImportVisible(true)}>导入工作流</Button>
        </Space>
      </div>

      <Card>
        <Table columns={columns} data={rows} rowKey="id" loading={loading} pagination={{ pageSize: 10, showTotal: true }}
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

      {/* 详情抽屉 */}
      <Modal title={detail ? `工作流：${detail.name}` : ''} visible={detailVisible}
        onCancel={() => setDetailVisible(false)} footer={null} style={{ width: 760 }}>
        {detail && (
          <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <Space wrap size={8} style={{ marginBottom: 12 }}>
              <Tag color={detail.format === 'api' ? 'green' : 'arcoblue'}>{detail.format === 'api' ? 'API 格式（可直接执行）' : 'UI 格式（自动转换）'}</Tag>
              <Tag>{detail.node_count} 节点</Tag>
              {(detail.meta?.models || []).map((m: string) => <Tag key={m} color="cyan">{m}</Tag>)}
              {detail.meta?.sampler && <Tag color="purple">{detail.meta.sampler.sampler_name} · {detail.meta.sampler.steps}步 · cfg {detail.meta.sampler.cfg}</Tag>}
            </Space>
            {(detail.convert_warnings || []).length > 0 && (
              <div style={{ padding: 8, borderRadius: 6, background: 'rgb(var(--warning-1))', marginBottom: 10 }}>
                {(detail.convert_warnings as string[]).map((w, i) => <div key={i} style={{ fontSize: 12, color: 'rgb(var(--warning-6))' }}>⚠ {w}</div>)}
              </div>
            )}
            <Text style={{ fontWeight: 600, fontSize: 13 }}>可执行 API 格式（POST 到 ComfyUI 的 /prompt）</Text>
            <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 11, background: 'var(--color-fill-2)', padding: 10, borderRadius: 6 }}>
              {JSON.stringify(detail.api_preview, null, 1)}
            </pre>
            <Text type="secondary" style={{ fontSize: 12 }}>
              执行命令示例：<code>curl -X POST http://你的ComfyUI:8188/prompt -H 'Content-Type: application/json' -d @workflow-api.json</code>
            </Text>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default AdminComfyWorkflowPage
