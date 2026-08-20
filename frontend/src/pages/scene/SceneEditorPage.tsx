/**
 * SceneEditorPage - 分镜编辑器（核心页面）
 *
 * 功能：分镜列表、编辑提示词、预览@引用展开、调整顺序、生成视频
 */
import React, { useEffect, useState, useCallback } from 'react'
import { Card, Button, Input, Message, Spin, Typography, Space, Tag, List, Empty, Modal, InputNumber, Select, Popconfirm, Tooltip, Form } from '@arco-design/web-react'
import {
  IconBackward, IconSave, IconEye, IconDelete, IconPlus,
  IconThunderbolt, IconDragArrow, IconVideoCamera, IconRefresh,
} from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { sceneService, scriptService, taskService } from '@/api/services'
import { SCENE_STATUS } from '@/utils/statusLabels'

const { Title, Text, Paragraph } = Typography

const statusColors: Record<string, string> = {
  pending: 'gray',
  ready: 'blue',
  generating: 'orange',
  completed: 'green',
  failed: 'red',
}

const SceneEditorPage: React.FC = () => {
  const { projectId, scriptId } = useParams<{ projectId: string; scriptId: string }>()
  const navigate = useNavigate()
  const [scenes, setScenes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedScene, setSelectedScene] = useState<any>(null)
  const [editPrompt, setEditPrompt] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generatingVideo, setGeneratingVideo] = useState(false)
  const [createVisible, setCreateVisible] = useState(false)
  const [newScene, setNewScene] = useState({ prompt: '', duration: 5, scene_type: 'normal' })

  const loadScenes = async () => {
    if (!scriptId) return
    setLoading(true)
    try {
      const data: any = await sceneService.list(scriptId!)
      const list = Array.isArray(data) ? data : []
      setScenes(list)
      if (list.length > 0 && !selectedScene) {
        selectScene(list[0])
      }
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }

  useEffect(() => { loadScenes() }, [scriptId])

  const selectScene = (scene: any) => {
    setSelectedScene(scene)
    setEditPrompt(scene.prompt || '')
    setPreview(null)
  }

  // 预览提示词（展开@引用）
  const handlePreview = async () => {
    if (!selectedScene) return
    setPreviewLoading(true)
    try {
      const result: any = await sceneService.previewPrompt(selectedScene.id, editPrompt)
      setPreview(result)
    } catch { /* 拦截器提示 */ } finally { setPreviewLoading(false) }
  }

  // 保存提示词
  const handleSavePrompt = async () => {
    if (!selectedScene) return
    setSaving(true)
    try {
      const result: any = await sceneService.updatePrompt(selectedScene.id, editPrompt)
      Message.success('提示词已保存')
      // 更新本地数据
      setScenes(prev => prev.map(s => s.id === selectedScene.id ? { ...s, prompt: editPrompt, parsed_prompt: result?.expanded_prompt ? { expanded: result.expanded_prompt } : s.parsed_prompt } : s))
      setSelectedScene({ ...selectedScene, prompt: editPrompt })
    } catch { /* 拦截器提示 */ } finally { setSaving(false) }
  }

  // 更新分镜属性
  const handleUpdateScene = async (id: string, data: Record<string, any>) => {
    try {
      await sceneService.update(id, data)
      Message.success('已更新')
      loadScenes()
    } catch { /* 拦截器提示 */ }
  }

  // 删除分镜
  const handleDelete = async (id: string) => {
    await sceneService.delete(id)
    Message.success('已删除')
    if (selectedScene?.id === id) setSelectedScene(null)
    loadScenes()
  }

  // 创建分镜
  const handleCreate = async () => {
    try {
      await sceneService.create(scriptId!, {
        prompt: newScene.prompt,
        sequence: scenes.length + 1,
        duration: newScene.duration,
        scene_type: newScene.scene_type,
      })
      Message.success('分镜已创建')
      setCreateVisible(false)
      setNewScene({ prompt: '', duration: 5, scene_type: 'normal' })
      loadScenes()
    } catch { /* 拦截器提示 */ }
  }

  // AI 批量生成分镜
  const handleGenerateScenes = async () => {
    Modal.confirm({
      title: 'AI 生成分镜',
      content: '将根据剧本内容自动生成分镜，现有分镜不会被删除。是否继续？',
      onOk: async () => {
        try {
          const result: any = await sceneService.generateScenes(scriptId!)
          Message.success(`生成了 ${result?.scenes?.length || 0} 个分镜`)
          loadScenes()
        } catch { /* 拦截器提示 */ }
      },
    })
  }

  // 生成单个视频
  const handleGenerateVideo = async () => {
    if (!selectedScene) return
    setGeneratingVideo(true)
    try {
      await taskService.generateVideo({ scene_id: selectedScene.id })
      Message.success('视频生成任务已提交')
    } catch { /* 拦截器提示 */ } finally { setGeneratingVideo(false) }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size={32} tip="加载中..." /></div>

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 120px)' }}>
      {/* 左侧：分镜列表 */}
      <Card style={{ width: 320, overflow: 'auto' }} bodyStyle={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontWeight: 600 }}>分镜列表 ({scenes.length})</Text>
          <Space size={4}>
            <Tooltip content="AI生成分镜">
              <Button size="small" icon={<IconThunderbolt />} onClick={handleGenerateScenes} />
            </Tooltip>
            <Tooltip content="手动添加">
              <Button size="small" icon={<IconPlus />} onClick={() => setCreateVisible(true)} />
            </Tooltip>
          </Space>
        </div>
        {scenes.length === 0 ? (
          <Empty description="暂无分镜" style={{ padding: 40 }} />
        ) : (
          <List
            dataSource={scenes}
            render={(scene, index) => (
              <List.Item
                key={scene.id}
                onClick={() => selectScene(scene)}
                style={{
                  cursor: 'pointer',
                  padding: '10px 16px',
                  background: selectedScene?.id === scene.id ? 'var(--color-fill-2)' : 'transparent',
                  borderLeft: selectedScene?.id === scene.id ? '3px solid rgb(var(--primary-6))' : '3px solid transparent',
                }}
              >
                <div style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontWeight: 600 }}>#{scene.sequence}</Text>
                    <Tag color={SCENE_STATUS[scene.status]?.color || 'gray'} size="small">{SCENE_STATUS[scene.status]?.label || scene.status}</Tag>
                  </div>
                  <Text type="secondary" style={{ display: 'block', fontSize: 13, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {scene.prompt?.substring(0, 50) || '空提示词'}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{scene.duration}s</Text>
                </div>
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 右侧：编辑区 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {selectedScene ? (
          <Card>
            {/* 头部 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <Space>
                <Button icon={<IconBackward />} onClick={() => navigate(`/projects/${projectId}/scripts/${scriptId}`)} type="text" />
                <Title heading={5} style={{ margin: 0 }}>分镜 #{selectedScene.sequence}</Title>
                <Tag color={SCENE_STATUS[selectedScene.status]?.color || 'gray'}>{SCENE_STATUS[selectedScene.status]?.label || selectedScene.status}</Tag>
              </Space>
              <Space>
                <Popconfirm title="确认删除此分镜？" onOk={() => handleDelete(selectedScene.id)}>
                  <Button icon={<IconDelete />} status="danger">删除</Button>
                </Popconfirm>
                <Button type="primary" icon={<IconVideoCamera />} loading={generatingVideo} onClick={handleGenerateVideo}>
                  生成视频
                </Button>
              </Space>
            </div>

            {/* 属性编辑 */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
              <div>
                <Text type="secondary" style={{ fontSize: 13 }}>时长（秒）</Text>
                <InputNumber
                  value={selectedScene.duration}
                  min={1} max={60}
                  onChange={(v) => { handleUpdateScene(selectedScene.id, { duration: v }); setSelectedScene({ ...selectedScene, duration: v }) }}
                  style={{ width: 100 }}
                />
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 13 }}>镜头角度</Text>
                <Select
                  value={selectedScene.camera_angle || ''}
                  onChange={(v) => { handleUpdateScene(selectedScene.id, { camera_angle: v }); setSelectedScene({ ...selectedScene, camera_angle: v }) }}
                  style={{ width: 140 }}
                  allowClear
                >
                  {['close_up', 'medium', 'wide', 'overhead', 'low_angle'].map(v => <Select.Option key={v} value={v}>{v}</Select.Option>)}
                </Select>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 13 }}>情绪</Text>
                <Select
                  value={selectedScene.mood || ''}
                  onChange={(v) => { handleUpdateScene(selectedScene.id, { mood: v }); setSelectedScene({ ...selectedScene, mood: v }) }}
                  style={{ width: 140 }}
                  allowClear
                >
                  {['happy', 'sad', 'tense', 'calm', 'exciting', 'mysterious'].map(v => <Select.Option key={v} value={v}>{v}</Select.Option>)}
                </Select>
              </div>
            </div>

            {/* 提示词编辑器 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text style={{ fontWeight: 600 }}>提示词（支持 @引用角色/场景/道具）</Text>
                <Space>
                  <Button icon={<IconEye />} loading={previewLoading} onClick={handlePreview}>预览展开</Button>
                  <Button type="primary" icon={<IconSave />} loading={saving} onClick={handleSavePrompt}>保存</Button>
                </Space>
              </div>
              <Input.TextArea
                value={editPrompt}
                onChange={setEditPrompt}
                placeholder="输入提示词... 可以用 @角色名 引用角色资源，例如：@小明 站在 @城市街道 上，手里拿着 @信件"
                style={{ minHeight: 120, fontFamily: 'monospace', fontSize: 14, lineHeight: 1.8 }}
                showWordLimit
              />
            </div>

            {/* 预览结果 */}
            {preview && (
              <Card title="提示词预览" style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 8 }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>展开后提示词：</Text>
                  <Paragraph style={{ background: 'var(--color-fill-2)', padding: 12, borderRadius: 6, marginTop: 4, fontSize: 14, fontFamily: 'monospace' }}>
                    {preview.expanded_prompt || '无'}
                  </Paragraph>
                </div>
                <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
                  <Tag color="blue">Token: {preview.token_count ?? 0}</Tag>
                  <Tag color={preview.estimated_quality === 'good' ? 'green' : preview.estimated_quality === 'acceptable' ? 'orange' : 'red'}>
                    质量: {preview.estimated_quality || 'unknown'}
                  </Tag>
                </div>
                {preview.referenced_resources?.length > 0 && (
                  <div>
                    <Text type="secondary" style={{ fontSize: 13 }}>引用的资源：</Text>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                      {preview.referenced_resources.map((r: any, i: number) => (
                        <Tag key={i} color="arcoblue" size="small">{r.type}: {r.name || r.id}</Tag>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            )}

            {/* 已生成视频 */}
            {selectedScene.generated_video_url && (
              <Card title="已生成视频" style={{ marginBottom: 16 }}>
                <video
                  src={selectedScene.generated_video_url}
                  controls
                  style={{ width: '100%', maxWidth: 640, borderRadius: 8 }}
                />
              </Card>
            )}
          </Card>
        ) : (
          <Card>
            <Empty description="选择左侧的分镜进行编辑" style={{ padding: 60 }} />
          </Card>
        )}
      </div>

      {/* 创建分镜弹窗 */}
      <Modal
        title="创建分镜"
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        onOk={handleCreate}
        okText="创建"
        cancelText="取消"
      >
        <Form layout="vertical">
          <Form.Item label="提示词" required>
            <Input.TextArea
              value={newScene.prompt}
              onChange={(v) => setNewScene({ ...newScene, prompt: v })}
              placeholder="分镜提示词"
              rows={3}
            />
          </Form.Item>
          <Form.Item label="时长（秒）">
            <InputNumber value={newScene.duration} min={1} max={60} onChange={(v) => setNewScene({ ...newScene, duration: v || 5 })} />
          </Form.Item>
          <Form.Item label="类型">
            <Select value={newScene.scene_type} onChange={(v) => setNewScene({ ...newScene, scene_type: v })}>
              {['normal', 'title', 'transition'].map(v => <Select.Option key={v} value={v}>{v}</Select.Option>)}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default SceneEditorPage
