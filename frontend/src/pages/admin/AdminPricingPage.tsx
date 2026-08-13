/**
 * AdminPricingPage - 积分计价配置
 *
 * 维护 credit_pricing 规则：按「模型? + 任务类型 + 分辨率? + 尺寸?」配置单价。
 * - ai_model_id 为空 = 该任务类型的全局默认规则
 * - billing_mode: fixed(单次) / per_second(视频按秒，credits=每秒单价)
 * - 算价时取最具体（非空维度最多、其次 priority 最高）的命中规则；无命中回退内置默认价
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Table, Tag, Space, Spin, Modal, Form, Input, Select, InputNumber, Switch, Message, Popconfirm, Typography } from '@arco-design/web-react'
import { IconPlus, IconEdit, IconDelete } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text } = Typography

const TASK_TYPES = [
  { value: 'image', label: '文生图' },
  { value: 'image_edit', label: '图片编辑' },
  { value: 'image_to_video', label: '图生视频' },
  { value: 'first_last_frame', label: '首尾帧' },
  { value: 'fusion', label: '融生视频' },
  { value: 'tts', label: 'TTS 语音' },
  { value: 'lip_sync', label: '对口型' },
  { value: 'subtitle', label: '字幕' },
  { value: 'script_parse', label: '剧本解析' },
]
const RESOLUTION_OPTIONS = ['480p', '720p', '768p', '1080p', '2K']
const SIZE_OPTIONS = ['1:1', '3:4', '16:9', '9:16', '4:3']
const taskLabel = (v: string) => TASK_TYPES.find(t => t.value === v)?.label || v

const AdminPricingPage: React.FC = () => {
  const [rules, setRules] = useState<any[]>([])
  const [models, setModels] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modalVisible, setModalVisible] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [filterTaskType, setFilterTaskType] = useState<string>('')

  const load = async () => {
    setLoading(true)
    try {
      const [data, modelList]: any = await Promise.all([
        adminService.pricing.list(filterTaskType ? { task_type: filterTaskType } : undefined),
        adminService.models.list(),
      ])
      setRules(Array.isArray(data) ? data : [])
      setModels(Array.isArray(modelList) ? modelList : [])
    } catch {
      setRules([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filterTaskType])

  const handleAdd = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      ai_model_id: '', task_type: 'image', resolution: '', size: '',
      billing_mode: 'fixed', credits: 1, priority: 0, is_enabled: true, note: '',
    })
    setModalVisible(true)
  }

  const handleEdit = (row: any) => {
    setEditing(row)
    form.setFieldsValue({
      ...row,
      ai_model_id: row.ai_model_id || '',
      resolution: row.resolution || '',
      size: row.size || '',
    })
    setModalVisible(true)
  }

  const handleSave = async () => {
    try {
      const v = await form.validate()
      const payload = {
        ...v,
        ai_model_id: v.ai_model_id || null,
        resolution: v.resolution || null,
        size: v.size || null,
      }
      setSaving(true)
      if (editing?.id) {
        await adminService.pricing.update(editing.id, payload)
      } else {
        await adminService.pricing.create(payload)
      }
      Message.success('保存成功')
      setModalVisible(false)
      setEditing(null)
      load()
    } catch (err: any) {
      if (err?.errors) return
      Message.error(err?.response?.data?.detail || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await adminService.pricing.delete(id)
      Message.success('删除成功')
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  const columns = [
    { title: '任务类型', dataIndex: 'task_type', width: 110, render: (v: string) => <Tag color="arcoblue">{taskLabel(v)}</Tag> },
    {
      title: '适用模型', dataIndex: 'ai_model_name', width: 180, ellipsis: true,
      render: (_: any, row: any) => row.ai_model_id
        ? <Text style={{ fontSize: 13 }}>{row.ai_model_name || row.ai_model_id}</Text>
        : <Tag color="green">全局默认</Tag>,
    },
    { title: '分辨率', dataIndex: 'resolution', width: 90, align: 'center' as const, render: (v: string) => v || <Text type="secondary">任意</Text> },
    { title: '尺寸', dataIndex: 'size', width: 80, align: 'center' as const, render: (v: string) => v || <Text type="secondary">任意</Text> },
    {
      title: '计价方式', dataIndex: 'billing_mode', width: 100, align: 'center' as const,
      render: (v: string) => v === 'per_second'
        ? <Tag color="orange">按秒</Tag>
        : <Tag color="gray">单次</Tag>,
    },
    {
      title: '积分', dataIndex: 'credits', width: 90, align: 'center' as const,
      render: (v: number, row: any) => <Text type="warning" style={{ fontWeight: 600 }}>{v}{row.billing_mode === 'per_second' ? ' /秒' : ''}</Text>,
    },
    { title: '优先级', dataIndex: 'priority', width: 70, align: 'center' as const },
    {
      title: '状态', width: 80, align: 'center' as const,
      render: (_: any, row: any) => <Tag color={row.is_enabled ? 'green' : 'gray'}>{row.is_enabled ? '启用' : '禁用'}</Tag>,
    },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : '-' },
    {
      title: '操作', width: 140, fixed: 'right' as const, render: (_: any, row: any) => (
        <Space>
          <Button size="small" icon={<IconEdit />} onClick={() => handleEdit(row)}>编辑</Button>
          <Popconfirm title="确认删除该计价规则？" onOk={() => handleDelete(row.id)}>
            <Button size="small" status="danger" icon={<IconDelete />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <Title heading={5} style={{ margin: 0 }}>积分计价配置</Title>
        <Space>
          <Select
            value={filterTaskType || undefined}
            onChange={(v) => setFilterTaskType(v || '')}
            placeholder="全部任务类型"
            style={{ width: 160 }}
            allowClear
          >
            {TASK_TYPES.map(t => <Select.Option key={t.value} value={t.value}>{t.label}</Select.Option>)}
          </Select>
          <Button type="primary" icon={<IconPlus />} onClick={handleAdd}>添加规则</Button>
        </Space>
      </div>

      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        每条规则按「模型 + 任务类型 + 分辨率 + 尺寸」计价；留空表示通配。算价时取最具体的命中规则，未命中则回退内置默认价。视频选「按秒」时积分为 每秒单价 × 时长。
      </Text>

      <Card>
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : (
          <Table columns={columns} data={rules} rowKey="id" pagination={{ pageSize: 15 }} />
        )}
      </Card>

      <Modal
        title={editing?.id ? `编辑规则：${taskLabel(editing.task_type)}` : '添加计价规则'}
        visible={modalVisible}
        onCancel={() => { setModalVisible(false); setEditing(null) }}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        style={{ width: 620, maxWidth: '90vw' }}
      >
        <Form form={form} layout="vertical">
          <Form.Item field="ai_model_id" label="适用模型" tooltip="留空 = 该任务类型的全局默认规则（所有模型都适用）">
            <Select placeholder="全局默认（不指定模型）" allowClear>
              {models.map((m: any) => (
                <Select.Option key={m.id} value={m.id}>{m.name}（{m.type}）</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item field="task_type" label="任务类型" rules={[{ required: true, message: '请选择任务类型' }]}>
            <Select>
              {TASK_TYPES.map(t => <Select.Option key={t.value} value={t.value}>{t.label}</Select.Option>)}
            </Select>
          </Form.Item>
          <Space wrap>
            <Form.Item field="resolution" label="分辨率（留空=任意）" style={{ width: 180 }}>
              <Select placeholder="任意" allowClear>
                {RESOLUTION_OPTIONS.map(r => <Select.Option key={r} value={r}>{r}</Select.Option>)}
              </Select>
            </Form.Item>
            <Form.Item field="size" label="尺寸（留空=任意）" style={{ width: 180 }}>
              <Select placeholder="任意" allowClear>
                {SIZE_OPTIONS.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
              </Select>
            </Form.Item>
          </Space>
          <Space wrap>
            <Form.Item field="billing_mode" label="计价方式" rules={[{ required: true }]} style={{ width: 180 }}>
              <Select>
                <Select.Option value="fixed">单次（固定积分）</Select.Option>
                <Select.Option value="per_second">按秒（每秒单价 × 时长）</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item field="credits" label="积分/每秒单价" extra="可填小数，如 1.5；扣费时向上取整" rules={[{ required: true, message: '请填积分' }]} style={{ width: 200 }}>
              <InputNumber min={0} max={100000} step={0.5} precision={2} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item field="priority" label="优先级" style={{ width: 120 }} tooltip="同特异性下，数字大的优先命中">
              <InputNumber min={0} max={1000} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item field="note" label="备注">
            <Input placeholder="如：图生视频 1080p" />
          </Form.Item>
          <Form.Item field="is_enabled" label="启用" triggerPropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default AdminPricingPage
