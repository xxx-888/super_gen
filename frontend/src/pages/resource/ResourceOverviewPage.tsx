/**
 * ResourceOverviewPage - 企业素材库（直接管理，不跳转）
 *
 * 在 /resources 页面直接管理当前团队的素材：
 * - 按类别浏览（角色/场景/物品 的图片 + 视频 + 音频）
 * - 搜索、上传、删除
 * - 每个素材可同步到指定项目作为项目资源
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Card, Tabs, Empty, Spin, Typography, Grid, Radio, Input, Button, Message,
  Tag, Dropdown, Menu, Modal, Select, Popconfirm, Upload, Progress, Space, Pagination,
} from '@arco-design/web-react'
import {
  IconUserGroup, IconHome, IconCommon, IconApps, IconImage, IconVideoCamera,
  IconSound, IconUpload, IconDelete, IconRefresh, IconMoreVertical, IconExport,
  IconSearch, IconEdit, IconLink,
} from '@arco-design/web-react/icon'
import { materialLibraryService, projectService } from '@/api/services'
import { useTeamStore } from '@/stores'

const { Title, Text } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

// 图片的 class_type 分类（角色/场景/物品）
const IMAGE_CLASS_TYPES = [
  { key: '', label: '全部图片' },
  { key: 'character', label: '角色' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '物品' },
]

const CATEGORIES = [
  { key: 'image', label: '图片', icon: <IconImage /> },
  { key: 'video', label: '视频', icon: <IconVideoCamera /> },
  { key: 'audio', label: '音频', icon: <IconSound /> },
]

const CLASS_TYPE_LABEL: Record<string, string> = {
  character: '角色', scene: '场景', prop: '物品',
  scene_bg: '场景', audio: '音效', video: '视频',
}
const CLASS_TYPE_COLOR: Record<string, string> = {
  character: '#722ED1', scene: '#00B42A', prop: '#FF7D00',
}

const ResourceOverviewPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const orgId = currentOrg?.id
  const svc = useMemo(() => (orgId ? materialLibraryService(orgId) : null), [orgId])

  const [category, setCategory] = useState('image')
  const [classType, setClassType] = useState('')
  const [materials, setMaterials] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [projects, setProjects] = useState<any[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const PAGE_SIZE = 24

  // 同步弹窗
  const [syncTarget, setSyncTarget] = useState<any>(null)
  const [syncProject, setSyncProject] = useState('')
  const [syncType, setSyncType] = useState('character')
  const [syncing, setSyncing] = useState(false)

  // 上传
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  // 上传弹窗（选类型 + 选文件）
  const [uploadVisible, setUploadVisible] = useState(false)
  const [uploadClassType, setUploadClassType] = useState('character')
  const [uploadName, setUploadName] = useState('')
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  const loadProjects = useCallback(async () => {
    try {
      const res: any = await projectService.list()
      setProjects(Array.isArray(res) ? res : (res?.items ?? []))
    } catch { /* */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMaterials = useCallback(async () => {
    if (!svc) return
    setLoading(true)
    try {
      const params: any = { category, page, page_size: PAGE_SIZE }
      if (category === 'image' && classType) params.class_type = classType
      if (search.trim()) params.search = search.trim()
      // 并行：拉当前页数据 + 查总数
      const [listRes, countRes]: any = await Promise.all([
        svc.list(params),
        svc.count({ category, class_type: params.class_type, search: params.search }),
      ])
      const list = Array.isArray(listRes) ? listRes : (listRes?.data?.items ?? listRes?.data ?? [])
      setMaterials(list)
      const t = countRes?.data?.total ?? countRes?.total ?? 0
      setTotal(t)
    } catch { /* */ } finally { setLoading(false) }
  }, [svc, category, classType, search, page])

  useEffect(() => { loadMaterials() }, [loadMaterials])
  useEffect(() => { loadProjects() }, [loadProjects])

  // 搜索防抖
  useEffect(() => {
    setPage(1)
    const t = setTimeout(() => loadMaterials(), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // 选文件后打开弹窗（图片类需选类型）
  const onFileSelected = (file: File) => {
    setPendingFile(file)
    setUploadClassType(classType || 'character')
    setUploadName(file.name.replace(/\.[^.]+$/, '')) // 默认用文件名（去扩展名）
    setUploadVisible(true)
    return false
  }

  // 确认上传
  const handleUpload = async () => {
    if (!svc || !orgId || !pendingFile) return
    setUploading(true)
    setUploadProgress(0)
    try {
      await svc.upload(pendingFile, {
        category,
        class_type: category === 'image' ? uploadClassType : undefined,
        name: uploadName.trim() || pendingFile.name.replace(/\.[^.]+$/, ''),
      }, (p) => setUploadProgress(p))
      Message.success('上传成功')
      setUploadVisible(false)
      setPendingFile(null)
      loadMaterials()
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || '上传失败')
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  const handleDelete = async (id: string) => {
    if (!svc) return
    try {
      await svc.delete(id)
      Message.success('已删除')
      loadMaterials()
    } catch { Message.error('删除失败') }
  }

  // ---- 批量选择 / 批量删除 / 复制链接 ----
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }
  const handleBatchDelete = async () => {
    if (!svc || !selectedIds.size) return
    let ok = 0
    for (const id of selectedIds) {
      try { await svc.delete(id); ok += 1 } catch { /* 单条失败继续 */ }
    }
    Message.success(`已删除 ${ok}/${selectedIds.size} 个素材`)
    setSelectedIds(new Set())
    loadMaterials()
  }
  // 复制素材链接（HTTP 非安全上下文 execCommand 兜底；相对路径补全为绝对地址）
  const copyLink = (url?: string) => {
    if (!url) return
    const absUrl = /^https?:\/\//.test(url)
      ? url
      : `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(absUrl).then(
        () => Message.success('链接已复制'),
        () => fallbackCopy(absUrl),
      )
    } else {
      fallbackCopy(absUrl)
    }
  }
  const fallbackCopy = (text: string) => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      document.body.appendChild(ta)
      ta.focus(); ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) Message.success('链接已复制')
      else Message.error('复制失败，请手动复制：' + text)
    } catch {
      Message.error('复制失败')
    }
  }

  // 编辑素材（重命名/改类型）
  const [editTarget, setEditTarget] = useState<any>(null)
  // 图片预览大图
  const [previewImg, setPreviewImg] = useState<string | null>(null)
  const [previewVideo, setPreviewVideo] = useState<string | null>(null)
  const [previewAudio, setPreviewAudio] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editClassType, setEditClassType] = useState('character')
  const [editSaving, setEditSaving] = useState(false)

  const openEdit = (m: any) => {
    setEditTarget(m)
    setEditName(m.name || '')
    setEditClassType(m.class_type || 'character')
  }

  const handleSaveEdit = async () => {
    if (!svc || !editTarget) return
    setEditSaving(true)
    try {
      const data: any = { name: editName.trim() || editTarget.name }
      if (editTarget.category === 'image') data.class_type = editClassType
      await svc.update(editTarget.id, data)
      Message.success('已更新')
      setEditTarget(null)
      loadMaterials()
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || '更新失败')
    } finally { setEditSaving(false) }
  }

  const handleSync = async () => {
    if (!svc || !syncTarget || !syncProject) { Message.warning('请选择项目'); return }
    setSyncing(true)
    try {
      await svc.sync(syncTarget.id, syncProject, syncType)
      Message.success(`已同步到项目资源（${CLASS_TYPE_LABEL[syncType] || syncType}）`)
      setSyncTarget(null)
    } catch (e: any) {
      const msg = e?.response?.data?.detail || ''
      if (msg.includes('already') || msg.includes('已同步')) {
        Message.info('该素材已同步过')
        setSyncTarget(null)
      } else {
        Message.error(msg || '同步失败')
      }
    } finally { setSyncing(false) }
  }

  const openSyncModal = (m: any) => {
    setSyncTarget(m)
    setSyncProject('')
    // 按素材分类预选目标类型：图片→class_type（角色/场景/物品），音频/视频→同名资产
    if (m.category === 'audio') { setSyncType('audio'); return }
    if (m.category === 'video') { setSyncType('video'); return }
    const ct = m.class_type || 'character'
    setSyncType(ct === 'scene' ? 'scene_bg' : ct)
  }

  const cardMenu = (m: any) => (
    <Menu onClickMenuItem={(key) => {
      if (key === 'edit') openEdit(m)
      else if (key === 'sync') openSyncModal(m)
      else if (key === 'delete') handleDelete(m.id)
    }}>
      <Menu.Item key="edit"><IconEdit /> 编辑</Menu.Item>
      <Menu.Item key="sync"><IconExport /> 同步到项目</Menu.Item>
      <Menu.Item key="delete"><IconDelete style={{ color: 'rgb(var(--danger-6))' }} /> 删除</Menu.Item>
    </Menu>
  )

  return (
    <div>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <Title heading={5} style={{ margin: 0 }}>企业素材库</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {currentOrg?.name || '当前团队'} 的共享素材，可同步到任意项目使用
          </Text>
        </div>
        <Space>
          <Upload
            beforeUpload={onFileSelected}
            showUploadList={false}
            accept={category === 'image' ? 'image/*' : category === 'video' ? 'video/*' : 'audio/*'}
          >
            <Button type="primary" icon={<IconUpload />} loading={uploading}>
              上传{CATEGORIES.find(c => c.key === category)?.label}
            </Button>
          </Upload>
          <Button icon={<IconRefresh />} onClick={loadMaterials}>刷新</Button>
        </Space>
      </div>

      {/* 上传进度 */}
      {uploading && uploadProgress > 0 && (
        <Progress percent={uploadProgress} style={{ marginBottom: 16 }} />
      )}

      {/* 类别切换 */}
      <Radio.Group value={category} onChange={(v) => { setCategory(v); setClassType(''); setPage(1) }} type="button" style={{ marginBottom: 12 }}>
        {CATEGORIES.map(c => (
          <Radio key={c.key} value={c.key}>{c.icon} {c.label}</Radio>
        ))}
      </Radio.Group>

      {/* 图片的 class_type 子分类 + 搜索 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        {category === 'image' ? (
          <Radio.Group value={classType} onChange={(v) => { setClassType(v); setPage(1) }} type="button" size="small">
            {IMAGE_CLASS_TYPES.map(c => (
              <Radio key={c.key} value={c.key}>{c.label}</Radio>
            ))}
          </Radio.Group>
        ) : <div />}
        <Space size={8}>
          {selectedIds.size > 0 && (
            <Popconfirm title={`确认删除选中的 ${selectedIds.size} 个素材？不可恢复。`} onOk={handleBatchDelete}>
              <Button status="danger" icon={<IconDelete />}>批量删除({selectedIds.size})</Button>
            </Popconfirm>
          )}
          {selectedIds.size > 0 && (
            <Button onClick={() => setSelectedIds(new Set())}>取消选择</Button>
          )}
          <Input
            prefix={<IconSearch />}
            placeholder="搜索素材名称"
            value={search}
            onChange={setSearch}
            style={{ width: 240 }}
            allowClear
          />
        </Space>
      </div>

      {/* 素材列表 */}
      {!orgId ? (
        <Card><Empty description="请先在顶部切换到某个团队" style={{ padding: 60 }} /></Card>
      ) : loading ? (
        <Spin dot style={{ display: 'block', margin: '60px auto' }} />
      ) : materials.length === 0 ? (
        <Card>
          <Empty
            description={
              <span>
                暂无{CATEGORIES.find(c => c.key === category)?.label}素材
                {category === 'image' && classType ? `（${CLASS_TYPE_LABEL[classType]}）` : ''}
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  点击右上角「上传」添加，或在项目资源管理里点 📤 同步到素材库
                </Text>
              </span>
            }
            style={{ padding: 60 }}
          />
        </Card>
      ) : (
        <Row gutter={[12, 12]}>
          {materials.map((m) => {
            const ct = m.class_type
            const ctLabel = ct ? CLASS_TYPE_LABEL[ct] : null
            const ctColor = ct ? CLASS_TYPE_COLOR[ct] : '#86909C'
            return (
              <Col key={m.id} xs={12} sm={8} md={6} lg={4}>
                <Card
                  size="small"
                  hoverable
                  style={selectedIds.has(m.id) ? { borderColor: 'rgb(var(--arcoblue-6))', borderWidth: 2 } : undefined}
                  bodyStyle={{ padding: 8 }}
                  cover={
                    <div
                      style={{
                        position: 'relative', aspectRatio: '3/4',
                        background: 'var(--color-fill-3)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden',
                        cursor: (m.category === 'image' && (m.thumbnail_url || m.url)) || (m.category === 'video' && m.url) ? 'pointer' : 'default',
                      }}
                      onClick={() => {
                        const imgUrl = m.thumbnail_url || m.url
                        if (m.category === 'image' && imgUrl) setPreviewImg(imgUrl)
                        else if (m.category === 'video' && m.url) setPreviewVideo(m.url)
                      }}
                    >
                      {m.category === 'image' && (m.thumbnail_url || m.url) ? (
                        <img src={m.thumbnail_url || m.url} alt={m.name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3' }}
                        />
                      ) : m.category === 'video' ? (
                        <video src={m.url} muted preload="metadata"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}
                          onError={(e) => { const el = e.target as HTMLVideoElement; el.style.display = 'none' }}
                        />
                      ) : m.category === 'audio' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
                          onClick={() => setPreviewAudio(m.url)}>
                          <IconSound style={{ fontSize: 30, color: 'var(--color-text-3)' }} />
                          <span style={{ fontSize: 11, color: 'var(--color-text-2)' }}>▶ 点击播放</span>
                        </div>
                      ) : (
                        <IconSound style={{ fontSize: 32, color: 'var(--color-text-3)' }} />
                      )}
                      {/* 批量选择复选框（点击不触发预览） */}
                      <div
                        style={{ position: 'absolute', top: 4, right: 4, zIndex: 2 }}
                        onClick={(e) => { e.stopPropagation(); toggleSelect(m.id) }}
                      >
                        <div style={{
                          width: 20, height: 20, borderRadius: 6, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: selectedIds.has(m.id) ? 'rgb(var(--arcoblue-6))' : 'rgba(255,255,255,.85)',
                          border: selectedIds.has(m.id) ? 'none' : '1px solid var(--color-border-2)',
                          color: '#fff', fontSize: 12, fontWeight: 700,
                        }}>{selectedIds.has(m.id) ? '✓' : ''}</div>
                      </div>
                      {ctLabel && (
                        <Tag size="small" style={{
                          position: 'absolute', top: 4, left: 4,
                          background: ctColor, color: '#fff', borderRadius: 8,
                        }}>{ctLabel}</Tag>
                      )}
                    </div>
                  }
                >
                  <Text style={{ fontWeight: 600, fontSize: 13, display: 'block',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name}
                  </Text>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                    <Button size="mini" type="text" icon={<IconEdit />}
                      onClick={() => openEdit(m)} title="编辑" />
                    <Button size="mini" type="text" icon={<IconExport />}
                      onClick={() => openSyncModal(m)} title="同步到项目" />
                    <Button size="mini" type="text" icon={<IconLink />}
                      onClick={() => copyLink(m.url)} title="复制链接" />
                    <Popconfirm title="确认删除？" onOk={() => handleDelete(m.id)}>
                      <Button size="mini" type="text" status="danger" icon={<IconDelete />} title="删除" />
                    </Popconfirm>
                  </div>
                </Card>
              </Col>
            )
          })}
        </Row>
      )}

      {/* 分页 */}
      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
          <Pagination
            total={total}
            current={page}
            pageSize={PAGE_SIZE}
            onChange={(p: number) => setPage(p)}
            showTotal
          />
        </div>
      )}

      {/* 上传弹窗（图片选类型） */}
      <Modal
        title="上传素材"
        visible={uploadVisible}
        onCancel={() => { setUploadVisible(false); setPendingFile(null) }}
        onOk={handleUpload}
        confirmLoading={uploading}
        okText={uploading ? '上传中...' : '确认上传'}
        cancelText="取消"
      >
        {pendingFile && (
          <div style={{ marginBottom: 16 }}>
            <Text style={{ display: 'block', marginBottom: 8 }}>已选文件：</Text>
            <Tag color="arcoblue">{pendingFile.name}</Tag>
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              ({(pendingFile.size / 1024).toFixed(0)} KB)
            </Text>
          </div>
        )}
        {/* 素材名称 */}
        <div style={{ marginBottom: 16 }}>
          <Text style={{ display: 'block', marginBottom: 8 }}>素材名称</Text>
          <Input
            value={uploadName}
            onChange={setUploadName}
            placeholder="给素材起个名字（如：沈如姬、咖啡厅）"
          />
        </div>
        {category === 'image' ? (
          <div>
            <Text style={{ display: 'block', marginBottom: 8 }}>素材类型（决定同步到项目时归类）</Text>
            <Radio.Group value={uploadClassType} onChange={setUploadClassType} type="button">
              <Radio value="character">角色</Radio>
              <Radio value="scene">场景</Radio>
              <Radio value="prop">物品</Radio>
            </Radio.Group>
          </div>
        ) : (
          <Text type="secondary">将上传为{CATEGORIES.find(c => c.key === category)?.label}素材</Text>
        )}
        {uploading && uploadProgress > 0 && (
          <Progress percent={uploadProgress} style={{ marginTop: 16 }} />
        )}
      </Modal>

      {/* 图片大图预览 */}
      <Modal
        visible={!!previewImg}
        onCancel={() => setPreviewImg(null)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw' }}
      >
        {previewImg && (
          <img src={previewImg} alt="预览"
            style={{ width: '100%', maxHeight: '80vh', objectFit: 'contain', display: 'block' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}
      </Modal>

      {/* 视频播放预览 */}
      <Modal
        visible={!!previewVideo}
        onCancel={() => setPreviewVideo(null)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw' }}
      >
        {previewVideo && (
          <video
            src={previewVideo}
            controls
            autoPlay
            style={{ width: '100%', maxHeight: '80vh', background: '#000', display: 'block' }}
            onError={() => Message.error('视频加载失败（文件可能已被删除，请重新上传）')}
          />
        )}
      </Modal>

      {/* 音频播放预览 */}
      <Modal
        title="音频播放"
        visible={!!previewAudio}
        onCancel={() => setPreviewAudio(null)}
        footer={null}
        style={{ width: 420 }}
      >
        {previewAudio && (
          <audio
            src={previewAudio}
            controls
            autoPlay
            style={{ width: '100%', display: 'block' }}
            onError={() => Message.error('音频加载失败（文件可能已被删除，请重新上传）')}
          />
        )}
      </Modal>

      {/* 编辑素材弹窗（重命名/改类型） */}
      <Modal
        title="编辑素材"
        visible={!!editTarget}
        onCancel={() => setEditTarget(null)}
        onOk={handleSaveEdit}
        confirmLoading={editSaving}
        okText="保存" cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>
          <Text style={{ display: 'block', marginBottom: 8 }}>素材名称</Text>
          <Input value={editName} onChange={setEditName} placeholder="素材名称" />
        </div>
        {editTarget?.category === 'image' && (
          <div>
            <Text style={{ display: 'block', marginBottom: 8 }}>素材类型</Text>
            <Radio.Group value={editClassType} onChange={setEditClassType} type="button">
              <Radio value="character">角色</Radio>
              <Radio value="scene">场景</Radio>
              <Radio value="prop">物品</Radio>
            </Radio.Group>
          </div>
        )}
      </Modal>

      {/* 同步到项目弹窗 */}
      <Modal
        title="同步到项目资源"
        visible={!!syncTarget}
        onCancel={() => setSyncTarget(null)}
        onOk={handleSync}
        confirmLoading={syncing}
        okText="同步" cancelText="取消"
      >
        <Text style={{ display: 'block', marginBottom: 12 }}>
          将素材 <b>{syncTarget?.name}</b> 复制到项目作为项目资源
        </Text>
        <div style={{ marginBottom: 12 }}>
          <Text style={{ display: 'block', marginBottom: 6 }}>选择项目</Text>
          <Select value={syncProject} onChange={setSyncProject} style={{ width: '100%' }} placeholder="选择目标项目">
            {projects.map(p => <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>)}
          </Select>
        </div>
        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>目标类型</Text>
          <Radio.Group value={syncType} onChange={setSyncType}>
            {syncTarget?.category === 'audio' ? (
              <Radio value="audio">音效</Radio>
            ) : syncTarget?.category === 'video' ? (
              <Radio value="video">视频</Radio>
            ) : (
              <>
                <Radio value="character">角色</Radio>
                <Radio value="scene_bg">场景</Radio>
                <Radio value="prop">物品</Radio>
              </>
            )}
          </Radio.Group>
        </div>
      </Modal>
    </div>
  )
}

export default ResourceOverviewPage
