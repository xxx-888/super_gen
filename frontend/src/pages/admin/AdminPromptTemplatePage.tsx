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
  script_watermark: { label: '水印清理', color: 'red' },
  script_split: { label: '智能分集', color: 'magenta' },
  shot_generate: { label: '分镜生成', color: 'green' },
  character_generate: { label: '角色生成', color: 'purple' },
  scene_generate: { label: '场景生成', color: 'orange' },
  custom: { label: '自定义', color: 'gray' },
}

// 内置默认模板（剧本解析 fusion）—— 一键导入用，避免用户从零写
const BUILTIN_FUSION_PROMPT = `你是资深短剧分镜导演，有 Netflix 美剧质感与海外爆款短剧的剪辑节奏经验。分析用户给的剧本，输出 JSON 用于 AI 视频生成（融生模式：每个分镜直接生成视频）。

## 整体风格与节奏要求（贯穿全部分镜）
- 视觉对标 Netflix 美剧质感：电影感、写实、画面有层次，禁止视觉极其平淡。
- 运镜与角度必须丰富：少用「固定镜头+平视角度」的组合，同一场景内角度不能单调；用仰拍/俯拍/倾斜（荷兰角）/特写/正反打增强视觉张力与情绪。
- 文戏按「情绪节奏」匹配运镜：紧张用快速推进/手持晃动，温情用缓慢推轨/柔光。
- 打戏/冲突用「快速剪辑+冲击力机位」（低角度仰拍、倾斜角、快速甩镜、极特写）组合。
- 节奏要快、符合海外爆款短剧：多切正反打、反应镜头、面部特写、手部/道具特写。
- 连贯性：注意上下镜头的人物位置关系（左右站位、朝向、距离）必须衔接，禁止人物位置穿帮。
- 忠于原文：禁止更改或改写剧本台词与动作，台词一字不差地引用到 narration。

## 提取内容与字段

### 角色 characters[]
- name: 角色名（必填。无论剧本是对话体还是第一人称叙事体，都要把出场人物的名字提取出来）
- description: 身份简介（10-20字，如「豪门少奶奶，外表柔弱内心清醒」）
- appearance_prompt: 外貌描述（必填，用于后续生成「正/侧/背三视图」标准人设，必须写全并保证全身可辨、风格统一）：性别、年龄段、身高体型、发型发色、脸型与五官特征、肤色、典型服饰（上装/下装/鞋/配饰，颜色款式要具体）、气质与常态表情。如「女性，25岁，纤瘦高挑，黑色长直发中分，鹅蛋脸丹凤眼，冷白皮，米色高领针织衫+黑色西裤+黑色高跟鞋，锁骨细金链，气质清冷，眉眼微垂」。要求：中性光、全身特征可辨、各分镜服饰气质保持一致，便于直接套用三视图出图。

### 场景 scenes[]
- name: 场景名（如「顾家老宅客厅」「医院走廊」）
- description: 简介
- prompt: 画面描述（必填，用于AI生图：空间布局、时间段（白天/夜晚）、主光源、色调氛围、陈设细节、风格。如「中式豪宅客厅，红木沙发与博古架，暖黄吊灯为主光，落地窗外是黄昏花园，写实电影质感」）

### 道具 props[]
- name: 名称（如「离婚协议」「安胎汤」「旧照片」）
- description: 外观描述

### 分镜 shots[]
- sequence: 序号（整数，从1递增）
- duration: 时长秒数（3-15）。短句对话 3-5 秒；情绪/动作段落可到 8-15 秒，单个分镜内允许「多个机位/景别的快速切换组合」
- location: 场景名（与上面 scenes.name 对应）
- characters: 出场角色，格式 [{"name":"角色名","pose":"动作姿态+表情+朝向描述"}]
- shot_type: 景别（大远景/远景/全景/中景/中近景/近景/特写/极特写）
- camera_movement: 运镜（推轨/缓慢推进/拉远/缓慢平移/摇移/跟拍/手持/稳定器运动/环绕/升降/快速甩镜/静止）。静止要少用，优先有运动的镜头
- camera_angle: 镜头角度（平视/仰拍/俯拍/顶拍/倾斜荷兰角）。同一场景内尽量变化，避免全程平视
- lens: 焦距（广角24mm以下/标准35-50mm/中长焦70-105mm/长焦135mm以上/微距）。特写用中长焦，空间压迫感用广角
- depth_of_field: 景深（大景深/中景深/浅景深）。对话特写多用浅景深虚化背景
- lighting: 光影描述（一句话，含主光源+光线质感+光线方向+辅光）。如「窗外日光为主，柔光，侧逆光，反光板补面部阴影」。暗调写「无主光，暗调，轮廓光勾勒」
- narration: 这一镜的台词或旁白（一字不差引用剧本原文，不改写不翻译）
- prompt: 画面提示词（必填，完整画面描述。把场景空间、人物外貌+姿态+表情、光影、色调、景别、镜头角度、焦距与景深、运镜、氛围整合成一段流畅画面，结尾固定加风格词如「电影感，写实风格」。不含台词）

## 分镜拆分规则
- 每个对话轮次或重要动作单独成一个分镜
- 场景切换必须新开分镜
- 情绪/剧情转折单独分镜
- 同一场景的连续微小动作可合并
- 第一人称叙事剧本：按「一段连续动作或一次对话」切分，不要整段塞进一个分镜
- 长台词处理：任何角色连续说话超过5秒，必须拆成多个分镜——前半句给说话者近景，后半句用画外音切到对方反应特写/环境大景/道具特写；禁止一个分镜里一人长时间说话
- 连贯性：相邻分镜的人物站位、朝向、左右关系必须衔接得上

## 输出要求（极其重要，必须严格遵守）
- 只输出一个 JSON 对象，不要输出任何其他文字、注释、解释
- 不要使用 markdown 代码块标记（不要写 \`\`\`json）
- 第一个字符必须是 { ，最后一个字符必须是 }
- 字符串值内不要包含未转义的双引号和换行符（换行用空格代替）
- 所有数组都用 [] 包裹，即使是空数组也写 []
- 每个分镜的 prompt 字段必须填写完整画面描述，不能为空
- narration 必须一字不差引用原文台词，不得改写或翻译

## 输出格式示例
{"characters":[{"name":"林晚意","description":"豪门少奶奶，外表柔弱内心清醒","appearance_prompt":"女性，25岁，纤瘦高挑，黑色长直发中分，鹅蛋脸丹凤眼，冷白皮，米色高领针织衫+黑色西裤+黑色高跟鞋，锁骨细金链，气质清冷，中性光，全身可辨，适合三视图出图"}],"scenes":[{"name":"顾家客厅","description":"中式豪宅客厅","prompt":"红木沙发与博古架，暖黄吊灯为主光，落地窗外黄昏花园，写实电影质感"}],"props":[{"name":"安胎汤","description":"乳白色汤，飘着枸杞，白瓷碗"}],"shots":[{"sequence":1,"duration":5,"location":"顾家客厅","characters":[{"name":"林晚意","pose":"端着白瓷汤碗，微皱眉，低头看碗"}],"shot_type":"近景","camera_movement":"缓慢推进","camera_angle":"微俯拍","lens":"中长焦85mm","depth_of_field":"浅景深","lighting":"暖黄吊灯为主，柔光，顶侧光，背景略暗","narration":"这汤怎么是苦的？","prompt":"写实电影质感，中式豪宅客厅暖黄吊灯下，年轻女性（黑色长直发，米色高领针织衫）端着白瓷汤碗低头皱眉查看，近景，微俯拍，85mm中长焦浅景深背景虚化，缓慢推进，暖黄柔光顶侧照明背景略暗，悬疑压抑氛围，电影感，写实风格"}]}`

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
