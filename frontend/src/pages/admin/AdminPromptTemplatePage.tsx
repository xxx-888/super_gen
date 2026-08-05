/**
 * AdminPromptTemplatePage - 提示词模板管理
 *
 * 管理 AI 任务的 system prompt 模板（剧本解析、分镜生成等）。
 * 支持分类(category)、子模式(mode)、默认模板、启用/禁用、增删改。
 * 剧本解析时会按 category=script_parse + mode 自动选用默认模板。
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Table, Tag, Space, Spin, Modal, Form, Input, Select, InputNumber, Switch, Message, Popconfirm, Typography } from '@arco-design/web-react'
import { IconPlus, IconEdit, IconDelete } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input

const categoryMap: Record<string, { label: string; color: string }> = {
  script_parse: { label: '剧本解析', color: 'arcoblue' },
  shot_generate: { label: '分镜生成', color: 'green' },
  character_generate: { label: '角色生成', color: 'purple' },
  scene_generate: { label: '场景生成', color: 'orange' },
  custom: { label: '自定义', color: 'gray' },
}

// 内置默认模板（剧本解析 fusion）—— 一键导入用，避免用户从零写
const BUILTIN_FUSION_PROMPT = `你是专业短剧分镜导演。分析用户给的剧本，输出 JSON 用于 AI 视频生成（融生模式：每个分镜直接生成视频）。

## 提取内容与字段

### 角色 characters[]
- name: 角色名（必填。无论剧本是对话体还是第一人称叙事体，都要把出场人物的名字提取出来）
- description: 身份简介（10-20字）
- appearance_prompt: 外貌描述（必填，用于AI生图：性别、年龄段、发型、脸型、典型服饰、气质）

### 场景 scenes[]
- name: 场景名
- description: 简介
- prompt: 画面描述（必填，用于AI生图：空间布局、光线、陈设、风格）

### 道具 props[]
- name: 名称
- description: 外观描述

### 分镜 shots[]
- sequence: 序号（整数，从1递增）
- duration: 时长秒数（3-8）
- location: 场景名（与上面 scenes.name 对应）
- characters: [{"name":"角色名","pose":"动作姿态描述"}]
- shot_type: 景别（远景/全景/中景/近景/特写）
- camera_movement: 运镜（静止/缓慢推进/缓慢平移/环绕/升降）
- narration: 这一镜的台词或旁白
- prompt: 画面提示词（必填，完整画面描述）

## 分镜拆分规则
- 每个对话轮次或重要动作单独成一个分镜
- 场景切换必须新开分镜
- 情绪/剧情转折单独分镜
- 第一人称叙事剧本：按「一段连续动作或一次对话」切分，不要整段塞进一个分镜

## 输出要求（极其重要）
- 只输出一个 JSON 对象，不要输出任何其他文字
- 不要使用 markdown 代码块标记
- 第一个字符必须是 { ，最后一个字符必须是 }
- 字符串值内不要包含未转义的双引号和换行符
- 所有数组都用 [] 包裹
- 每个分镜的 prompt 字段必须填写完整的画面描述，不能为空

## 输出格式示例
{"characters":[{"name":"角色名","description":"简介","appearance_prompt":"外貌"}],"scenes":[{"name":"场景名","description":"简介","prompt":"画面描述"}],"props":[{"name":"道具名","description":"描述"}],"shots":[{"sequence":1,"duration":5,"location":"场景名","characters":[{"name":"角色名","pose":"姿态"}],"shot_type":"中景","camera_movement":"静止","narration":"台词","prompt":"写实电影质感，场景描述，角色外貌姿态，中景，静止"}]}`

const AdminPromptTemplatePage: React.FC = () => {
  const [templates, setTemplates] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modalVisible, setModalVisible] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [filterCategory, setFilterCategory] = useState<string>('')

  const load = async () => {
    setLoading(true)
    try {
      const data: any = await adminService.promptTemplates.list(
        filterCategory ? { category: filterCategory } : undefined
      )
      setTemplates(Array.isArray(data) ? data : [])
    } catch {
      setTemplates([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filterCategory])

  const handleSave = async () => {
    try {
      const values = await form.validate()
      setSaving(true)
      if (editing?.id) {
        await adminService.promptTemplates.update(editing.id, values)
      } else {
        await adminService.promptTemplates.create(values)
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
      await adminService.promptTemplates.delete(id)
      Message.success('删除成功')
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  const handleAdd = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      category: 'script_parse', mode: 'fusion', is_enabled: true,
      is_default: false, priority: 0,
    })
    setModalVisible(true)
  }

  const handleEdit = (t: any) => {
    setEditing(t)
    form.setFieldsValue(t)
    setModalVisible(true)
  }

  // 一键导入内置默认 fusion 模板，方便用户在此基础上微调
  const handleImportBuiltin = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      name: '剧本解析-融生（内置）',
      category: 'script_parse',
      mode: 'fusion',
      content: BUILTIN_FUSION_PROMPT,
      description: '内置默认模板的副本，可自由修改',
      is_enabled: true,
      is_default: false,
      priority: 10,
    })
    setModalVisible(true)
  }

  const columns = [
    { title: '名称', dataIndex: 'name', width: 200 },
    {
      title: '分类', dataIndex: 'category', width: 120,
      render: (v: string) => {
        const m = categoryMap[v]
        return <Tag color={m?.color || 'gray'}>{m?.label || v}</Tag>
      },
    },
    { title: '子模式', dataIndex: 'mode', width: 130, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: '内容预览', dataIndex: 'content', ellipsis: true,
      render: (v: string) => <Text type="secondary">{(v || '').slice(0, 60)}…</Text>,
    },
    { title: '优先级', dataIndex: 'priority', width: 80 },
    {
      title: '状态', width: 140,
      render: (_: any, row: any) => (
        <Space>
          <Tag color={row.is_enabled ? 'green' : 'gray'}>{row.is_enabled ? '启用' : '禁用'}</Tag>
          {row.is_default && <Tag color="orange">默认</Tag>}
        </Space>
      ),
    },
    {
      title: '操作', width: 160,
      render: (_: any, row: any) => (
        <Space>
          <Button size="small" icon={<IconEdit />} onClick={() => handleEdit(row)}>编辑</Button>
          <Popconfirm title="确认删除该模板？" onOk={() => handleDelete(row.id)}>
            <Button size="small" status="danger" icon={<IconDelete />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <Title heading={5} style={{ margin: 0 }}>提示词模板</Title>
        <Space>
          <Select
            value={filterCategory || undefined}
            onChange={(v) => setFilterCategory(v || '')}
            placeholder="全部分类"
            style={{ width: 150 }}
            allowClear
          >
            {Object.entries(categoryMap).map(([k, v]) => (
              <Select.Option key={k} value={k}>{v.label}</Select.Option>
            ))}
          </Select>
          <Button icon={<IconPlus />} onClick={handleImportBuiltin}>导入内置模板</Button>
          <Button type="primary" icon={<IconPlus />} onClick={handleAdd}>添加模板</Button>
        </Space>
      </div>

      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        管理 AI 任务（剧本解析、分镜生成等）的 system prompt。剧本解析时按「分类=剧本解析 + 子模式」自动选用默认模板；无配置时用内置模板。
      </Paragraph>

      <Card>
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : (
          <Table columns={columns} data={templates} rowKey="id" pagination={{ pageSize: 10 }} noDataElement="暂无模板，点击「导入内置模板」快速开始" />
        )}
      </Card>

      <Modal
        title={editing?.id ? `编辑模板：${editing.name}` : '添加提示词模板'}
        visible={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        style={{ width: 720, maxWidth: '90vw' }}
      >
        <Form form={form} layout="vertical">
          <Form.Item field="name" label="模板名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：剧本解析-融生-精细版" />
          </Form.Item>
          <Form.Item field="category" label="分类" rules={[{ required: true }]}>
            <Select>
              {Object.entries(categoryMap).map(([k, v]) => (
                <Select.Option key={k} value={k}>{v.label}（{k}）</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item field="mode" label="子模式" tooltip="剧本解析对应 fusion/image_to_video/composite/ppt；其他任务可自定义">
            <Input placeholder="fusion / image_to_video / composite / ppt / default" />
          </Form.Item>
          <Form.Item field="content" label="System Prompt（完整提示词）" rules={[{ required: true, message: '请输入提示词内容' }]}>
            <TextArea
              autoSize={{ minRows: 12, maxRows: 24 }}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
              placeholder="粘贴或编辑完整的 system prompt…"
            />
          </Form.Item>
          <Form.Item field="description" label="说明（可选）">
            <Input placeholder="这个模板的用途、调试备注等" />
          </Form.Item>
          <Space size="large">
            <Form.Item field="is_enabled" label="启用" triggerPropName="checked"><Switch /></Form.Item>
            <Form.Item field="is_default" label="设为默认" triggerPropName="checked" tooltip="同分类+子模式下仅一个默认，会被自动选用">
              <Switch />
            </Form.Item>
            <Form.Item field="priority" label="优先级"><InputNumber min={0} max={100} /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}

export default AdminPromptTemplatePage
