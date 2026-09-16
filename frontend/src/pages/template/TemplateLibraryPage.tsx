/**
 * TemplateLibraryPage - 模板库（M9 新用户第一支片）
 *
 * 两大区块：
 * 1. 官方示例项目：含完整创作树（剧本/角色/场景/道具/集/分镜提示词），
 *    「一键克隆」到名下后直接体验生成全流程
 * 2. 剧本模板：按题材分类的剧本正文，选定后一键创建项目并预填剧本，
 *    之后走正常的 AI 解析 → 分镜流程
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  Button, Card, Drawer, Empty, Grid, Input, Message, Modal, Space, Spin,
  Tag, Typography,
} from '@arco-design/web-react'
import {
  IconApps, IconBook, IconCopy, IconEye, IconFile, IconPlus, IconRefresh,
  IconThunderbolt, IconUser,
} from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { projectService, templateService } from '@/api/services'

const { Title, Text, Paragraph } = Typography
const { Row, Col } = Grid

/** 题材筛选 chip（Arco 2.64 无 CheckableTag，自绘保持同风格） */
const GenreChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button
    onClick={onClick}
    style={{
      border: `1px solid ${active ? 'rgb(var(--primary-6))' : 'var(--color-border-2)'}`,
      background: active ? 'rgb(var(--primary-1))' : 'transparent',
      color: active ? 'rgb(var(--primary-6))' : 'var(--color-text-2)',
      borderRadius: 14, padding: '2px 12px', fontSize: 12, cursor: 'pointer',
      transition: 'all .15s',
    }}
  >{label}</button>
)

/** 题材 → 封面（public/template-covers，构建自带） */
const GENRE_COVER: Record<string, string> = {
  '都市甜宠': '/template-covers/urban-romance.svg',
  '古风玄幻': '/template-covers/ancient-fantasy.svg',
  '悬疑反转': '/template-covers/suspense-twist.svg',
  '战神赘婿': '/template-covers/warlord-soninlaw.svg',
  '穿越重生': '/template-covers/time-travel.svg',
  '家庭伦理': '/template-covers/family.svg',
  '励志逆袭': '/template-covers/underdog.svg',
  '校园青春': '/template-covers/campus.svg',
}

const TemplateLibraryPage: React.FC = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [examples, setExamples] = useState<any[]>([])
  const [scripts, setScripts] = useState<any[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [genre, setGenre] = useState<string>('')

  // 预览 / 克隆 / 使用
  const [preview, setPreview] = useState<any>(null)          // 剧本模板详情
  const [previewLoading, setPreviewLoading] = useState(false)
  const [projectPreview, setProjectPreview] = useState<any>(null) // 示例项目详情
  const [cloneTarget, setCloneTarget] = useState<any>(null)
  const [cloneName, setCloneName] = useState('')
  const [cloning, setCloning] = useState(false)
  const [useTarget, setUseTarget] = useState<any>(null)
  const [useName, setUseName] = useState('')
  const [using, setUsing] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [ex, sc]: any[] = await Promise.all([
        templateService.listProjectTemplates(),
        templateService.listScriptTemplates(),
      ])
      setExamples(ex?.items || [])
      setScripts(sc?.items || [])
      setGenres(sc?.genres || [])
    } catch { /* 拦截器提示 */ } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const filteredScripts = useMemo(
    () => genre ? scripts.filter((s) => s.genre === genre) : scripts,
    [scripts, genre],
  )

  const openPreview = async (tpl: any) => {
    setPreviewLoading(true)
    setPreview({ ...tpl }) // 先展示卡片数据
    try {
      const d: any = await templateService.getScriptTemplate(tpl.id)
      setPreview(d)
    } catch { /* 拦截器提示 */ } finally { setPreviewLoading(false) }
  }

  const openProjectPreview = async (ex: any) => {
    setProjectPreview({ ...ex, _loading: true })
    try {
      const d: any = await projectService.get(ex.id)
      setProjectPreview({ ...ex, ...d })
    } catch { /* 拦截器提示 */ } finally {
      setProjectPreview((p: any) => p && { ...p, _loading: false })
    }
  }

  const handleClone = async () => {
    if (!cloneTarget) return
    setCloning(true)
    try {
      const res: any = await templateService.cloneProjectTemplate(
        cloneTarget.id, cloneName || undefined)
      const pid = res?.project?.id
      Message.success('克隆完成，已复制完整示例内容')
      setCloneTarget(null)
      if (pid) navigate(`/projects/${pid}`)
      else navigate('/projects')
    } catch { /* 拦截器提示 */ } finally { setCloning(false) }
  }

  const handleUse = async () => {
    if (!useTarget) return
    setUsing(true)
    try {
      const res: any = await templateService.useScriptTemplate(useTarget.id, {
        project_name: useName || undefined,
      })
      Message.success('已用模板创建项目')
      setUseTarget(null)
      if (res?.project_id) {
        navigate(res.script_id
          ? `/projects/${res.project_id}/scripts/${res.script_id}`
          : `/projects/${res.project_id}`)
      } else navigate('/projects')
    } catch { /* 拦截器提示 */ } finally { setUsing(false) }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 100 }}><Spin size={32} tip="模板库加载中..." /></div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Title heading={5} style={{ margin: 0 }}>模板库</Title>
          <Text type="secondary">不知道从哪开始？克隆一个官方示例，或挑一个题材剧本直接开拍</Text>
        </div>
        <Space>
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
          <Button icon={<IconPlus />} onClick={() => navigate('/projects')}>空白新建</Button>
        </Space>
      </div>

      {/* ============ 区块一：官方示例项目 ============ */}
      <Title heading={6} style={{ margin: '4px 0 12px' }}>官方示例项目</Title>
      {examples.length === 0 ? (
        <Card style={{ marginBottom: 24 }}><Empty description="官方示例项目筹备中" /></Card>
      ) : (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          {examples.map((ex) => (
            <Col key={ex.id} span={8} style={{ marginBottom: 16 }}>
              <Card
                hoverable
                cover={
                  <div style={{ height: 150, overflow: 'hidden', background: 'var(--color-fill-2)' }}>
                    <img src={ex.cover_image_url || GENRE_COVER[ex.genre || ''] || '/template-covers/urban-romance.svg'}
                         alt={ex.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                }
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {ex.genre && <Tag color="arcoblue" size="small">{ex.genre}</Tag>}
                  <Text style={{ fontSize: 15, fontWeight: 600 }} ellipsis>{ex.name}</Text>
                </div>
                <Paragraph type="secondary" style={{ minHeight: 44, marginBottom: 10, fontSize: 13 }} ellipsis={{ rows: 2 }}>
                  {ex.description || '官方示例项目'}
                </Paragraph>
                <div style={{ display: 'flex', gap: 12, marginBottom: 12, color: 'var(--color-text-3)', fontSize: 12 }}>
                  <span><IconFile /> {ex.script_count ?? 0} 剧本</span>
                  <span><IconApps /> {ex.scene_count ?? 0} 分镜</span>
                  <span><IconUser /> {ex.character_count ?? 0} 角色</span>
                </div>
                <Space size={8}>
                  <Button type="primary" size="small" icon={<IconCopy />}
                    onClick={() => { setCloneTarget(ex); setCloneName(`${ex.name}·我的副本`) }}>一键克隆</Button>
                  <Button size="small" icon={<IconEye />} onClick={() => openProjectPreview(ex)}>预览内容</Button>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* ============ 区块二：剧本模板 ============ */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <Title heading={6} style={{ margin: 0 }}>剧本模板 · 按题材</Title>
        <Space size={6} wrap>
          <GenreChip label="全部" active={genre === ''} onClick={() => setGenre('')} />
          {genres.map((g) => (
            <GenreChip key={g} label={g} active={genre === g} onClick={() => setGenre(genre === g ? '' : g)} />
          ))}
        </Space>
      </div>
      {filteredScripts.length === 0 ? (
        <Card><Empty description="该题材暂无模板" /></Card>
      ) : (
        <Row gutter={16}>
          {filteredScripts.map((t) => (
            <Col key={t.id} span={8} style={{ marginBottom: 16 }}>
              <Card hoverable>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{
                    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                    background: `center / cover url(${GENRE_COVER[t.genre] || '/template-covers/urban-romance.svg'})`,
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: 600, display: 'block' }} ellipsis>《{t.title}》</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t.genre} · 约{Math.round((t.content_length || 0) / 100) / 10}百字</Text>
                  </div>
                </div>
                <Paragraph type="secondary" style={{ minHeight: 44, marginBottom: 10, fontSize: 13 }} ellipsis={{ rows: 2 }}>
                  {t.logline || t.description || '剧本模板'}
                </Paragraph>
                <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                  {(t.tags || []).map((tag: string) => <Tag key={tag} size="small">{tag}</Tag>)}
                  <Tag size="small" color="gray">{t.character_count ?? 0} 角色</Tag>
                </div>
                <Space size={8}>
                  <Button type="primary" size="small" icon={<IconThunderbolt />}
                    onClick={() => { setUseTarget(t); setUseName(`${t.title}·新项目`) }}>用此模板创建</Button>
                  <Button size="small" icon={<IconBook />} onClick={() => openPreview(t)}>查看剧本</Button>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* 剧本模板详情抽屉 */}
      <Drawer
        width={640}
        title={preview ? `《${preview.title}》 · ${preview.genre}` : '剧本模板'}
        visible={!!preview}
        footer={null}
        unmountOnExit
        onCancel={() => setPreview(null)}
      >
        {previewLoading && !preview?.content
          ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
          : preview && (
            <div>
              {preview.logline && (
                <Paragraph style={{ fontSize: 13, color: 'var(--color-text-2)', background: 'var(--color-fill-2)', padding: '10px 12px', borderRadius: 6 }}>
                  {preview.logline}
                </Paragraph>
              )}
              {preview.description && <Paragraph type="secondary">{preview.description}</Paragraph>}
              {preview.characters?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Text style={{ fontWeight: 600 }}>推荐角色</Text>
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {preview.characters.map((c: any) => (
                      <div key={c.name} style={{ padding: '8px 12px', border: '1px solid var(--color-border-2)', borderRadius: 6 }}>
                        <Space size={8}><Text style={{ fontWeight: 600 }}>{c.name}</Text><Tag size="small" color="gray">{c.role}</Tag></Space>
                        <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{c.appearance_prompt}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <Text style={{ fontWeight: 600 }}>剧本正文</Text>
              <pre style={{
                marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.9,
                background: 'var(--color-fill-1)', padding: 16, borderRadius: 6,
                maxHeight: 380, overflow: 'auto',
              }}>{preview.content || '（加载中...）'}</pre>
              <Button type="primary" long icon={<IconThunderbolt />} style={{ marginTop: 16 }}
                onClick={() => { setUseTarget(preview); setUseName(`${preview.title}·新项目`); setPreview(null) }}>
                用此模板创建项目
              </Button>
            </div>
          )}
      </Drawer>

      {/* 示例项目预览抽屉 */}
      <Drawer
        width={640}
        title={projectPreview ? projectPreview.name : '示例项目'}
        visible={!!projectPreview}
        footer={null}
        unmountOnExit
        onCancel={() => setProjectPreview(null)}
      >
        {projectPreview?._loading && <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>}
        {projectPreview && (
          <div>
            <Paragraph type="secondary">{projectPreview.template_desc || projectPreview.description}</Paragraph>
            {projectPreview.scripts?.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Text style={{ fontWeight: 600 }}>剧本（{projectPreview.scripts.length}）</Text>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {projectPreview.scripts.map((s: any) => (
                    <div key={s.id} style={{ padding: '8px 12px', background: 'var(--color-fill-2)', borderRadius: 6 }}>
                      <Text style={{ fontWeight: 500 }}>{s.title}</Text>
                      <Tag size="small" color={s.parsed_data ? 'green' : 'gray'} style={{ marginLeft: 8 }}>
                        {s.parsed_data ? '已解析' : '未解析'}
                      </Tag>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {projectPreview.characters?.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Text style={{ fontWeight: 600 }}>角色（{projectPreview.characters.length}）</Text>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {projectPreview.characters.map((c: any) => (
                    <div key={c.id || c.name} style={{ padding: '8px 12px', border: '1px solid var(--color-border-2)', borderRadius: 6 }}>
                      <Space size={8}><Text style={{ fontWeight: 600 }}>{c.name}</Text></Space>
                      <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{c.appearance_prompt || c.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {projectPreview.scene_backgrounds?.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Text style={{ fontWeight: 600 }}>场景（{projectPreview.scene_backgrounds.length}）</Text>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {projectPreview.scene_backgrounds.map((b: any) => (
                    <div key={b.id || b.name} style={{ padding: '8px 12px', background: 'var(--color-fill-2)', borderRadius: 6 }}>
                      <Text style={{ fontWeight: 500 }}>{b.name}</Text>
                      <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 4 }}>{b.prompt}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Button type="primary" long icon={<IconCopy />} style={{ marginTop: 8 }}
              onClick={() => { setCloneTarget(projectPreview); setCloneName(`${projectPreview.name}·我的副本`); setProjectPreview(null) }}>
              一键克隆到我的项目
            </Button>
          </div>
        )}
      </Drawer>

      {/* 克隆确认弹窗 */}
      <Modal
        title="克隆示例项目"
        visible={!!cloneTarget}
        onCancel={() => setCloneTarget(null)}
        onOk={handleClone}
        confirmLoading={cloning}
        okText="克隆"
        cancelText="取消"
      >
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--color-text-3)' }}>
          将复制完整创作树（剧本、角色、场景、道具、分镜提示词）到你的名下，生成任务与成片不会复制。
        </div>
        <Input placeholder="新项目名称" value={cloneName} onChange={setCloneName} maxLength={255} />
      </Modal>

      {/* 用剧本模板创建项目弹窗 */}
      <Modal
        title="用剧本模板创建项目"
        visible={!!useTarget}
        onCancel={() => setUseTarget(null)}
        onOk={handleUse}
        confirmLoading={using}
        okText="创建"
        cancelText="取消"
      >
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--color-text-3)' }}>
          将创建新项目并预填《{useTarget?.title}》剧本正文，创建后点击「AI 解析」即可拆分镜。
        </div>
        <Input placeholder="新项目名称" value={useName} onChange={setUseName} maxLength={255} />
      </Modal>
    </div>
  )
}

export default TemplateLibraryPage
