/**
 * WorkbenchPage - 工作台 (M6)
 *
 * 对标目标网站 ai_tools:
 * - 解说剧一键成片: 输入剧本 -> 一键生成
 * - 一键转绘: 上传视频URL -> 风格化
 * - 我的作品
 */
import React, { useEffect, useState } from 'react'
import {
  Card, Typography, Button, Space, Input, Select, Message, Empty, Spin,
  Grid, Tag, Tabs,
} from '@arco-design/web-react'
import {
  IconVideoCamera, IconFire, IconFolder, IconShareExternal, IconImage,
} from '@arco-design/web-react/icon'
import { workbenchService, showcaseService } from '@/api/services'
import { useCreditStore } from '@/stores'
import { VIDEO_STYLES } from '@/types'

const { Title, Text, Paragraph } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

const WorkbenchPage: React.FC = () => {
  const { loadBalance } = useCreditStore()
  const [tab, setTab] = useState('narration')

  // 解说剧
  const [script, setScript] = useState('')
  const [narrationTitle, setNarrationTitle] = useState('')
  const [narrationResult, setNarrationResult] = useState<any>(null)
  const [narrLoading, setNarrLoading] = useState(false)

  // 转绘
  const [videoUrl, setVideoUrl] = useState('')
  const [style, setStyle] = useState('anime')
  const [transferResult, setTransferResult] = useState<any>(null)
  const [transferLoading, setTransferLoading] = useState(false)

  // 我的作品
  const [myWorks, setMyWorks] = useState<any[]>([])
  const [worksLoading, setWorksLoading] = useState(false)

  const loadMyWorks = async () => {
    setWorksLoading(true)
    try {
      const res: any = await workbenchService.myWorks()
      setMyWorks(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* ignore */ } finally { setWorksLoading(false) }
  }

  useEffect(() => { loadMyWorks() }, [])

  const handleNarration = async () => {
    if (!script.trim()) { Message.warning('请输入剧本内容'); return }
    setNarrLoading(true)
    try {
      const res: any = await workbenchService.narration({ script_content: script, title: narrationTitle })
      setNarrationResult(res?.data ?? res)
      Message.success(`一键成片完成! 消耗 ${res?.data?.total_credits ?? res?.total_credits} 积分`)
      loadBalance(); loadMyWorks()
    } catch (e: any) { Message.error(e?.message || '生成失败') }
    finally { setNarrLoading(false) }
  }

  const handleTransfer = async () => {
    if (!videoUrl.trim()) { Message.warning('请输入视频地址'); return }
    setTransferLoading(true)
    try {
      const res: any = await workbenchService.videoTransfer({ video_url: videoUrl, style, frame_count: 4 })
      setTransferResult(res?.data ?? res)
      Message.success(`转绘完成! 消耗 ${res?.data?.total_credits ?? res?.total_credits} 积分`)
      loadBalance()
    } catch (e: any) { Message.error(e?.message || '转绘失败') }
    finally { setTransferLoading(false) }
  }

  const handlePublishNarration = async () => {
    if (!narrationResult) return
    try {
      await showcaseService.publish({
        title: narrationResult.title || '解说剧作品',
        video_url: narrationResult.video_url,
        tags: ['解说剧'],
      })
      Message.success('已发布到作品展示')
      loadMyWorks()
    } catch { Message.error('发布失败') }
  }

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>工作台</Title>

      <Tabs activeTab={tab} onChange={setTab}>
        {/* 解说剧一键成片 */}
        <TabPane key="narration" title={<span><IconVideoCamera /> 解说剧一键成片</span>}>
          <Card>
            <Paragraph type="secondary">输入剧本内容，AI 智能配音、自动配图，一键生成完整的解说剧视频。</Paragraph>
            <Row gutter={16}>
              <Col span={12}>
                <Text style={{ display: 'block', marginBottom: 6 }}>作品标题</Text>
                <Input placeholder="如：林弈的抉择" value={narrationTitle} onChange={setNarrationTitle} style={{ marginBottom: 12 }} />
                <Text style={{ display: 'block', marginBottom: 6 }}>剧本内容</Text>
                <Input.TextArea
                  placeholder="输入剧本文本，支持多段。AI 将按句段自动配音+配图..."
                  value={script} onChange={setScript}
                  autoSize={{ minRows: 8, maxRows: 16 }} style={{ marginBottom: 12 }}
                />
                <Button type="primary" long size="large" icon={<IconFire />} loading={narrLoading} onClick={handleNarration}>
                  {narrLoading ? '生成中...' : '开始创作'}
                </Button>
              </Col>
              <Col span={12}>
                <Text style={{ display: 'block', marginBottom: 6 }}>生成结果</Text>
                {narrationResult ? (
                  <div>
                    <Card size="small" style={{ marginBottom: 8 }}>
                      <Space><Tag color="green">{narrationResult.segment_count} 段</Tag><Text type="secondary">消耗 {narrationResult.total_credits} 积分</Text></Space>
                    </Card>
                    {narrationResult.segments?.map((seg: any, i: number) => (
                      <Card key={i} size="small" style={{ marginBottom: 6 }}>
                        <Text style={{ fontSize: 13 }}>第{seg.segment}段: {seg.text}</Text>
                        {seg.image_url && <div style={{ marginTop: 4 }}><Text type="secondary" style={{ fontSize: 11 }}>配图: {seg.image_url.slice(0, 50)}...</Text></div>}
                      </Card>
                    ))}
                    <Button type="outline" icon={<IconShareExternal />} onClick={handlePublishNarration} style={{ marginTop: 8 }}>
                      发布到作品展示
                    </Button>
                  </div>
                ) : <Empty description="提交剧本后展示生成结果" />}
              </Col>
            </Row>
          </Card>
        </TabPane>

        {/* 一键转绘 */}
        <TabPane key="transfer" title={<span><IconImage /> 一键转绘</span>}>
          <Card>
            <Paragraph type="secondary">上传短剧视频，AI 智能提取画面并转化为风格化图像。</Paragraph>
            <Row gutter={16}>
              <Col span={10}>
                <Text style={{ display: 'block', marginBottom: 6 }}>视频地址</Text>
                <Input placeholder="https://..." value={videoUrl} onChange={setVideoUrl} style={{ marginBottom: 12 }} />
                <Text style={{ display: 'block', marginBottom: 6 }}>风格</Text>
                <Select value={style} onChange={setStyle} style={{ width: '100%', marginBottom: 12 }}>
                  {VIDEO_STYLES.map((s) => <Select.Option key={s.key} value={s.key}>{s.label}</Select.Option>)}
                </Select>
                <Button type="primary" icon={<IconFire />} loading={transferLoading} onClick={handleTransfer}>
                  {transferLoading ? '转绘中...' : '立即体验'}
                </Button>
              </Col>
              <Col span={14}>
                <Text style={{ display: 'block', marginBottom: 6 }}>转绘结果</Text>
                {transferResult ? (
                  <div>
                    <Space style={{ marginBottom: 8 }}><Tag color="arcoblue">{transferResult.style}</Tag><Text type="secondary">{transferResult.frames?.length} 帧 · 消耗 {transferResult.total_credits} 积分</Text></Space>
                    <Row gutter={[8, 8]}>
                      {transferResult.frames?.map((f: any, i: number) => (
                        <Col key={i} span={8}>
                          <Card size="small" cover={
                            <div style={{ aspectRatio: '16/9', background: 'var(--color-fill-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <IconImage style={{ color: 'var(--color-text-3)' }} />
                            </div>
                          }>
                            <Card.Meta description={<Text type="secondary" style={{ fontSize: 11 }}>第{f.frame}帧</Text>} />
                          </Card>
                        </Col>
                      ))}
                    </Row>
                  </div>
                ) : <Empty description="提交视频后展示转绘结果" />}
              </Col>
            </Row>
          </Card>
        </TabPane>

        {/* 我的作品 */}
        <TabPane key="works" title={<span><IconFolder /> 我的作品</span>}>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <Text type="secondary">共 {myWorks.length} 个作品</Text>
            </div>
            {worksLoading ? <Spin dot style={{ display: 'block', margin: '40px auto' }} /> :
             myWorks.length === 0 ? <Empty description="暂无作品" /> :
             <Row gutter={[12, 12]}>
               {myWorks.map((w) => (
                 <Col key={w.id} span={6}>
                   <Card size="small" hoverable cover={
                     <div style={{ aspectRatio: '16/9', background: 'var(--color-fill-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                       <IconVideoCamera style={{ fontSize: 32, color: 'var(--color-text-3)' }} />
                     </div>
                   }>
                     <Card.Meta
                       title={<Text ellipsis style={{ maxWidth: 160 }}>{w.title}</Text>}
                       description={
                         <Space size="small">
                           {w.is_public && <Tag size="small" color="green">已发布</Tag>}
                           <Text type="secondary" style={{ fontSize: 11 }}>👍 {w.like_count} 👁 {w.view_count}</Text>
                         </Space>
                       }
                     />
                   </Card>
                 </Col>
               ))}
             </Row>
            }
          </Card>
        </TabPane>
      </Tabs>
    </div>
  )
}

export default WorkbenchPage
