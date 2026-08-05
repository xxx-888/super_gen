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
} from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { scriptService } from '@/api/services'
import type { Script } from '@/types'

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
  const [page, setPage] = useState(1)

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

  const handleDelete = async (id: string) => {
    try {
      await scriptService.delete(id)
      Message.success('已删除')
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
                      title="确认删除该剧本？此操作不可恢复"
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
    </div>
  )
}

export default ScriptListPage
