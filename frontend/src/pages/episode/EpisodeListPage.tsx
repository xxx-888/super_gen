/**
 * EpisodeListPage - 集(片段)管理 (M4)
 *
 * 对标目标网站 project_page/snippets:
 * - 4:3 卡片网格, 每集一张卡片(封面+集号+状态)
 * - 每卡片: 一键成片按钮 + 智能审片开关 + 此步后停止 + ellipsis菜单(编辑/删除)
 * - 顶部: 搜索 + 排序 + 新建集
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Spin, Typography, Grid, Button, Space, Input, Tag, Switch, Message,
  Dropdown, Menu, Modal, Popconfirm, Empty, Tooltip, Pagination, Select,
} from '@arco-design/web-react'
import {
  IconPlus, IconRefresh, IconMoreVertical, IconEdit, IconDelete,
  IconVideoCamera, IconCheckCircle, IconPauseCircle, IconExclamationCircle, IconImage,
} from '@arco-design/web-react/icon'
import { useParams, useNavigate } from 'react-router-dom'
import { episodeService, materialLibraryService } from '@/api/services'
import { useTeamStore } from '@/stores'
import { Episode, EpisodeStatus, EPISODE_STATUS_LABELS } from '@/types'

const PAGE_SIZE = 12

const { Title, Text } = Typography
const { Row, Col } = Grid

const STATUS_COLORS: Record<EpisodeStatus, string> = {
  asset: 'gray',
  pending_submit: 'orange',
  video_editing: 'arcoblue',
  completed: 'green',
}

const EpisodeListPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [rendering, setRendering] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<Episode | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [coverTarget, setCoverTarget] = useState<Episode | null>(null)
  const [coverUrl, setCoverUrl] = useState('')
  // 从素材库选封面
  const { currentOrg } = useTeamStore()
  const [coverPickerVisible, setCoverPickerVisible] = useState(false)
  const [coverPicks, setCoverPicks] = useState<any[]>([])
  const [coverPicksLoading, setCoverPicksLoading] = useState(false)
  const [page, setPage] = useState(1)

  const svc = React.useMemo(() => (projectId ? episodeService(projectId) : null), [projectId])

  const load = useCallback(async () => {
    if (!svc) return
    setLoading(true)
    try {
      const res: any = await svc.list(search ? { search } : undefined)
      setEpisodes(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [svc, search])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!svc) return
    try {
      await svc.create({})
      Message.success('新集已创建')
      load()
    } catch { Message.error('创建失败') }
  }

  const handleRender = async (ep: Episode) => {
    if (!svc) return
    // 与集详情页同逻辑：先取分镜判断 —— 全部已生成 → 直接合并成片（不提交生成、不扣积分）
    try {
      const clipsRes: any = await svc.clips(ep.id)
      const clips = Array.isArray(clipsRes) ? clipsRes : (clipsRes?.data ?? [])
      const allDone = clips.length > 0 && clips.every((c: any) => c.status === 'completed' && c.generated_video_url)
      if (allDone) {
        Modal.confirm({
          title: '合并完整成片',
          content: `本集 ${clips.length} 个分镜已全部生成，将按分镜顺序合并为一个完整视频（不提交生成任务、不消耗积分）。`,
          okText: '开始合并',
          cancelText: '取消',
          onOk: async () => {
            setRendering(ep.id)
            try {
              const res: any = await svc.compose(ep.id)
              const r = res?.data ?? res
              Message.success(`合并完成！已合成 ${r.clip_count} 个分镜`)
              load()
            } catch { /* 拦截器提示 */ } finally { setRendering(null) }
          },
        })
        return
      }
    } catch { /* 分镜读取失败按原一键成片流程走 */ }
    // 有未完成分镜 → 一键成片编排生成
    setRendering(ep.id)
    try {
      const res: any = await svc.oneClickRender(ep.id)
      const r = res?.data ?? res
      if (r.credits_consumed > 0) {
        Message.success(`一键成片已提交: ${r.tasks?.length || 0}个任务, 消耗${r.credits_consumed}积分`)
      } else {
        Message.info(r.message || '该集暂无分镜, 已跳过')
      }
      load()
    } catch (e: any) {
      Message.error(e?.message || '一键成片失败')
    } finally { setRendering(null) }
  }

  const handleToggleSmartReview = async (ep: Episode, value: boolean) => {
    if (!svc) return
    try {
      await svc.setSmartReview(ep.id, value)
      setEpisodes(eps => eps.map(e => e.id === ep.id ? { ...e, smart_review: value } : e))
    } catch { Message.error('设置失败') }
  }

  const handleToggleStopAfter = async (ep: Episode, value: boolean) => {
    if (!svc) return
    try {
      await svc.setStopAfter(ep.id, value)
      setEpisodes(eps => eps.map(e => e.id === ep.id ? { ...e, stop_after_step: value } : e))
    } catch { Message.error('设置失败') }
  }

  // 状态编辑：按后端状态机列出当前状态允许的全部流转（含回退），
  // 完成后仍可回退到「视频编辑」重新处理
  const STATUS_TRANSITIONS: Record<EpisodeStatus, EpisodeStatus[]> = {
    asset: ['asset', 'pending_submit'],
    pending_submit: ['pending_submit', 'asset', 'video_editing'],
    video_editing: ['video_editing', 'pending_submit', 'completed'],
    completed: ['completed', 'video_editing'],
  }

  const handleSetStatus = async (ep: Episode, ns: EpisodeStatus) => {
    if (!svc || ns === ep.status) return
    try {
      await svc.setStatus(ep.id, ns)
      Message.success(`状态: ${EPISODE_STATUS_LABELS[ep.status]} → ${EPISODE_STATUS_LABELS[ns]}`)
      load()
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || e?.message || '状态流转失败')
    }
  }

  const handleEdit = async () => {
    if (!svc || !editTarget) return
    try {
      await svc.update(editTarget.id, { title: editTitle })
      Message.success('已更新')
      setEditTarget(null); load()
    } catch { Message.error('更新失败') }
  }

  const handleDelete = async (ep: Episode) => {
    if (!svc) return
    try {
      await svc.delete(ep.id)
      Message.success('已删除')
      load()
    } catch { Message.error('删除失败') }
  }

  const handleSaveCover = async () => {
    if (!svc || !coverTarget) return
    try {
      await svc.update(coverTarget.id, { cover_image_url: coverUrl })
      Message.success('封面已更新')
      setCoverTarget(null); setCoverUrl(''); load()
    } catch { Message.error('更新失败') }
  }

  // 从素材库选封面
  const openCoverPicker = async () => {
    setCoverPickerVisible(true)
    if (!currentOrg?.id) return
    setCoverPicksLoading(true)
    try {
      const res: any = await materialLibraryService(currentOrg.id).list({ category: 'image', page_size: 60 })
      setCoverPicks(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* */ } finally { setCoverPicksLoading(false) }
  }

  const pickCover = (url: string) => {
    setCoverUrl(url)
    setCoverPickerVisible(false)
  }

  const cardMenu = (ep: Episode) => (
    <Menu onClickMenuItem={(key) => {
      if (key === 'edit') { setEditTarget(ep); setEditTitle(ep.title) }
      else if (key === 'cover') { setCoverTarget(ep); setCoverUrl(ep.cover_image_url || '') }
      else if (key === 'delete') handleDelete(ep)
    }}>
      <Menu.Item key="edit"><Space><IconEdit />编辑标题</Space></Menu.Item>
      <Menu.Item key="cover"><Space><IconImage />设置封面</Space></Menu.Item>
      <Menu.Item key="delete"><Space><IconDelete style={{ color: 'rgb(var(--danger-6))' }} />删除</Space></Menu.Item>
    </Menu>
  )

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title heading={5} style={{ margin: 0 }}>片段管理（集）</Title>
        <Space>
          <Input.Search placeholder="搜索集" style={{ width: 180 }} value={search} onChange={(v) => { setSearch(v); setPage(1) }} onSearch={load} allowClear />
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<IconPlus />} onClick={handleCreate}>新建集</Button>
        </Space>
      </div>

      {loading ? <Spin dot style={{ display: 'block', margin: '60px auto' }} /> :
       episodes.length === 0 ? <Empty description="暂无集, 点击「新建集」开始" style={{ marginTop: 60 }} /> :
       <>
       <Row gutter={[16, 16]}>
         {episodes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((ep) => (
           <Col key={ep.id} xs={12} sm={8} md={6} lg={4}>
             <Card
               size="small"
               hoverable
               cover={
                 <div
                   style={{
                     position: 'relative', aspectRatio: '4/3', background: 'var(--color-fill-3)',
                     display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                     cursor: 'pointer',
                   }}
                   onClick={() => navigate(`/projects/${projectId}/episodes/${ep.id}`)}
                 >
                   {ep.cover_image_url ? (
                     <img src={ep.cover_image_url} alt={ep.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                   ) : (
                     <IconVideoCamera style={{ fontSize: 36, color: 'var(--color-text-3)' }} />
                   )}
                   {/* 集号 */}
                   <div style={{
                     position: 'absolute', top: 6, left: 8, color: '#fff', fontWeight: 700,
                     textShadow: '0 1px 3px rgba(0,0,0,0.6)', fontSize: 13,
                   }}>
                     {ep.title}
                   </div>
                   {/* 状态角标 */}
                   <div style={{ position: 'absolute', bottom: 6, left: 8 }}>
                     <Tag color={STATUS_COLORS[ep.status]} size="small">{EPISODE_STATUS_LABELS[ep.status]}</Tag>
                   </div>
                   {/* 此步后停止 */}
                   {ep.stop_after_step && (
                     <Tooltip content="此步后停止">
                       <div style={{ position: 'absolute', top: 6, right: 8 }}>
                         <IconPauseCircle style={{ color: '#fff', fontSize: 16, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }} />
                       </div>
                     </Tooltip>
                   )}
                 </div>
               }
             >
               {/* 统计 */}
               <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-text-3)', marginBottom: 8 }}>
                 <span>分镜 {ep.scene_count}</span>
                 <span>已完成 {ep.completed_count}</span>
               </div>

               {/* 一键成片：全部分镜已生成时自动切换为合并成片（不扣积分），完成后也可重新合并 */}
               <Button
                 type="primary" long size="small" icon={<IconVideoCamera />}
                 loading={rendering === ep.id}
                style={{ marginBottom: 8 }}
                 onClick={() => handleRender(ep)}
               >一键成片</Button>

               {/* 状态编辑：下拉选择，完成后可回退重新编辑 */}
               <Select
                 size="small"
                 value={ep.status}
                 onChange={(v: any) => handleSetStatus(ep, v as EpisodeStatus)}
                 style={{ width: '100%', marginBottom: 8 }}
               >
                 {STATUS_TRANSITIONS[ep.status].map((s) => (
                   <Select.Option key={s} value={s} disabled={s === ep.status}>
                     {s === ep.status ? `当前：${EPISODE_STATUS_LABELS[s]}` : `切换到 ${EPISODE_STATUS_LABELS[s]}`}
                   </Select.Option>
                 ))}
               </Select>

              {/* 开关 + 菜单 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Space size="small" style={{ fontSize: 11, color: 'var(--color-text-3)' }}>
                  <Tooltip content="开启后，生成的视频会自动进行 AI 审片检查">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer' }}>
                      <Switch size="mini" checked={ep.smart_review} onChange={(v) => handleToggleSmartReview(ep, v)} />
                      智能审片
                    </span>
                  </Tooltip>
                  <Tooltip content="开启后，该集处理完当前步骤就停止，不继续后续流程">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer' }}>
                      <Switch size="mini" checked={ep.stop_after_step} onChange={(v) => handleToggleStopAfter(ep, v)} />
                      此步后停止
                    </span>
                  </Tooltip>
                </Space>
                <Dropdown droplist={cardMenu(ep)} position="br" trigger="click">
                  <IconMoreVertical style={{ cursor: 'pointer', color: 'var(--color-text-2)' }} />
                </Dropdown>
              </div>
             </Card>
           </Col>
         ))}
       </Row>
       {episodes.length > PAGE_SIZE && (
         <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
           <Pagination
             total={episodes.length}
             current={page}
             pageSize={PAGE_SIZE}
             onChange={(p: number) => setPage(p)}
             showTotal
             size="canChange"
           />
         </div>
       )}
       </>
      }

      {/* 编辑弹窗 */}
      <Modal
        title="编辑集" visible={!!editTarget}
        onCancel={() => setEditTarget(null)} onOk={handleEdit}
        okText="保存" cancelText="取消"
      >
        <Input value={editTitle} onChange={setEditTitle} placeholder="集标题" />
      </Modal>

      {/* 设置封面弹窗 */}
      <Modal
        title="设置集封面" visible={!!coverTarget}
        onCancel={() => setCoverTarget(null)} onOk={handleSaveCover}
        okText="保存" cancelText="取消"
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          输入封面图片 URL，或从企业素材库选择
        </Text>
        <Space style={{ width: '100%' }}>
          <Input value={coverUrl} onChange={setCoverUrl} placeholder="https://example.com/cover.jpg" style={{ flex: 1 }} />
          <Button icon={<IconImage />} onClick={openCoverPicker}>从素材库选</Button>
        </Space>
        {coverUrl && (
          <div style={{ marginTop: 12 }}>
            <img src={coverUrl} alt="封面预览" style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 8 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          </div>
        )}
      </Modal>

      {/* 从素材库选封面弹窗 */}
      <Modal
        title="从素材库选择封面" visible={coverPickerVisible}
        onCancel={() => setCoverPickerVisible(false)} footer={null}
        style={{ width: 720 }}
      >
        {coverPicksLoading ? <Spin dot style={{ display: 'block', margin: '40px auto' }} /> :
         coverPicks.length === 0 ? <Empty description="素材库暂无图片" /> :
         <Row gutter={[8, 8]} style={{ maxHeight: 400, overflowY: 'auto' }}>
           {coverPicks.map((m: any) => (
             <Col key={m.id} span={6}>
               <Card size="small" hoverable bodyStyle={{ padding: 4 }}
                 onClick={() => pickCover(m.thumbnail_url || m.url)}>
                 <div style={{ aspectRatio: '3/4', background: 'var(--color-fill-3)', overflow: 'hidden', borderRadius: 4 }}>
                   <img src={m.thumbnail_url || m.url} alt={m.name}
                     style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                     onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3' }} />
                 </div>
                 <Text style={{ fontSize: 11, display: 'block', textAlign: 'center', marginTop: 2,
                   overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</Text>
               </Card>
             </Col>
           ))}
         </Row>
        }
      </Modal>
    </div>
  )
}

export default EpisodeListPage
