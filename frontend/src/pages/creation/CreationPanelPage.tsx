/**
 * CreationPanelPage - AI 创作面板 (M5)
 *
 * 对标目标网站片段创作面板:
 * - 左侧: 镜头类型 + 创作模式(融合生图/图生视频/首尾帧) + 元素选择 + 提示词 + 尺寸/数量
 * - 右侧: 素材成果区(生成的图片/视频网格)
 * - 提交任务 -> 扣积分 -> 返回结果展示
 */
import React, { useState } from 'react'
import {
  Card, Typography, Space, Button, Select, Tag, Input, Radio, Message,
  Empty, Spin, Image, Grid,
} from '@arco-design/web-react'
import {
  IconVideoCamera, IconImage, IconSound, IconPlus, IconDelete, IconBulb,
} from '@arco-design/web-react/icon'
import { creationService } from '@/api/services'
import { useTeamStore, useCreditStore } from '@/stores'
import { GenElementInput, CreationMode, SHOT_TYPES } from '@/types'

const { Title, Text, Paragraph } = Typography
const { Row, Col } = Grid

const MODE_LABELS: Record<string, string> = {
  fusion: '在线融合生图',
  image_to_video: '图生视频',
  first_last_frame: '首尾帧生成视频',
}

const ELEMENT_TYPES = [
  { key: 'character', label: '角色' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '物品' },
  { key: 'pose', label: '姿态' },
  { key: 'effect', label: '特效' },
]

const SIZES = ['16:9', '9:16', '4:3', '3:4']

const CreationPanelPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const { loadBalance } = useCreditStore()

  const [shotType, setShotType] = useState('对话场景')
  const [mode, setMode] = useState<CreationMode>('fusion')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('16:9')
  const [count, setCount] = useState(1)
  const [elements, setElements] = useState<GenElementInput[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<string[]>([])  // 生成的URL
  const [resultType, setResultType] = useState<'image' | 'video' | 'audio'>('image')

  const addElement = (type: string) => {
    setElements([...elements, { type: type as any, name: '', image_url: '' }])
  }
  const removeElement = (idx: number) => {
    setElements(elements.filter((_, i) => i !== idx))
  }
  const updateElement = (idx: number, field: string, value: string) => {
    setElements(elements.map((e, i) => i === idx ? { ...e, [field]: value } : e))
  }

  const handleSubmit = async () => {
    if (!prompt && mode !== 'fusion') {
      Message.warning('请输入描述/提示词')
      return
    }
    setSubmitting(true)
    try {
      const payload: Record<string, any> = {
        prompt, size, count,
        elements: elements.filter(e => e.name).map(e => ({ type: e.type, name: e.name, image_url: e.image_url || undefined })),
      }
      let res: any
      if (mode === 'fusion') {
        res = await creationService.fusion(payload, undefined)
        setResultType('image')
      } else if (mode === 'image_to_video') {
        res = await creationService.imageToVideo(payload, undefined, undefined)
        setResultType('video')
      } else {
        res = await creationService.firstLastFrame(payload, undefined, undefined)
        setResultType('video')
      }
      const r = res?.data ?? res
      setResults(r.urls || [])
      Message.success(`生成成功! 消耗 ${r.credits_consumed} 积分`)
      loadBalance()  // 刷新积分
    } catch (e: any) {
      Message.error(e?.message || '生成失败')
    } finally { setSubmitting(false) }
  }

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>AI 创作面板</Title>

      <Row gutter={16}>
        {/* 左侧: 创作参数 */}
        <Col span={14}>
          <Card title="创作参数">
            {/* 镜头类型 */}
            <div style={{ marginBottom: 16 }}>
              <Text style={{ display: 'block', marginBottom: 6 }}>* 镜头类型</Text>
              <Select value={shotType} onChange={setShotType} style={{ width: '100%' }}>
                {SHOT_TYPES.map((s) => <Select.Option key={s} value={s}>{s}</Select.Option>)}
              </Select>
            </div>

            {/* 创作模式 */}
            <div style={{ marginBottom: 16 }}>
              <Text style={{ display: 'block', marginBottom: 6 }}>* 创作模式</Text>
              <Radio.Group value={mode} onChange={(v) => setMode(v as CreationMode)} type="button">
                <Radio value="fusion">融合生图</Radio>
                <Radio value="image_to_video">图生视频</Radio>
                <Radio value="first_last_frame">首尾帧</Radio>
              </Radio.Group>
              <div style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{MODE_LABELS[mode]}</Text>
              </div>
            </div>

            {/* 元素 */}
            <div style={{ marginBottom: 16 }}>
              <Text style={{ display: 'block', marginBottom: 6 }}>元素 (角色/场景/物品/姿态/特效)</Text>
              <Space wrap size="small" style={{ marginBottom: 8 }}>
                {ELEMENT_TYPES.map((et) => (
                  <Button key={et.key} size="small" icon={<IconPlus />} onClick={() => addElement(et.key)}>
                    {et.label}
                  </Button>
                ))}
              </Space>
              {elements.map((el, idx) => (
                <Row key={idx} gutter={8} style={{ marginBottom: 6 }}>
                  <Col span={5}>
                    <Tag>{ELEMENT_TYPES.find(t => t.key === el.type)?.label}</Tag>
                  </Col>
                  <Col span={10}>
                    <Input size="small" placeholder="名称" value={el.name} onChange={(v) => updateElement(idx, 'name', v)} />
                  </Col>
                  <Col span={7}>
                    <Input size="small" placeholder="参考图URL(可选)" value={el.image_url} onChange={(v) => updateElement(idx, 'image_url', v)} />
                  </Col>
                  <Col span={2}>
                    <Button size="small" icon={<IconDelete />} status="danger" onClick={() => removeElement(idx)} />
                  </Col>
                </Row>
              ))}
            </div>

            {/* 描述/提示词 */}
            <div style={{ marginBottom: 16 }}>
              <Space style={{ marginBottom: 6 }}>
                <Text>* 描述</Text>
                <Button size="mini" type="text" icon={<IconBulb />} onClick={() => setPrompt('请描述角色动作、表情、场景氛围、镜头运动...')}>
                  一键填入提示词框架
                </Button>
              </Space>
              <Input.TextArea
                placeholder="结合上传元素，描述希望如何融合生成，描述涵盖每个元素及其关系"
                value={prompt} onChange={setPrompt} autoSize={{ minRows: 3, maxRows: 6 }}
              />
            </div>

            {/* 尺寸 + 数量 */}
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={12}>
                <Text style={{ display: 'block', marginBottom: 6 }}>* 图像尺寸</Text>
                <Radio.Group value={size} onChange={setSize}>
                  {SIZES.map((s) => <Radio key={s} value={s}>{s}</Radio>)}
                </Radio.Group>
              </Col>
              <Col span={12}>
                <Text style={{ display: 'block', marginBottom: 6 }}>* 生成数量</Text>
                <Radio.Group value={count} onChange={(v) => setCount(v)}>
                  {[1, 2, 3, 4, 5].map((n) => <Radio key={n} value={n}>{n}</Radio>)}
                </Radio.Group>
              </Col>
            </Row>

            <Button type="primary" long size="large" loading={submitting} onClick={handleSubmit}>
              {submitting ? '生成中...' : `提交任务（消耗 ${count} 积分）`}
            </Button>
          </Card>
        </Col>

        {/* 右侧: 素材成果 */}
        <Col span={10}>
          <Card title={<Space><IconImage /> 素材成果</Space>} style={{ minHeight: 500 }}>
            {submitting ? <Spin dot style={{ display: 'block', margin: '40px auto' }} /> :
             results.length === 0 ? <Empty description="暂无生成结果，提交任务后展示" /> :
             <Row gutter={[8, 8]}>
               {results.map((url, i) => (
                 <Col key={i} span={12}>
                   <Card size="small" hoverable cover={
                     resultType === 'image' ? (
                       <Image src={url} alt={`结果${i+1}`} style={{ width: '100%', aspectRatio: mode === 'fusion' ? size.replace(':','/') : '16/9', objectFit: 'cover' }} />
                     ) : (
                       <div style={{ aspectRatio: '16/9', background: 'var(--color-fill-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                         <IconVideoCamera style={{ fontSize: 32, color: 'var(--color-text-3)' }} />
                       </div>
                     )
                   }>
                     <Card.Meta description={<Text type="secondary" style={{ fontSize: 12 }}>结果 #{i+1}</Text>} />
                   </Card>
                 </Col>
               ))}
             </Row>
            }
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default CreationPanelPage
