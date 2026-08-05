/**
 * AdminModelPage - 配置模型
 *
 * 管理 AI 模型配置：文生图、文生视频、TTS、ASR
 * 支持添加/编辑/启用/禁用/测试连接
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Table, Tag, Space, Spin, Modal, Form, Input, Select, InputNumber, Switch, Message, Popconfirm, Typography } from '@arco-design/web-react'
import { IconPlus, IconEdit, IconDelete, IconExperiment, IconCheckCircle, IconCloseCircle } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text } = Typography

const modelTypeMap: Record<string, string> = {
  text_to_image: '文生图',
  image_to_video: '图生视频',
  tts: '语音合成',
  asr: '语音识别',
  llm: '大语言模型',
}

const providerMap: Record<string, string> = {
  local: '本地模型',
  cloud_api: '云端API',
  comfyui: 'ComfyUI',
  zhipu: '智谱GLM',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  openai: 'OpenAI',
}

// 厂商一键预设：选 provider 后点「填充」可快速补全 endpoint + 推荐模型
const PROVIDER_PRESETS: Record<string, { endpoint: string; models: { label: string; value: string }[]; reasoning?: boolean }> = {
  deepseek: {
    endpoint: 'https://api.deepseek.com',
    models: [
      { label: 'deepseek-v4-pro（推理强，适合复杂剧本解析）', value: 'deepseek-v4-pro' },
      { label: 'deepseek-v4-flash（快速、低成本）', value: 'deepseek-v4-flash' },
    ],
    reasoning: true,
  },
  zhipu: {
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { label: 'glm-4-flash（免费档）', value: 'glm-4-flash' },
      { label: 'glm-4', value: 'glm-4' },
      { label: 'glm-4-plus', value: 'glm-4-plus' },
    ],
  },
  openai: {
    endpoint: 'https://api.openai.com/v1',
    models: [
      { label: 'gpt-4o', value: 'gpt-4o' },
      { label: 'gpt-4o-mini', value: 'gpt-4o-mini' },
    ],
  },
  minimax: {
    endpoint: 'https://api.minimaxi.com',
    models: [
      { label: 'MiniMax-H3（图生视频/文生视频，2K直出）', value: 'MiniMax-H3' },
    ],
  },
}

const AdminModelPage: React.FC = () => {
  const [models, setModels] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingModel, setEditingModel] = useState<any>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, 'success' | 'failed' | null>>({})

  const loadModels = async () => {
    setLoading(true)
    try {
      const data: any = await adminService.models.list()
      setModels(Array.isArray(data) ? data : [])
    } catch {
      setModels([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadModels() }, [])

  const handleSave = async () => {
    try {
      const values = await form.validate()
      setSaving(true)
      // 把"模型标识/质量/水印/推理"字段合并进 config（后台 JSONB 字段）
      const existingConfig = (editingModel?.config) || {}
      const config = { ...existingConfig }
      if (values.model_name) config.model = values.model_name
      if (values.quality) config.quality = values.quality
      config.watermark_enabled = values.watermark_enabled === true || values.watermark_enabled === 'true'
      // DeepSeek 推理参数：thinking / reasoning_effort（透传到 /chat/completions）
      if (values.reasoning_enabled) {
        config.thinking = { type: 'enabled' }
        if (values.reasoning_effort) config.reasoning_effort = values.reasoning_effort
      } else {
        delete config.thinking
        delete config.reasoning_effort
      }
      delete values.model_name
      delete values.quality
      delete values.watermark_enabled
      delete values.reasoning_enabled
      delete values.reasoning_effort
      const payload = { ...values, config }
      if (editingModel?.id) {
        await adminService.models.update(editingModel.id, payload)
      } else {
        await adminService.models.create(payload)
      }
      Message.success('保存成功')
      setModalVisible(false)
      setEditingModel(null)
      loadModels()
    } catch (err: any) {
      if (err?.errors) return
      Message.error(err?.response?.data?.detail || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (id: string) => {
    setTesting(id)
    try {
      const res: any = await adminService.models.test(id)
      if (res?.status === 'success') {
        Message.success(res.message || '连接测试成功')
        setTestResults({ ...testResults, [id]: 'success' })
      } else {
        Message.warning(res?.message || '测试完成，但模型未配置')
        setTestResults({ ...testResults, [id]: 'failed' })
      }
    } catch (err: any) {
      Message.warning(err?.response?.data?.detail || '测试失败')
      setTestResults({ ...testResults, [id]: 'failed' })
    } finally {
      setTesting(null)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await adminService.models.delete(id)
      Message.success('删除成功')
      loadModels()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  const handleAdd = () => {
    setEditingModel(null)
    form.resetFields()
    form.setFieldsValue({
      type: 'llm', provider: 'deepseek', is_enabled: true,
      priority: 0, cost_per_request: 0, reasoning_enabled: false, reasoning_effort: 'high',
    })
    setModalVisible(true)
  }

  // 快速添加 DeepSeek（一键填好端点 + 推荐模型 + 推理参数）
  const handleAddDeepSeek = () => {
    setEditingModel(null)
    form.resetFields()
    form.setFieldsValue({
      type: 'llm',
      provider: 'deepseek',
      name: 'DeepSeek 剧本解析',
      endpoint: 'https://api.deepseek.com',
      model_name: 'deepseek-v4-pro',
      is_enabled: true,
      priority: 100,
      cost_per_request: 0,
      reasoning_enabled: true,
      reasoning_effort: 'high',
      description: 'DeepSeek 推理模型，剧本解析能力强',
    })
    setModalVisible(true)
    Message.info('已填入 DeepSeek 预设，请补全 API Key 后保存')
  }

  // 选定 provider 后按需自动补全端点（仅当端点为空时）
  const handleProviderChange = (provider: string) => {
    form.setFieldValue('provider', provider)
    const preset = PROVIDER_PRESETS[provider]
    if (preset) {
      const cur = form.getFieldValue('endpoint')
      if (!cur) form.setFieldValue('endpoint', preset.endpoint)
    }
  }

  const handleEdit = (m: any) => {
    setEditingModel(m)
    form.setFieldsValue({
      ...m, model_name: m.config?.model,
      quality: m.config?.quality || 'hd',
      watermark_enabled: m.config?.watermark_enabled ?? false,
      reasoning_enabled: !!m.config?.thinking,
      reasoning_effort: m.config?.reasoning_effort || 'high',
    })
    setModalVisible(true)
  }

  const columns = [
    { title: '模型 ID', dataIndex: 'id', width: 140 },
    { title: '名称', dataIndex: 'name', width: 160 },
    { title: '类型', dataIndex: 'type', width: 100, render: (v: string) => <Tag color="arcoblue">{modelTypeMap[v] || v}</Tag> },
    { title: '提供方', dataIndex: 'provider', width: 100, render: (v: string) => <Tag>{providerMap[v] || v}</Tag> },
    { title: '端点', dataIndex: 'endpoint', ellipsis: true },
    { title: '优先级', dataIndex: 'priority', width: 80 },
    { title: '单次成本', dataIndex: 'cost_per_request', width: 100, render: (v: number) => v ? `¥${v}` : '-' },
    {
      title: '状态', dataIndex: 'is_enabled', width: 100,
      render: (v: boolean, row: any) => (
        <Space>
          <Tag color={v ? 'green' : 'gray'}>{v ? '启用' : '禁用'}</Tag>
          {testResults[row.id] === 'success' && <IconCheckCircle style={{ color: 'rgb(var(--success-6))' }} />}
          {testResults[row.id] === 'failed' && <IconCloseCircle style={{ color: 'rgb(var(--danger-6))' }} />}
        </Space>
      ),
    },
    {
      title: '操作', width: 260,
    render: (_: any, row: any) => (
      <Space>
        <Button size="small" icon={<IconExperiment />} loading={testing === row.id} onClick={() => handleTest(row.id)}>测试</Button>
        <Button size="small" icon={<IconEdit />} onClick={() => handleEdit(row)}>编辑</Button>
        <Popconfirm title="确认删除该模型配置？" onOk={() => handleDelete(row.id)}>
          <Button size="small" status="danger" icon={<IconDelete />}>删除</Button>
        </Popconfirm>
      </Space>
    ),
  },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <Title heading={5} style={{ margin: 0 }}>配置模型</Title>
        <Space>
          <Button onClick={handleAddDeepSeek}>快速添加 DeepSeek</Button>
          <Button type="primary" icon={<IconPlus />} onClick={handleAdd}>添加模型</Button>
        </Space>
      </div>

      <Card>
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : (
          <Table columns={columns} data={models} rowKey="id" pagination={{ pageSize: 10 }} noDataElement="暂无模型配置（后端骨架尚未实现）" />
        )}
      </Card>

      {/* 编辑弹窗 */}
      <Modal
        title={editingModel?.id ? `编辑模型：${editingModel.name}` : '添加模型配置'}
        visible={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item field="name" label="模型名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item field="type" label="类型" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="text_to_image">文生图</Select.Option>
              <Select.Option value="image_to_video">图生视频</Select.Option>
              <Select.Option value="tts">语音合成</Select.Option>
              <Select.Option value="asr">语音识别</Select.Option>
              <Select.Option value="llm">大语言模型（Agent 决策）</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item field="provider" label="提供方" rules={[{ required: true }]}>
            <Select onChange={(v) => handleProviderChange(v)}>
              <Select.Option value="local">本地模型</Select.Option>
              <Select.Option value="cloud_api">云端API</Select.Option>
              <Select.Option value="comfyui">ComfyUI</Select.Option>
              <Select.Option value="zhipu">智谱GLM</Select.Option>
              <Select.Option value="deepseek">DeepSeek（剧本解析推荐）</Select.Option>
              <Select.Option value="minimax">MiniMax（图生视频 H3）</Select.Option>
              <Select.Option value="openai">OpenAI</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item field="endpoint" label="端点 URL" rules={[{ required: true }]}>
            <Input placeholder="MiniMax: https://api.minimaxi.com | 智谱: https://open.bigmodel.cn/api/paas/v4" />
          </Form.Item>
          <Form.Item field="api_key" label="API Key" rules={[{ required: true }]}>
            <Input.Password placeholder="在对应平台申请的 API Key（敏感信息，加密存储）" />
          </Form.Item>
          <Form.Item field="model_name" label="模型标识（model）" rules={[{ required: true }]}>
            <Input placeholder="deepseek-v4-pro / deepseek-v4-flash / glm-4-flash" />
          </Form.Item>
          {/* DeepSeek 推理参数（仅对支持推理的模型有意义，如 deepseek-v4-pro） */}
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.provider !== cur.provider}>
            {(formData) => {
              const provider = formData.provider
              const showReasoning = provider === 'deepseek'
              if (!showReasoning) return null
              return (
                <div style={{ padding: 12, background: 'var(--color-fill-2)', borderRadius: 8, marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>推理参数（DeepSeek 专属）</div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                    开启后模型会先「思考」再输出，剧本解析更精准，但耗时和成本更高。
                  </Text>
                  <Space size="large" align="center">
                    <Form.Item field="reasoning_enabled" label="开启推理" triggerPropName="checked" style={{ marginBottom: 0 }}>
                      <Switch />
                    </Form.Item>
                    <Form.Item field="reasoning_effort" label="推理强度" style={{ marginBottom: 0 }}>
                      <Select style={{ width: 120 }}>
                        <Select.Option value="high">high（最精准）</Select.Option>
                        <Select.Option value="medium">medium（均衡）</Select.Option>
                        <Select.Option value="low">low（快速）</Select.Option>
                      </Select>
                    </Form.Item>
                  </Space>
                </div>
              )
            }}
          </Form.Item>
          <Form.Item field="quality" label="生成质量（仅文生图）" tooltip="hd 高质量约20秒；standard 快速约5-10秒。glm-image 仅支持 hd">
            <Select defaultValue="hd">
              <Select.Option value="hd">hd（高质量，glm-image 仅支持此项）</Select.Option>
              <Select.Option value="standard">standard（快速，cogview 系列可用）</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item field="watermark_enabled" label="添加水印" tooltip="关闭水印需在智谱个人中心签署免责声明">
            <Switch />
          </Form.Item>
          <Form.Item field="priority" label="优先级（数字越大越优先）"><InputNumber min={0} max={100} /></Form.Item>
          <Form.Item field="cost_per_request" label="单次成本（元）"><InputNumber min={0} step={0.01} /></Form.Item>
          <Form.Item field="is_enabled" label="启用"><Switch /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default AdminModelPage
