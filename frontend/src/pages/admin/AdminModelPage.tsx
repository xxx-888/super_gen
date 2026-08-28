/**
 * AdminModelPage - 配置模型
 *
 * 管理 AI 模型配置：文生图、文生视频、TTS、ASR
 * 支持添加/编辑/启用/禁用/测试连接
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Table, Tag, Space, Spin, Modal, Form, Input, Select, InputNumber, Switch, Message, Popconfirm, Typography, Tooltip, Grid, Dropdown, Menu } from '@arco-design/web-react'
import { IconPlus, IconEdit, IconDelete, IconExperiment, IconCheckCircle, IconCloseCircle, IconApps, IconThunderbolt, IconSound, IconSearch, IconRefresh } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text } = Typography
const { Row, Col } = Grid

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
  minimax_self: 'MiniMax(自部署)',
  minimax_compshare: 'MiniMax(优云智算)',
  h3_ref2va: 'H3多图参考(自部署)',
  openai_tts: 'OpenAI TTS(语音合成)',
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
  minimax_self: {
    endpoint: 'https://8000-cpod-1tr9chnikmqn.pod.compshare.cn',
    models: [
      { label: 'DiffSynth-Studio/MiniMax-H3-NF4（自部署，文生视频）', value: 'DiffSynth-Studio/MiniMax-H3-NF4' },
    ],
  },
  minimax_compshare: {
    endpoint: 'https://cp.compshare.cn/minimax',
    models: [
      { label: 'MiniMax-H3（优云智算渠道，768P，4-15秒，支持取消）', value: 'MiniMax-H3' },
    ],
  },
  openai_tts: {
    endpoint: 'https://api.siliconflow.cn/v1',
    models: [
      { label: 'FunAudioLLM/CosyVoice2-0.5B（硅基流动，中文效果好）', value: 'FunAudioLLM/CosyVoice2-0.5B' },
      { label: 'fishaudio/fish-speech-1.5（硅基流动，音色 cloning）', value: 'fishaudio/fish-speech-1.5' },
      { label: 'tts-1（OpenAI 官方，endpoint 改 https://api.openai.com/v1）', value: 'tts-1' },
    ],
  },
  h3_ref2va: {
    endpoint: 'http://localhost:8300',
    models: [
      { label: 'MiniMax-H3-Ref2VA-NF4（自部署，多图参考生视频，~12分钟/条）', value: 'MiniMax-H3-Ref2VA-NF4' },
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
  const [toggling, setToggling] = useState<string | null>(null)
  // 筛选（type/provider/enabled 走后端参数；搜索在前端过滤名称/模型标识）
  const [fType, setFType] = useState<string | undefined>(undefined)
  const [fProvider, setFProvider] = useState<string | undefined>(undefined)
  const [fEnabled, setFEnabled] = useState<string | undefined>(undefined)
  const [fSearch, setFSearch] = useState('')

  const loadModels = async (opts?: { type?: string; provider?: string; enabled?: string }) => {
    setLoading(true)
    try {
      const params: any = {}
      const type = opts?.type !== undefined ? opts.type : fType
      const provider = opts?.provider !== undefined ? opts.provider : fProvider
      const enabled = opts?.enabled !== undefined ? opts.enabled : fEnabled
      if (type) params.type = type
      if (provider) params.provider = provider
      if (enabled != null && enabled !== '') params.enabled = enabled === '1'
      const data: any = await adminService.models.list(params)
      setModels(Array.isArray(data) ? data : [])
    } catch {
      setModels([])
    } finally {
      setLoading(false)
    }
  }

  // 行内启用/禁用切换（禁用的模型不会出现在任何下拉列表和接口调用中）
  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    setToggling(id)
    try {
      await adminService.models.update(id, { is_enabled: enabled })
      // 更新本地 state（无需重新拉列表）
      setModels(prev => prev.map((m: any) => m.id === id ? { ...m, is_enabled: enabled } : m))
      Message.success(enabled ? '已启用该模型' : '已禁用该模型')
    } catch (e: any) {
      Message.error(e?.message || '操作失败')
      // 恢复开关状态（失败时回滚）
      setModels(prev => prev.map((m: any) => m.id === id ? { ...m, is_enabled: !enabled } : m))
    } finally {
      setToggling(null)
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
      // MiniMax 自部署：图生视频的分镜图处理模式（text=纯文生忽略图片 / describe=图转文）
      if (values.image_mode) config.image_mode = values.image_mode
      // 视频生成轮询超时：留空则不写入 config（回落到「系统设置」全局默认）
      if (values.max_poll_seconds != null && values.max_poll_seconds !== '') {
        config.max_poll_seconds = values.max_poll_seconds
      } else {
        delete config.max_poll_seconds
      }
      if (values.poll_interval != null && values.poll_interval !== '') {
        config.poll_interval = values.poll_interval
      } else {
        delete config.poll_interval
      }
      // 最大输出 token：留空则不写入 config（用代码默认；写入后只会抬高请求上限）
      if (values.max_output_tokens != null && values.max_output_tokens !== '') {
        config.max_tokens = values.max_output_tokens
      } else {
        delete config.max_tokens
      }
      // 出站代理：留空则不走代理（config.proxy 由 openai 适配器 / LLM 客户端按模型读取）
      if (values.proxy && String(values.proxy).trim()) {
        config.proxy = String(values.proxy).trim()
      } else {
        delete config.proxy
      }
      delete values.model_name
      delete values.quality
      delete values.watermark_enabled
      delete values.reasoning_enabled
      delete values.reasoning_effort
      delete values.image_mode
      delete values.max_poll_seconds
      delete values.poll_interval
      delete values.max_output_tokens
      delete values.proxy
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
      image_mode: 'reference',
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

  // 快速添加自部署 MiniMax H3（一键填好端点 + 推荐模型 + 默认纯文生模式）
  const handleAddMinimaxSelf = () => {
    setEditingModel(null)
    form.resetFields()
    form.setFieldsValue({
      type: 'image_to_video',
      provider: 'minimax_self',
      name: 'MiniMax H3 自部署（文生视频）',
      endpoint: 'https://8000-cpod-1tr9chnikmqn.pod.compshare.cn',
      model_name: 'DiffSynth-Studio/MiniMax-H3-NF4',
      is_enabled: true,
      priority: 50,
      cost_per_request: 0,
      image_mode: 'reference',
      max_poll_seconds: 900,
      poll_interval: 5,
      description: '自部署 MiniMax-H3-NF4，OpenAI 兼容 /v1 接口，纯文生视频',
    })
    setModalVisible(true)
    Message.info('已填入 MiniMax 自部署预设，请补全 API Key 后保存')
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
      image_mode: m.config?.image_mode || 'reference',
      // 轮询超时：模型未单独配置则留空（显示 placeholder，回落到全局默认）
      max_poll_seconds: m.config?.max_poll_seconds ?? undefined,
      poll_interval: m.config?.poll_interval ?? undefined,
      max_output_tokens: m.config?.max_tokens ?? undefined,
      proxy: m.config?.proxy || m.config?.proxy_url || undefined,
    })
    setModalVisible(true)
  }

  const columns = [
    {
      // 名称 + 模型标识（config.model）合并一列；ID 列过长且低频，进编辑弹窗可见
      title: '名称', dataIndex: 'name', width: 200,
      render: (_: any, row: any) => (
        <div style={{ minWidth: 0 }}>
          <Text style={{ fontWeight: 600, display: 'block' }} ellipsis>{row.name}</Text>
          {row.config?.model && <Text type="secondary" style={{ fontSize: 11 }} ellipsis>{row.config.model}</Text>}
        </div>
      ),
    },
    { title: '类型', dataIndex: 'type', width: 90, render: (v: string) => <Tag color="arcoblue">{modelTypeMap[v] || v}</Tag> },
    { title: '提供方', dataIndex: 'provider', width: 120, render: (v: string) => (
      <Tooltip content={providerMap[v] || v}>
        <Tag style={{
          maxWidth: 102, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', display: 'inline-block',
        }}>{providerMap[v] || v}</Tag>
      </Tooltip>
    ) },
    { title: '端点', dataIndex: 'endpoint', ellipsis: true },
    { title: '优先级', dataIndex: 'priority', width: 70, align: 'center' as const },
    { title: '单次成本', dataIndex: 'cost_per_request', width: 90, align: 'center' as const, render: (v: number) => v ? `¥${v}` : '-' },
    {
      title: '状态', dataIndex: 'is_enabled', width: 120,
      render: (v: boolean, row: any) => (
        <Space>
          <Switch
            checked={v}
            loading={toggling === row.id}
            onChange={(checked: boolean) => handleToggleEnabled(row.id, checked)}
          />
          {testResults[row.id] === 'success' && <IconCheckCircle style={{ color: 'rgb(var(--success-6))' }} />}
          {testResults[row.id] === 'failed' && <IconCloseCircle style={{ color: 'rgb(var(--danger-6))' }} />}
        </Space>
      ),
    },
    {
      title: '操作', width: 130, fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button size="mini" type="text" icon={<IconExperiment />} loading={testing === row.id} title="测试连通" onClick={() => handleTest(row.id)} />
          <Button size="mini" type="text" icon={<IconEdit />} title="编辑" onClick={() => handleEdit(row)} />
          <Popconfirm title="确认删除该模型配置？" onOk={() => handleDelete(row.id)}>
            <Button size="mini" type="text" status="danger" icon={<IconDelete />} title="删除" />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // 前端搜索过滤（名称 / 模型标识 / 端点）
  const filteredModels = models.filter((m: any) => {
    if (!fSearch) return true
    const kw = fSearch.toLowerCase()
    return (m.name || '').toLowerCase().includes(kw)
      || (m.config?.model || '').toLowerCase().includes(kw)
      || (m.endpoint || '').toLowerCase().includes(kw)
  })

  // 统计（全量口径，基于未筛选数据）
  const statTotal = models.length
  const statEnabled = models.filter((m: any) => m.is_enabled).length
  const statByType = models.reduce((acc: Record<string, number>, m: any) => {
    acc[m.type] = (acc[m.type] || 0) + 1
    return acc
  }, {})

  return (
    <div>
      {/* 汇总统计卡（当前筛选口径） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconApps style={{ fontSize: 22, color: 'rgb(var(--arcoblue-6))' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>模型总数</Text>
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
            <IconThunderbolt style={{ fontSize: 22, color: 'rgb(var(--orange-6))' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>生图模型</Text>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{statByType.text_to_image || 0}</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>生视频 {statByType.image_to_video || 0} · LLM {statByType.llm || 0}</div>
        </Card></Col>
        <Col span={6}><Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconSound style={{ fontSize: 22, color: 'rgb(var(--purple-6))' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>语音模型</Text>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>{(statByType.tts || 0) + (statByType.asr || 0)}</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>合成 {statByType.tts || 0} · 识别 {statByType.asr || 0}</div>
        </Card></Col>
      </Row>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Title heading={5} style={{ margin: 0 }}>配置模型</Title>
        <Space size={8} wrap>
          <Input
            placeholder="搜索名称 / 模型标识 / 端点"
            style={{ width: 200 }}
            value={fSearch}
            onChange={setFSearch}
            allowClear
            prefix={<IconSearch />}
          />
          <Select
            placeholder="类型" style={{ width: 110 }} allowClear value={fType}
            onChange={(v) => { setFType(v); loadModels({ type: v }) }}
          >
            <Select.Option value="text_to_image">文生图</Select.Option>
            <Select.Option value="image_to_video">图生视频</Select.Option>
            <Select.Option value="tts">语音合成</Select.Option>
            <Select.Option value="asr">语音识别</Select.Option>
            <Select.Option value="llm">大语言模型</Select.Option>
          </Select>
          <Select
            placeholder="提供方" style={{ width: 150 }} allowClear value={fProvider}
            onChange={(v) => { setFProvider(v); loadModels({ provider: v }) }}
          >
            {['zhipu', 'deepseek', 'minimax', 'minimax_compshare', 'minimax_self', 'h3_ref2va', 'openai', 'openai_tts', 'local', 'cloud_api', 'comfyui'].map((p) => (
              <Select.Option key={p} value={p}>{providerMap[p] || p}</Select.Option>
            ))}
          </Select>
          <Select
            placeholder="状态" style={{ width: 100 }} allowClear value={fEnabled}
            onChange={(v) => { setFEnabled(v); loadModels({ enabled: v }) }}
          >
            <Select.Option value="1">启用</Select.Option>
            <Select.Option value="0">禁用</Select.Option>
          </Select>
          <Button icon={<IconRefresh />} onClick={() => loadModels({})}>刷新</Button>
          <Dropdown
            position="br"
            droplist={
              <Menu onClickMenuItem={(key: string) => {
                if (key === 'deepseek') handleAddDeepSeek()
                else if (key === 'minimax') handleAddMinimaxSelf()
              }}>
                <Menu.Item key="deepseek">DeepSeek（剧本解析推荐）</Menu.Item>
                <Menu.Item key="minimax">MiniMax 自部署（文生视频 H3-NF4）</Menu.Item>
              </Menu>
            }
          >
            <Button>快速添加</Button>
          </Dropdown>
          <Button type="primary" icon={<IconPlus />} onClick={handleAdd}>添加模型</Button>
        </Space>
      </div>

      <Card>
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : (
          <Table columns={columns} data={filteredModels} rowKey="id" pagination={{ pageSize: 10, sizeCanChange: true, sizeOptions: [10, 20, 50] }} noDataElement="暂无模型配置" />
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
              <Select.Option value="minimax_compshare">MiniMax（优云智算渠道 H3）</Select.Option>
              <Select.Option value="minimax_self">MiniMax 自部署（文生视频 H3-NF4）</Select.Option>
              <Select.Option value="h3_ref2va">H3 自部署（多图参考生视频 Ref2VA）</Select.Option>
              <Select.Option value="openai">OpenAI</Select.Option>
              <Select.Option value="openai_tts">OpenAI TTS（语音合成/硅基流动 CosyVoice）</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item field="endpoint" label="端点 URL" rules={[{ required: true }]}>
            <Input placeholder="MiniMax: https://api.minimaxi.com | 智谱: https://open.bigmodel.cn/api/paas/v4" />
          </Form.Item>
          <Form.Item
            field="api_key" label="API Key" rules={[{ required: true }]}
            extra={editingModel?.id ? '显示为 abcd****wxyz 的脱敏值时保持原 Key 不变；需要更换请输入完整新 Key' : undefined}
          >
            <Input.Password placeholder="在对应平台申请的 API Key（敏感信息，加密存储）" />
          </Form.Item>
          <Form.Item field="model_name" label="模型标识（model）" rules={[{ required: true }]}>
            <Input placeholder="deepseek-v4-pro / deepseek-v4-flash / glm-4-flash" />
          </Form.Item>
          <Form.Item field="max_output_tokens" label="最大输出 token（max_tokens）" tooltip="LLM 输出上限；只会抬高请求、不会调小。推理模型思考也计入输出额度，正文为空时可调大（如 32768）。留空用代码默认">
            <InputNumber min={1024} max={65536} step={4096} style={{ width: '100%' }} placeholder="留空用默认（解析 16384）" />
          </Form.Item>
          <Form.Item field="proxy" label="出站代理（仅该模型生效）" tooltip="端点在大陆不可直连时配置（如 api.openai.com）。支持 http://、socks5://（可带用户名密码）与 socks5h://（推荐：域名由代理解析，规避 DNS 污染）。留空不走代理，不影响其他模型">
            <Input allowClear placeholder="socks5h://用户:密码@代理IP:端口（留空不走代理）" />
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
          {/* 视频生成轮询超时：对所有异步轮询的视频模型可见（minimax / minimax_self / zhipu）。
              不填则回落到「系统设置」里的全局默认 task_poll_timeout_seconds。 */}
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.provider !== cur.provider}>
            {(formData) => {
              const provider = formData.provider
              const isVideoProvider = ['minimax', 'minimax_self', 'minimax_compshare', 'h3_ref2va', 'zhipu'].includes(provider)
              if (!isVideoProvider) return null
              return (
                <div style={{ padding: 12, background: 'var(--color-fill-2)', borderRadius: 8, marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>视频生成超时</div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                    云端视频生成（如 MiniMax H3）耗时较长，超时后任务标记失败并退还积分。留空则使用「系统设置」里的全局默认值。
                  </Text>
                  <Space size="large" align="center">
                    <Form.Item field="max_poll_seconds" label="最大轮询时长（秒）" style={{ marginBottom: 0 }}>
                      <InputNumber min={60} max={3600} step={60} style={{ width: 140 }} placeholder="留空用全局默认" />
                    </Form.Item>
                    <Form.Item field="poll_interval" label="轮询间隔（秒）" style={{ marginBottom: 0 }}>
                      <InputNumber min={1} max={60} style={{ width: 120 }} placeholder="默认 5" />
                    </Form.Item>
                  </Space>
                </div>
              )
            }}
          </Form.Item>
          {/* MiniMax 自部署：分镜图处理模式（仅 minimax_self 显示） */}
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.provider !== cur.provider}>
            {(formData) => {
              const provider = formData.provider
              if (provider !== 'minimax_self') return null
              return (
                <div style={{ padding: 12, background: 'var(--color-fill-2)', borderRadius: 8, marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>分镜图处理模式（自部署 MiniMax 专属）</div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                    选择如何处理分镜时上传的参考图（角色/场景/道具图片）。不同模式效果差异大。
                  </Text>
                  <Form.Item field="image_mode" label="处理模式" style={{ marginBottom: 0 }}>
                    <Select style={{ width: '100%' }}>
                      <Select.Option value="reference">参考图融合生成 ref2va（推荐，效果最好）</Select.Option>
                      <Select.Option value="first_frame">首帧驱动生成 fl2va（首帧图→视频）</Select.Option>
                      <Select.Option value="describe">图转文（先视觉描述图片再文生，旧降级方案）</Select.Option>
                      <Select.Option value="text">纯文生视频 t2va（忽略图片）</Select.Option>
                    </Select>
                  </Form.Item>
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
          <Form.Item field="watermark_enabled" label="添加水印" triggerPropName="checked" tooltip="关闭水印需在智谱个人中心签署免责声明">
            <Switch />
          </Form.Item>
          <Form.Item field="priority" label="优先级（数字越大越优先）"><InputNumber min={0} max={100} /></Form.Item>
          <Form.Item field="cost_per_request" label="单次成本（元）"><InputNumber min={0} step={0.01} /></Form.Item>
          <Form.Item field="is_enabled" label="启用" triggerPropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default AdminModelPage
