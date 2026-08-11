/**
 * ScriptListPage - 剧本管理（列表页）
 *
 * 对标 EpisodeListPage 的卡片网格布局：
 * - 顶部: 搜索 + 新建剧本
 * - 卡片网格: 每剧本一张卡(标题 + 内容预览 + 已解析标签 + 进入/删除)
 * - 点击卡片进入剧本编辑器 /projects/:id/scripts/:scriptId
 *
 * 此页修复了之前「侧边栏剧本管理 → 跳到 dashboard」的 bug：
 * 原路由只注册了 scripts/:scriptId，没有列表页，会落到 * fallback。
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Card, Spin, Typography, Grid, Button, Space, Input, Tag, Message,
  Popconfirm, Empty, Pagination,
} from '@arco-design/web-react'
import {
  IconPlus, IconRefresh, IconDelete, IconFile, IconCheckCircle,
  IconThunderbolt, IconVideoCamera, IconUser, IconLocation, IconGift,
  IconUpload,
} from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { scriptService } from '@/api/services'
import type { Script } from '@/types'
import ImportPreviewModal, { ProcessedResult } from '@/components/script/ImportPreviewModal'
import { getTaskPollTimeout } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography
const { Row, Col } = Grid

const PAGE_SIZE = 12

const ScriptListPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [scripts, setScripts] = useState<Script[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [page, setPage] = useState(1)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  // AI 导入预览
  const [previewVisible, setPreviewVisible] = useState(false)
  const [previewFilename, setPreviewFilename] = useState('')
  const [previewProcessed, setPreviewProcessed] = useState<ProcessedResult | null>(null)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const res: any = await scriptService.list(projectId)
      let list: Script[] = Array.isArray(res) ? res : (res?.data ?? [])
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        list = list.filter(s =>
          (s.title || '').toLowerCase().includes(q) ||
          (s.content || '').toLowerCase().includes(q),
        )
      }
      setScripts(list)
    } catch {
      /* 拦截器已提示 */
    } finally {
      setLoading(false)
    }
  }, [projectId, search])

  useEffect(() => { load() }, [load])

  // 恢复未完成的上传任务（切页回来后继续轮询）
  useEffect(() => {
    const pending = localStorage.getItem('pending_upload_task')
    if (!pending) return
    try {
      const { taskId, filename, title, content } = JSON.parse(pending)
      if (taskId) {
        setUploading(true)
        Message.loading({ content: '正在恢复 AI 智能处理...', duration: 0 })
        pollUploadStatus(taskId).then(async (processed) => {
          Message.clear()
          localStorage.removeItem('pending_upload_task')
          if (processed && Array.isArray(processed.episodes) && processed.episodes.length > 0) {
            setPreviewFilename(filename || '')
            setPreviewProcessed(processed)
            setPreviewVisible(true)
          } else if (content && projectId) {
            const crRes: any = await scriptService.create(projectId, { title: title || filename, content })
            const created = crRes?.data ?? crRes
            Message.success(`已导入「${filename || '文件'}」`)
            navigate(`/projects/${projectId}/scripts/${created.id}`)
          }
        }).finally(() => setUploading(false))
      }
    } catch { localStorage.removeItem('pending_upload_task') }
  }, [projectId])

  const handleCreate = async () => {
    if (!projectId) return
    setCreating(true)
    try {
      const res: any = await scriptService.create(projectId, {
        title: `未命名剧本 ${new Date().toLocaleDateString()}`,
        content: '',
      })
      const created = res?.data ?? res
      Message.success('剧本已创建')
      // 直接进入编辑器
      navigate(`/projects/${projectId}/scripts/${created.id}`)
    } catch {
      Message.error('创建失败')
    } finally {
      setCreating(false)
    }
  }

  // 轮询上传 AI 处理状态（超时上限跟随后台「系统设置」的 task_poll_timeout_seconds）
  const pollUploadStatus = (taskId: string): Promise<any> => {
    return new Promise((resolve) => {
      const intervalSec = 5
      // +10 次冗余：确保前端不会比后端先放弃
      const maxAttempts = Math.ceil(getTaskPollTimeout() / intervalSec) + 10
      let attempts = 0
      const poll = async () => {
        attempts++
        try {
          const res: any = await scriptService.uploadStatus(taskId)
          const data = res?.data ?? res
          if (data.status === 'completed') {
            resolve(data.result)
            return
          }
          if (data.status === 'failed') {
            resolve(null)
            return
          }
        } catch { /* 网络错误继续轮询 */ }
        if (attempts >= maxAttempts) {
          resolve(null)
          return
        }
        setTimeout(poll, intervalSec * 1000)
      }
      poll()
    })
  }

  // 文件上传：提取文档 → 轮询 AI 处理 → 预览 → 创建
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !projectId) return
    setUploading(true)
    try {
      const upRes: any = await scriptService.upload(file)
      const upData = upRes?.data ?? upRes
      const taskId = upData?.task_id

      if (taskId) {
        // 存入 localStorage，切页回来可恢复
        localStorage.setItem('pending_upload_task', JSON.stringify({
          taskId, filename: file.name, title: upData?.title, content: upData?.content,
        }))
        // 异步模式：轮询 AI 处理状态
        Message.loading({ content: '正在 AI 智能处理（清理水印+分集识别）...', duration: 0 })
        const processed = await pollUploadStatus(taskId)
        Message.clear()
        localStorage.removeItem('pending_upload_task')

        if (processed && Array.isArray(processed.episodes) && processed.episodes.length > 0) {
          // AI 处理成功：弹出预览
          setPreviewFilename(upData?.filename || file.name)
          setPreviewProcessed(processed)
          setPreviewVisible(true)
        } else {
          // AI 失败/降级：直接创建单剧本
          const crRes: any = await scriptService.create(projectId, {
            title: upData?.title || file.name,
            content: upData?.content || '',
          })
          const created = crRes?.data ?? crRes
          Message.success(`已导入「${file.name}」`)
          navigate(`/projects/${projectId}/scripts/${created.id}`)
        }
      } else {
        // 无 task_id（旧逻辑兼容）：直接创建
        const crRes: any = await scriptService.create(projectId, {
          title: upData?.title || file.name,
          content: upData?.content || '',
        })
        const created = crRes?.data ?? crRes
        Message.success(`已导入「${file.name}」`)
        navigate(`/projects/${projectId}/scripts/${created.id}`)
      }
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '导入失败')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // 预览弹窗：创建 N 个独立剧本
  const handleBatchCreate = async (episodes: Array<{ title: string; content: string }>) => {
    if (!projectId) return
    try {
      const res: any = await scriptService.batchCreate(projectId, episodes)
      const created = Array.isArray(res) ? res : (res?.data ?? [])
      setPreviewVisible(false)
      Message.success(`已创建 ${created.length} 个剧本`)
      load()
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '创建失败')
    }
  }

  // 预览弹窗：合并为一个剧本
  const handleMergeToOne = async (content: string) => {
    if (!projectId) return
    try {
      const res: any = await scriptService.create(projectId, { title: previewFilename, content })
      const created = res?.data ?? res
      setPreviewVisible(false)
      Message.success('已创建剧本')
      navigate(`/projects/${projectId}/scripts/${created.id}`)
    } catch (err: any) {
      Message.error(err?.response?.data?.detail || '创建失败')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res: any = await scriptService.delete(id)
      const d = res?.data ?? res
      const ep = d?.deleted_episodes || 0
      const sc = d?.deleted_scenes || 0
      Message.success(`已删除剧本${ep || sc ? `（同时删除 ${ep} 个片段、${sc} 个分镜）` : ''}`)
      load()
    } catch {
      Message.error('删除失败')
    }
  }

  return (
    <div>
      {/* 顶部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title heading={5} style={{ margin: 0 }}>剧本管理</Title>
        <Space>
          <Input.Search
            placeholder="搜索剧本"
            style={{ width: 200 }}
            value={search}
            onChange={(v) => { setSearch(v); setPage(1) }}
            onSearch={load}
            allowClear
          />
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
          {/* 隐藏的文件上传 input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.pdf,.docx"
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />
          <Button icon={<IconUpload />} loading={uploading} onClick={() => fileInputRef.current?.click()}>
            导入文件
          </Button>
          <Button type="primary" icon={<IconPlus />} loading={creating} onClick={handleCreate}>新建剧本</Button>
        </Space>
      </div>

      {/* 列表 */}
      {loading ? (
        <Spin dot style={{ display: 'block', margin: '60px auto' }} />
      ) : scripts.length === 0 ? (
        <Empty
          description="暂无剧本，点击「新建剧本」开始"
          style={{ marginTop: 60 }}
        />
      ) : (
        <>
        <Row gutter={[16, 16]}>
          {scripts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((s) => {
            const pd = s.parsed_data
            // 兼容新旧解析格式：新格式(LLM)用 shots/characters/scenes/props；
            // 旧格式(正则)用 scenes(分镜)/extracted_characters
            const shotCount = pd?.shots?.length ?? pd?.scenes?.length ?? s.scene_count ?? 0
            const charCount = pd?.characters?.length ?? pd?.extracted_characters?.length ?? 0
            const sceneCount = pd?.scenes && pd?.shots ? pd.scenes.length : 0  // 新格式才有独立场景数
            const propCount = pd?.props?.length ?? 0
            return (
              <Col key={s.id} xs={24} sm={12} lg={8} xl={6}>
                <Card
                  hoverable
                  onClick={() => navigate(`/projects/${projectId}/scripts/${s.id}`)}
                  bodyStyle={{ padding: 16 }}
                >
                  {/* 头部：图标 + 标题 + 状态 */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                    <IconFile style={{ fontSize: 22, color: 'rgb(var(--primary-6))', flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontWeight: 600, fontSize: 15, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.title || '未命名剧本'}
                      </Text>
                      <Space size={4} style={{ marginTop: 4 }}>
                        {s.parsed_data ? (
                          <Tag color="green" size="small"><IconCheckCircle /> 已解析</Tag>
                        ) : (
                          <Tag color="gray" size="small">草稿</Tag>
                        )}
                        <Tag size="small">{s.format || 'plain'}</Tag>
                      </Space>
                    </div>
                  </div>

                  {/* 内容预览 */}
                  <Text
                    type="secondary"
                    style={{
                      display: 'block', fontSize: 13, lineHeight: 1.6,
                      minHeight: 42, maxHeight: 42, overflow: 'hidden',
                      color: 'var(--color-text-3)',
                    }}
                  >
                    {s.content
                      ? s.content.length > 80 ? `${s.content.slice(0, 80)}...` : s.content
                      : '空剧本'}
                  </Text>

                  {/* 统计：与片段管理对齐，展示分镜/角色/场景/物品 */}
                  {(shotCount > 0 || charCount > 0) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, color: 'var(--color-text-3)', marginTop: 8 }}>
                      {shotCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconVideoCamera /> {shotCount} 分镜</span>}
                      {charCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconUser /> {charCount} 角色</span>}
                      {sceneCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconLocation /> {sceneCount} 场景</span>}
                      {propCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconGift /> {propCount} 物品</span>}
                    </div>
                  )}

                  {/* 操作 */}
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-fill-2)' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<IconVideoCamera />}
                      onClick={() => navigate(`/projects/${projectId}/scripts/${s.id}`)}
                    >
                      打开
                    </Button>
                    <Popconfirm
                      title="确认删除该剧本？关联的片段、分镜将一并删除，操作不可恢复"
                      onOk={() => handleDelete(s.id)}
                    >
                      <Button type="text" size="small" status="danger" icon={<IconDelete />} />
                    </Popconfirm>
                  </div>
                </Card>
              </Col>
            )
          })}
        </Row>
        {scripts.length > PAGE_SIZE && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
            <Pagination
              total={scripts.length}
              current={page}
              pageSize={PAGE_SIZE}
              onChange={(p: number) => setPage(p)}
              showTotal
              size="canChange"
            />
          </div>
        )}
        </>
      )}

      {/* AI 导入预览弹窗 */}
      <ImportPreviewModal
        visible={previewVisible}
        filename={previewFilename}
        processed={previewProcessed}
        onCancel={() => setPreviewVisible(false)}
        onBatchCreate={handleBatchCreate}
        onMergeToOne={handleMergeToOne}
      />
    </div>
  )
}

export default ScriptListPage
