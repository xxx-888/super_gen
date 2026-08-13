/**
 * VideoPreviewPage - 视频生成与预览
 *
 * 功能：文生图、图生视频、批量视频生成，均需先选择模型再生成
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Message, Spin, Typography, Table, Tag, Space, Modal, Empty, Progress, Select, Input, Grid, Popconfirm, Radio, InputNumber, Switch } from '@arco-design/web-react'
import { IconVideoCamera, IconThunderbolt, IconRefresh, IconPlayCircle, IconImage, IconPlus, IconDelete } from '@arco-design/web-react/icon'
import { useParams } from 'react-router-dom'
import { taskService, sceneService, scriptService, episodeService, creationService } from '@/api/services'
import { TASK_STATUS, SCENE_STATUS } from '@/utils/statusLabels'
import { renderPromptText, truncatePromptText } from '@/utils/prompt'

const { Title, Text } = Typography
const { Row, Col } = Grid

const statusColors: Record<string, string> = {
  pending: 'gray',
  processing: 'orange',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
}

const VideoPreviewPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const [tasks, setTasks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // 媒体预览弹窗
  const [previewMedia, setPreviewMedia] = useState<{ url: string; isVideo: boolean } | null>(null)
  // 任务详情弹窗
  const [detailTask, setDetailTask] = useState<any | null>(null)

  // 模型列表
  const [imageModels, setImageModels] = useState<any[]>([])
  const [videoModels, setVideoModels] = useState<any[]>([])
  const [selectedImageModel, setSelectedImageModel] = useState<string>()
  const [selectedVideoModel, setSelectedVideoModel] = useState<string>()
  const [selectedBatchModel, setSelectedBatchModel] = useState<string>()

  // 文生图
  const [imagePrompt, setImagePrompt] = useState('')
  const [imageSceneId, setImageSceneId] = useState<string>()
  const [genImageLoading, setGenImageLoading] = useState(false)

  // 图生视频：级联选择 剧本 → 片段 → 分镜
  const [scenes, setScenes] = useState<any[]>([])
  const [videoSceneId, setVideoSceneId] = useState<string>()
  const [videoImageUrl, setVideoImageUrl] = useState('')
  const [genVideoLoading, setGenVideoLoading] = useState(false)
  // 级联数据
  const [genScripts, setGenScripts] = useState<any[]>([])
  const [genScriptId, setGenScriptId] = useState<string>('')
  const [genEpisodes, setGenEpisodes] = useState<any[]>([])
  const [genEpisodeId, setGenEpisodeId] = useState<string>('')
  const [genScenes, setGenScenes] = useState<any[]>([])
  const [genQuality, setGenQuality] = useState<'hd' | 'standard'>('hd')
  const [genDuration, setGenDuration] = useState(5)
  const [genResolution, setGenResolution] = useState('768P')

  // 批量生成
  const [batchVisible, setBatchVisible] = useState(false)
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([])
  const [batchGenerating, setBatchGenerating] = useState(false)
  // 任务列表多选（批量删除用）
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [batchDeleting, setBatchDeleting] = useState(false)

  const loadTasks = async () => {
    setLoading(true)
    try {
      const data: any = await taskService.list({ project_id: projectId })
      setTasks(Array.isArray(data) ? data : [])
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }

  const loadModels = async () => {
    // 所有用户都可加载模型列表（去掉仅管理员限制）
    try {
      const [img, vid]: any = await Promise.all([
        creationService.models.list({ type: 'text_to_image' }),
        creationService.models.list({ type: 'image_to_video' }),
      ])
      const imgList = Array.isArray(img) ? img : []
      const vidList = Array.isArray(vid) ? vid : []
      setImageModels(imgList)
      setVideoModels(vidList)
      if (imgList.length && !selectedImageModel) setSelectedImageModel(imgList[0].id)
      if (vidList.length && !selectedVideoModel) setSelectedVideoModel(vidList[0].id)
      if (vidList.length && !selectedBatchModel) setSelectedBatchModel(vidList[0].id)
    } catch { /* 未配置模型忽略 */ }
  }

  // 加载项目下所有分镜（先取剧本，再取各剧本分镜）—— 用于批量生成弹窗
  const loadProjectScenes = async () => {
    try {
      const scripts: any = await scriptService.list(projectId!)
      const scriptList = Array.isArray(scripts) ? scripts : []
      const sceneLists = await Promise.all(scriptList.map((s: any) => sceneService.list(s.id)))
      const flat: any[] = []
      sceneLists.forEach((scenes: any, i: number) => {
        const list = Array.isArray(scenes) ? scenes : []
        list.forEach((sc: any) => flat.push({ ...sc, scriptTitle: scriptList[i]?.title }))
      })
      setScenes(flat)
    } catch {
      setScenes([])
    }
  }

  // ===== 图生视频级联选择：剧本 → 片段 → 分镜 =====
  const loadGenScripts = async () => {
    if (!projectId) return
    try {
      const res: any = await scriptService.list(projectId)
      const list = Array.isArray(res) ? res : []
      setGenScripts(list)
    } catch { setGenScripts([]) }
  }

  // 选剧本 → 加载该剧本的片段列表
  const onGenScriptChange = async (sid: string) => {
    setGenScriptId(sid)
    setGenEpisodeId('')
    setGenEpisodes([])
    setGenScenes([])
    setVideoSceneId('')
    if (!sid || !projectId) return
    try {
      const res: any = await episodeService(projectId).list()
      // 只保留属于该剧本的 episode（episode.script_id == sid）
      const all = Array.isArray(res) ? res : (res?.data ?? [])
      const filtered = all.filter((ep: any) => ep.script_id === sid)
      setGenEpisodes(filtered)
    } catch { setGenEpisodes([]) }
  }

  // 选片段 → 加载该片段的分镜列表
  const onGenEpisodeChange = async (eid: string) => {
    setGenEpisodeId(eid)
    setGenScenes([])
    setVideoSceneId('')
    if (!eid || !projectId) return
    try {
      const res: any = await episodeService(projectId).clips(eid)
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setGenScenes(list)
    } catch { setGenScenes([]) }
  }

  useEffect(() => {
    loadTasks()
    loadModels()
    loadGenScripts()
    loadProjectScenes()
  }, [projectId])

  const handleGenerateImage = async () => {
    if (!selectedImageModel) {
      Message.warning('请先选择文生图模型')
      return
    }
    if (!imagePrompt.trim()) {
      Message.warning('请输入图片提示词')
      return
    }
    setGenImageLoading(true)
    try {
      await taskService.generateImage({ prompt: imagePrompt, model: selectedImageModel, scene_id: imageSceneId || undefined })
      Message.success('文生图任务已提交')
      setImagePrompt('')
      loadTasks()
    } catch { /* 拦截器提示 */ } finally { setGenImageLoading(false) }
  }

  const handleGenerateVideo = async () => {
    if (!genScriptId) { Message.warning('请先选择剧本'); return }
    if (!genEpisodeId) { Message.warning('请先选择片段'); return }
    if (!videoSceneId) { Message.warning('请选择要生成视频的分镜'); return }
    if (!selectedVideoModel) { Message.warning('请先选择图生视频模型'); return }
    setGenVideoLoading(true)
    try {
      // 用 creation clip-generate 接口（支持 quality + 回写 Scene）
      await creationService.clipGenerate(videoSceneId, {
        image_url: videoImageUrl || undefined,
        model: selectedVideoModel,
        quality: genQuality,
        duration: genDuration,
        resolution: genResolution,
      }, 'image_to_video')
      Message.success('图生视频任务已提交')
      loadTasks()
    } catch { /* 拦截器提示 */ } finally { setGenVideoLoading(false) }
  }

  const handleBatchOpen = async () => {
    await loadProjectScenes()
    setSelectedSceneIds([])
    setBatchVisible(true)
  }

  const handleBatchGenerate = async () => {
    if (!selectedBatchModel) {
      Message.warning('请先选择视频生成模型')
      return
    }
    if (selectedSceneIds.length === 0) {
      Message.warning('请选择至少一个分镜')
      return
    }
    setBatchGenerating(true)
    try {
      await taskService.batchGenerateVideo({
        project_id: projectId!,
        scene_ids: selectedSceneIds,
        model: selectedBatchModel,
      })
      Message.success('批量生成任务已提交')
      setBatchVisible(false)
      loadTasks()
    } catch { /* 拦截器提示 */ } finally { setBatchGenerating(false) }
  }

  const handleCancel = async (id: string) => {
    await taskService.cancel(id)
    Message.success('已取消')
    loadTasks()
  }

  const handleRetry = async (id: string) => {
    await taskService.retry(id)
    Message.success('已重新提交')
    loadTasks()
  }

  const handleDelete = async (id: string) => {
    try {
      await taskService.delete(id)
      Message.success('已删除')
      loadTasks()
    } catch { /* 拦截器提示 */ }
  }

  const handleBatchDelete = async () => {
    if (selectedTaskIds.length === 0) return
    setBatchDeleting(true)
    try {
      // 逐条删除（后端无批量删除端点）
      await Promise.all(selectedTaskIds.map((id) => taskService.delete(id)))
      Message.success(`已删除 ${selectedTaskIds.length} 条记录`)
      setSelectedTaskIds([])
      loadTasks()
    } catch { /* 拦截器提示 */ } finally { setBatchDeleting(false) }
  }

  const columns = [
    { title: '类型', dataIndex: 'type', width: 80, render: (v: string) => <Tag>{v}</Tag> },
    { title: '剧本', dataIndex: 'script_title', width: 120, render: (v: string) => v ? <Text style={{ fontSize: 13 }}>{v}</Text> : <Text type="secondary">-</Text> },
    { title: '集/分镜', width: 120, render: (_: any, row: any) => (
      <Space size={4}>
        {row.episode_number != null && <Tag size="small">第{row.episode_number}集</Tag>}
        {row.scene_sequence != null && <Tag size="small" color="blue">#{row.scene_sequence}</Tag>}
        {row.episode_number == null && row.scene_sequence == null && <Text type="secondary">-</Text>}
      </Space>
    ) },
    {
      // 模型名可能很长（如 DiffSynth-Studio/MiniMax-H3），用 Tag 显示并支持省略 + 悬停看全名
      title: '模型', dataIndex: 'model', width: 170, ellipsis: true,
      render: (v: string) => v
        ? <Tag color="arcoblue" style={{ maxWidth: '100%' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span></Tag>
        : <Text type="secondary">-</Text>,
    },
    {
      // 提示词：交给 Arco ellipsis 按列宽自适应截断（ellipsis:true 自带 Tooltip 悬停看全文），
      // 不再硬截断到 40 字 —— 列宽足够时能显示更多内容
      title: '提示词', dataIndex: 'prompt', ellipsis: true, render: (v: string) => v ? <Text style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary">-</Text>,
    },
    { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => <Tag color={TASK_STATUS[v]?.color || 'gray'}>{TASK_STATUS[v]?.label || v}</Tag> },
    { title: '进度', dataIndex: 'progress', width: 100, render: (v: number) => <Progress percent={v || 0} size="small" /> },
    { title: '积分', dataIndex: 'credits_consumed', width: 70, render: (v: number) => v ? <Text type="secondary">{v}</Text> : '-' },
    { title: '创建时间', dataIndex: 'created_at', width: 150, render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text> : '-' },
    { title: '操作', width: 200, render: (_: any, row: any) => (
      <Space>
        <Button size="small" type="text" onClick={() => setDetailTask(row)}>详情</Button>
        {(row.status === 'pending' || row.status === 'processing') && (
          <Button size="small" status="warning" onClick={() => handleCancel(row.id)}>取消</Button>
        )}
        {row.status === 'failed' && (
          <Button size="small" type="primary" onClick={() => handleRetry(row.id)}>重试</Button>
        )}
        <Popconfirm title="确认删除该任务记录？此操作不可恢复" onOk={() => handleDelete(row.id)}>
          <Button size="small" type="text" status="danger" icon={<IconDelete />} title="删除" />
        </Popconfirm>
      </Space>
    )},
  ]

  const modelOptions = (list: any[]) => list.map((m) => ({ label: m.name, value: m.id }))

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title heading={5} style={{ margin: 0 }}>视频生成</Title>
        <Space>
          <Button icon={<IconRefresh />} onClick={loadTasks}>刷新</Button>
          <Button type="primary" icon={<IconThunderbolt />} onClick={handleBatchOpen}>批量生成</Button>
        </Space>
      </div>

      {/* 文生图 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <IconImage style={{ color: 'rgb(var(--primary-6))' }} />
          <Text style={{ fontWeight: 600 }}>文生图</Text>
        </div>
        <Input.TextArea
          value={imagePrompt}
          onChange={setImagePrompt}
          placeholder="描述要生成的画面，例如：一位穿红衣的少女站在霓虹灯下的街道"
          autoSize={{ minRows: 2, maxRows: 4 }}
          style={{ marginBottom: 12 }}
        />
        <Space wrap>
          <Select
            placeholder="关联分镜（选填，便于追溯剧本/集数）"
            style={{ width: 240 }}
            value={imageSceneId}
            onChange={setImageSceneId}
            allowClear
            showSearch
          >
            {scenes.map((s: any) => (
              <Select.Option key={s.id} value={s.id}>
                {s.scriptTitle ? `${s.scriptTitle} / ` : ''}#{s.sequence} {s.prompt?.slice(0, 20) || ''}
              </Select.Option>
            ))}
          </Select>
          <Select
            placeholder="选择模型"
            style={{ width: 220 }}
            value={selectedImageModel}
            onChange={setSelectedImageModel}
            options={modelOptions(imageModels)}
            allowClear
          />
          <Button
            type="primary"
            icon={<IconImage />}
            loading={genImageLoading}
            disabled={!selectedImageModel}
            onClick={handleGenerateImage}
          >
            生成图片
          </Button>
          {imageModels.length === 0 && (
            <Text type="secondary">尚未配置可用模型，请到「后台管理 → 配置模型」添加</Text>
          )}
        </Space>
      </Card>

      {/* 图生视频：级联选择 剧本 → 片段 → 分镜 → 模型 → 质量 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <IconVideoCamera style={{ color: 'rgb(var(--primary-6))' }} />
          <Text style={{ fontWeight: 600 }}>图生视频</Text>
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>按顺序选择剧本、片段、分镜后生成</Text>
        </div>
        {/* 第一行：剧本 → 片段 → 分镜 */}
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col span={8}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>① 剧本</Text>
            <Select
              placeholder="选择剧本"
              style={{ width: '100%' }}
              value={genScriptId || undefined}
              onChange={onGenScriptChange}
              showSearch
              filterOption={(input: string, option: any) => (option?.label || '').toLowerCase().includes(input.toLowerCase())}
              options={genScripts.map((s) => ({ label: s.title || '未命名剧本', value: s.id }))}
            />
          </Col>
          <Col span={8}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>② 片段（集）</Text>
            <Select
              placeholder={genScriptId ? '选择片段' : '请先选择剧本'}
              style={{ width: '100%' }}
              value={genEpisodeId || undefined}
              onChange={onGenEpisodeChange}
              disabled={!genScriptId}
              options={genEpisodes.map((ep) => ({ label: `第${ep.number}集 ${ep.title || ''}`, value: ep.id }))}
            />
          </Col>
          <Col span={8}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>③ 分镜</Text>
            <Select
              placeholder={genEpisodeId ? '选择分镜' : '请先选择片段'}
              style={{ width: '100%' }}
              value={videoSceneId || undefined}
              onChange={setVideoSceneId}
              disabled={!genEpisodeId}
              showSearch
              filterOption={(input: string, option: any) => (option?.label || '').toLowerCase().includes(input.toLowerCase())}
              options={genScenes.map((sc) => ({ label: `#${sc.sequence} ${truncatePromptText(sc.prompt, 25)}`, value: sc.id }))}
            />
          </Col>
        </Row>
        {/* 第二行：首帧URL → 模型 → 质量 → 生成按钮 */}
        <Row gutter={[12, 12]} align="center">
          <Col span={8}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>首帧图片 URL（可选）</Text>
            <Input
              placeholder="https://...（留空则自动生图）"
              style={{ width: '100%' }}
              value={videoImageUrl}
              onChange={setVideoImageUrl}
              allowClear
            />
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>④ 模型</Text>
            <Select
              placeholder="选择模型"
              style={{ width: '100%' }}
              value={selectedVideoModel}
              onChange={setSelectedVideoModel}
              options={modelOptions(videoModels)}
            />
          </Col>
          <Col span={3}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>时长（秒）</Text>
            <InputNumber min={2} max={60} value={genDuration} onChange={(v) => setGenDuration(v || 5)} style={{ width: '100%' }} />
          </Col>
          <Col span={3}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>分辨率</Text>
            <Select value={genResolution} onChange={setGenResolution} style={{ width: '100%' }}>
              <Select.Option value="768P">768P</Select.Option>
              <Select.Option value="720p">720p</Select.Option>
              <Select.Option value="1080p">1080p</Select.Option>
              <Select.Option value="2k">2K</Select.Option>
            </Select>
          </Col>
          <Col span={4}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>⑤ 质量</Text>
            <Radio.Group value={genQuality} onChange={(v) => setGenQuality(v)}>
              <Radio value="hd">hd</Radio>
              <Radio value="standard">标准</Radio>
            </Radio.Group>
          </Col>
          <Col span={4}>
            <Button
              type="primary"
              icon={<IconVideoCamera />}
              loading={genVideoLoading}
              disabled={!selectedVideoModel || !videoSceneId}
              onClick={handleGenerateVideo}
              long
              style={{ marginTop: 18 }}
            >
              生成视频
            </Button>
          </Col>
        </Row>
        {videoModels.length === 0 && (
          <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>尚未配置可用视频模型，请到「后台管理 → 配置模型」添加 type=图生视频 的记录</Text>
        )}
      </Card>

      {/* 任务列表 */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size={32} /></div>
      ) : tasks.length === 0 ? (
        <Card><Empty description="暂无生成任务" /></Card>
      ) : (
        <Card>
          {/* 批量操作栏 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Space>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {selectedTaskIds.length > 0 ? `已选 ${selectedTaskIds.length} 项` : `共 ${tasks.length} 条记录`}
              </Text>
            </Space>
            <Space>
              {selectedTaskIds.length > 0 && (
                <Popconfirm
                  title={`确认删除选中的 ${selectedTaskIds.length} 条记录？此操作不可恢复`}
                  onOk={handleBatchDelete}
                  okButtonProps={{ loading: batchDeleting }}
                >
                  <Button status="danger" icon={<IconDelete />} loading={batchDeleting}>
                    批量删除（{selectedTaskIds.length}）
                  </Button>
                </Popconfirm>
              )}
            </Space>
          </div>
          <Table
            columns={columns}
            data={tasks}
            rowKey="id"
            scroll={{ x: 1200 }}
            pagination={{ pageSize: 10 }}
            rowSelection={{
              selectedRowKeys: selectedTaskIds,
              onChange: (keys: (string | number)[]) => setSelectedTaskIds(keys.map(String)),
            }}
          />
        </Card>
      )}

      {/* 批量生成弹窗 */}
      <Modal
        title="批量生成视频"
        visible={batchVisible}
        onCancel={() => setBatchVisible(false)}
        onOk={handleBatchGenerate}
        confirmLoading={batchGenerating}
        okText="开始生成"
        cancelText="取消"
        okButtonProps={{ disabled: !selectedBatchModel || selectedSceneIds.length === 0 }}
      >
        <Space style={{ marginBottom: 12 }}>
          <Text type="secondary">生成模型：</Text>
          <Select
            placeholder="选择视频模型"
            style={{ width: 240 }}
            value={selectedBatchModel}
            onChange={setSelectedBatchModel}
            options={modelOptions(videoModels)}
            allowClear
          />
        </Space>
        <Text type="secondary">选择要生成视频的分镜：</Text>
        <div style={{ marginTop: 12, maxHeight: 300, overflow: 'auto' }}>
          {scenes.length === 0 ? (
            <Text type="secondary">请先在分镜编辑器中创建分镜</Text>
          ) : (
            scenes.map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <input
                  type="checkbox"
                  checked={selectedSceneIds.includes(s.id)}
                  onChange={(e) => {
                    if (e.target.checked) setSelectedSceneIds([...selectedSceneIds, s.id])
                    else setSelectedSceneIds(selectedSceneIds.filter(id => id !== s.id))
                  }}
                />
                <Text>#{s.sequence} - {truncatePromptText(s.prompt, 40)}</Text>
              </label>
            ))
          )}
        </div>
      </Modal>

      {/* 媒体预览弹窗（图片/视频在线查看，不下载） */}
      <Modal
        visible={!!previewMedia}
        onCancel={() => setPreviewMedia(null)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw', padding: 0 }}
      >
        {previewMedia?.isVideo ? (
          <video src={previewMedia.url} controls autoPlay
            style={{ maxWidth: '85vw', maxHeight: '80vh' }} />
        ) : (
          <img src={previewMedia?.url} alt="预览"
            style={{ maxWidth: '85vw', maxHeight: '80vh', objectFit: 'contain' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        )}
      </Modal>

      {/* 任务详情弹窗：关联剧本/集数/分镜/模型/提示词/参数/时间 */}
      <Modal
        title="生成任务详情"
        visible={!!detailTask}
        onCancel={() => setDetailTask(null)}
        footer={null}
        style={{ width: 640, maxWidth: '90vw' }}
      >
        {detailTask && (
          <div style={{ lineHeight: 2 }}>
            <Row gutter={[8, 8]}>
              <Col span={12}><Text type="secondary">剧本：</Text><Text>{detailTask.script_title || '-'}</Text></Col>
              <Col span={12}><Text type="secondary">集数：</Text><Text>{detailTask.episode_number != null ? `第${detailTask.episode_number}集 ${detailTask.episode_title || ''}` : '-'}</Text></Col>
              <Col span={12}><Text type="secondary">分镜：</Text><Text>{detailTask.scene_sequence != null ? `#${detailTask.scene_sequence}` : '-'}</Text></Col>
              <Col span={12}><Text type="secondary">模型：</Text><Tag color="arcoblue">{detailTask.model || '-'}</Tag></Col>
              <Col span={12}><Text type="secondary">类型：</Text><Tag>{detailTask.type}</Tag></Col>
              <Col span={12}><Text type="secondary">状态：</Text><Tag color={TASK_STATUS[detailTask.status]?.color || 'gray'}>{TASK_STATUS[detailTask.status]?.label || detailTask.status}</Tag></Col>
              <Col span={12}><Text type="secondary">消耗积分：</Text><Text>{detailTask.credits_consumed || 0}</Text></Col>
              <Col span={12}><Text type="secondary">进度：</Text><Text>{detailTask.progress || 0}%</Text></Col>
            </Row>
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>提示词（@引用展开后）</Text>
              <div style={{ padding: 10, background: 'var(--color-fill-2)', borderRadius: 6, fontSize: 13, maxHeight: 120, overflow: 'auto' }}>
                {renderPromptText(detailTask.prompt || detailTask.input_data?.prompt) || '（无）'}
              </div>
            </div>
            {/* 生成参数 */}
            {detailTask.input_data && (
              <div style={{ marginTop: 12 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>生成参数</Text>
                <div style={{ padding: 10, background: 'var(--color-fill-2)', borderRadius: 6, fontSize: 12, fontFamily: 'monospace' }}>
                  {Object.entries(detailTask.input_data)
                    .filter(([k]) => !['prompt', 'elements', 'task_type', 'scene_id'].includes(k))
                    .map(([k, v]) => (
                      <div key={k}><Text type="secondary">{k}:</Text> {String(v)}</div>
                    ))}
                </div>
              </div>
            )}
            {/* 输出文件 */}
            {detailTask.output_urls?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>输出文件</Text>
                <Space wrap>
                  {detailTask.output_urls.map((url: string, i: number) => {
                    const isVideo = url.includes('.mp4') || url.includes('.webm') || url.includes('video')
                    return (
                      <Tag key={i} color="green" size="small" style={{ cursor: 'pointer' }}
                        onClick={() => setPreviewMedia({ url, isVideo })}>
                        {isVideo ? <IconPlayCircle /> : <IconImage />} 文件{i + 1}
                      </Tag>
                    )
                  })}
                </Space>
              </div>
            )}
            {detailTask.error_message && (
              <div style={{ marginTop: 12, color: 'var(--color-danger-6)', fontSize: 13 }}>
                <Text type="secondary">错误信息：</Text>{detailTask.error_message}
              </div>
            )}
            {/* 时间信息 */}
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-3)' }}>
              <div>创建时间：{detailTask.created_at ? new Date(detailTask.created_at).toLocaleString('zh-CN') : '-'}</div>
              <div>开始时间：{detailTask.started_at ? new Date(detailTask.started_at).toLocaleString('zh-CN') : '-'}</div>
              <div>完成时间：{detailTask.completed_at ? new Date(detailTask.completed_at).toLocaleString('zh-CN') : '-'}</div>
              <div>更新时间：{detailTask.updated_at ? new Date(detailTask.updated_at).toLocaleString('zh-CN') : '-'}</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default VideoPreviewPage
