/**
 * MaterialLibraryPage - 企业素材库 (M3)
 *
 * 对标目标网站 enterprise_material:
 * - 顶部: 类别 tab(图片/视频/音频) + 团队存储配额条
 * - 左侧: 目录树(角色/场景/物品 radio + 文件夹列表)
 * - 右侧: 素材网格(卡片视图) + 面包屑 + 上传/移动/同步/删除
 */
import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  Card, Spin, Typography, Grid, Progress, Button, Space, Upload, Message,
  Modal, Input, Radio, Tag, Empty, Popconfirm, Dropdown, Menu, Breadcrumb,
} from '@arco-design/web-react'
import {
  IconPlus, IconUpload, IconRefresh, IconStorage, IconDelete, IconEdit,
  IconDownload, IconShareExternal, IconFolder, IconImage, IconVideoCamera,
  IconSound, IconMoreVertical,
} from '@arco-design/web-react/icon'
import { materialLibraryService, projectService } from '@/api/services'
import { useTeamStore } from '@/stores'

const { Title, Text } = Typography
const { Row, Col } = Grid
const RadioGroup = Radio.Group

const CATEGORIES = [
  { key: 'image', label: '图片', icon: <IconImage /> },
  { key: 'video', label: '视频', icon: <IconVideoCamera /> },
  { key: 'audio', label: '音频', icon: <IconSound /> },
]

const CLASS_TYPES = [
  { key: 'character', label: '角色' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '物品' },
]

const formatSize = (bytes: number) => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

const formatDate = (s: string) => s ? s.replace('T', ' ').slice(0, 16) : '-'

const MaterialLibraryPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const orgId = currentOrg?.id
  const [loading, setLoading] = useState(false)
  const [category, setCategory] = useState('image')
  const [classType, setClassType] = useState('character')
  const [folders, setFolders] = useState<any[]>([])
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null) // null=全部
  const [materials, setMaterials] = useState<any[]>([])
  const [storage, setStorage] = useState<any>(null)
  const [search, setSearch] = useState('')
  const [projects, setProjects] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)

  // 文件夹新建弹窗
  const [folderModalVisible, setFolderModalVisible] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  // 素材预览（图片大图 / 视频播放 / 音频播放）
  const [previewImg, setPreviewImg] = useState<string | null>(null)
  const [previewVideo, setPreviewVideo] = useState<string | null>(null)
  const [previewAudio, setPreviewAudio] = useState<string | null>(null)
  // 同步弹窗
  const [syncModalVisible, setSyncModalVisible] = useState(false)
  const [syncTarget, setSyncTarget] = useState<any>(null)
  const [syncProject, setSyncProject] = useState<string>('')
  const [syncType, setSyncType] = useState('character')
  // 移动弹窗
  const [moveModalVisible, setMoveModalVisible] = useState(false)
  const [moveTarget, setMoveTarget] = useState<any>(null)
  const [moveFolder, setMoveFolder] = useState<string>('')

  const svc = React.useMemo(() => (orgId ? materialLibraryService(orgId) : null), [orgId])

  const loadFolders = useCallback(async () => {
    if (!svc) return
    try {
      const res: any = await svc.folders.list(category === 'image' ? classType : undefined)
      setFolders(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* ignore */ }
  }, [svc, category, classType])

  const loadMaterials = useCallback(async () => {
    if (!svc) return
    setLoading(true)
    try {
      const params: any = { category }
      if (category === 'image' && currentFolderId !== null) params.folder_id = currentFolderId
      if (category === 'image' && currentFolderId === null && classType) params.class_type = classType
      if (search) params.search = search
      const res: any = await svc.list(params)
      setMaterials(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [svc, category, classType, currentFolderId, search])

  const loadStorage = useCallback(async () => {
    if (!svc) return
    try {
      const res: any = await svc.storage()
      setStorage(res?.data ?? res)
    } catch { /* ignore */ }
  }, [svc])

  const loadProjects = useCallback(async () => {
    try {
      const res: any = await projectService.list()
      setProjects(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadFolders(); loadMaterials(); loadStorage()
  }, [loadFolders, loadMaterials, loadStorage])

  useEffect(() => { loadProjects() }, [loadProjects])

  // 切换类别时重置目录
  useEffect(() => {
    setCurrentFolderId(null)
    setSearch('')
  }, [category])

  const handleUpload = async (file: File) => {
    if (!svc) return false
    setUploading(true)
    try {
      await svc.upload(file, {
        category,
        class_type: category === 'image' ? classType : undefined,
        folder_id: currentFolderId || undefined,
        name: file.name.replace(/\.[^.]+$/, ''),
      })
      Message.success('上传成功')
      loadMaterials(); loadStorage(); loadFolders()
    } catch {
      Message.error('上传失败(可能超出存储配额)')
    } finally { setUploading(false) }
    return false // 阻止 arco 默认上传
  }

  const handleCreateFolder = async () => {
    if (!svc || !newFolderName.trim()) return
    try {
      await svc.folders.create({ name: newFolderName.trim(), class_type: classType })
      Message.success('文件夹已创建')
      setFolderModalVisible(false); setNewFolderName(''); loadFolders()
    } catch { Message.error('创建失败') }
  }

  const handleDeleteFolder = async (id: string) => {
    if (!svc) return
    try {
      await svc.folders.delete(id)
      Message.success('已删除')
      setCurrentFolderId(null); loadFolders(); loadMaterials()
    } catch { Message.error('删除失败' as any) }
  }

  const handleDeleteMaterial = async (id: string) => {
    if (!svc) return
    try {
      await svc.delete(id)
      Message.success('已删除')
      loadMaterials(); loadStorage(); loadFolders()
    } catch { Message.error('删除失败') }
  }

  const handleSync = async () => {
    if (!svc || !syncProject) { Message.warning('请选择项目'); return }
    try {
      await svc.sync(syncTarget.id, syncProject, syncType)
      Message.success('已同步至项目库')
      setSyncModalVisible(false); setSyncProject('')
    } catch (e: any) {
      Message.error(e?.message || '同步失败')
    }
  }

  const handleMove = async () => {
    if (!svc) return
    try {
      await svc.move(moveTarget.id, moveFolder || null)
      Message.success('已移动')
      setMoveModalVisible(false); loadMaterials(); loadFolders()
    } catch { Message.error('移动失败') }
  }

  // 素材更多操作菜单
  const materialMenu = (record: any) => (
    <Menu onClickMenuItem={(key) => {
      if (key === 'download') window.open(record.url, '_blank')
      else if (key === 'edit') { /* 简化: 直接重命名 */ }
      else if (key === 'move') {
        setMoveTarget(record)
        setMoveFolder(record.folder_id || '')
        setMoveModalVisible(true)
      }
      else if (key === 'sync') {
        setSyncTarget(record)
        // 按素材分类预选目标类型：图片→class_type（角色/场景/物品），音频/视频→同名资产
        setSyncType(record.category === 'audio' ? 'audio' : record.category === 'video' ? 'video' : (record.class_type || 'character'))
        setSyncModalVisible(true)
      }
      else if (key === 'delete') handleDeleteMaterial(record.id)
    }}>
      <Menu.Item key="download"><Space><IconDownload />下载</Space></Menu.Item>
      <Menu.Item key="move"><Space><IconFolder />移动</Space></Menu.Item>
      <Menu.Item key="sync"><Space><IconShareExternal />同步至项目库</Space></Menu.Item>
      <Menu.Item key="delete"><Space><IconDelete style={{ color: 'rgb(var(--danger-6))' }} />删除</Space></Menu.Item>
    </Menu>
  )

  const currentFolder = folders.find((f) => f.id === currentFolderId)

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 16 }}>企业素材库</Title>

      {/* 类别 tab + 存储配额 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row align="center" justify="space-between">
          <Col>
            <RadioGroup value={category} onChange={(v) => setCategory(v)} type="button">
              {CATEGORIES.map((c) => (
                <Radio key={c.key} value={c.key}>{c.icon} {c.label}</Radio>
              ))}
            </RadioGroup>
          </Col>
          <Col flex="auto" style={{ maxWidth: 400, marginLeft: 24 }}>
            {storage && (
              <Space>
                <Text type="secondary">团队存储</Text>
                <Progress
                  percent={storage.usage_percent}
                  size="mini" style={{ width: 160 }}
                  status={storage.usage_percent > 90 ? 'danger' : 'success'}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {storage.used_mb}MB / {storage.quota_mb}MB
                </Text>
                <Button size="mini" icon={<IconRefresh />} onClick={loadStorage} />
              </Space>
            )}
          </Col>
        </Row>
      </Card>

      <Row gutter={16}>
        {/* 左侧目录树 */}
        <Col flex="220px">
          <Card size="small" title="素材目录" style={{ minHeight: 400 }}>
            {category === 'image' && (
              <>
                <RadioGroup value={classType} onChange={(v) => { setClassType(v); setCurrentFolderId(null) }} direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
                  {CLASS_TYPES.map((ct) => (
                    <Radio key={ct.key} value={ct.key}>{ct.label}</Radio>
                  ))}
                </RadioGroup>
                <Button long size="small" icon={<IconPlus />} onClick={() => setFolderModalVisible(true)} style={{ marginBottom: 12 }}>
                  新建文件夹
                </Button>
              </>
            )}
            {/* 全部 */}
            <div
              onClick={() => setCurrentFolderId(null)}
              style={{
                padding: '6px 10px', cursor: 'pointer', borderRadius: 4, marginBottom: 4,
                background: currentFolderId === null ? 'var(--color-fill-2)' : 'transparent',
                fontWeight: currentFolderId === null ? 600 : 400,
              }}
            >
              <IconStorage /> 全部{category === 'image' ? CLASS_TYPES.find((c) => c.key === classType)?.label : ''}
            </div>
            {folders.map((f) => (
              <div
                key={f.id}
                onClick={() => setCurrentFolderId(f.id)}
                style={{
                  padding: '6px 10px', cursor: 'pointer', borderRadius: 4, marginBottom: 4,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: currentFolderId === f.id ? 'var(--color-fill-2)' : 'transparent',
                  fontWeight: currentFolderId === f.id ? 600 : 400,
                }}
              >
                <span><IconFolder /> {f.name} <Tag size="small">{f.item_count}</Tag></span>
                <Popconfirm title="删除文件夹?素材将移至未分类" onOk={() => handleDeleteFolder(f.id)}>
                  <IconDelete style={{ color: 'var(--color-text-3)', fontSize: 12 }} onClick={(e: any) => e.stopPropagation()} />
                </Popconfirm>
              </div>
            ))}
          </Card>
        </Col>

        {/* 右侧素材网格 */}
        <Col flex="auto">
          <Card size="small">
            {/* 面包屑 + 操作 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <Space>
                <Breadcrumb>
                  <Breadcrumb.Item>{CATEGORIES.find((c) => c.key === category)?.label}</Breadcrumb.Item>
                  {category === 'image' && (
                    <Breadcrumb.Item>{CLASS_TYPES.find((c) => c.key === classType)?.label}</Breadcrumb.Item>
                  )}
                  {currentFolder && <Breadcrumb.Item>{currentFolder.name}</Breadcrumb.Item>}
                </Breadcrumb>
              </Space>
              <Space>
                <Input.Search
                  placeholder="搜索素材名称" style={{ width: 200 }}
                  value={search} onChange={setSearch} onSearch={loadMaterials} allowClear
                />
                <Upload beforeUpload={handleUpload} showUploadList={false} disabled={uploading}>
                  <Button type="primary" icon={<IconUpload />} loading={uploading}>本地上传</Button>
                </Upload>
                <Button icon={<IconRefresh />} onClick={() => { loadMaterials(); loadFolders() }} />
              </Space>
            </div>

            {/* 素材网格 */}
            {loading ? <Spin dot style={{ display: 'block', margin: '40px auto' }} /> :
             materials.length === 0 ? <Empty description="暂无素材" /> :
             (
               <Row gutter={[12, 12]}>
                 {materials.map((m) => (
                   <Col key={m.id} span={6}>
                     <Card
                       size="small"
                       hoverable
                       cover={
                         m.category === 'image' ? (
                           <div style={{ height: 140, background: 'var(--color-fill-3)', overflow: 'hidden', cursor: 'pointer' }}
                             onClick={() => setPreviewImg(m.url)}>
                             <img src={m.url} alt={m.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                           </div>
                         ) : m.category === 'video' ? (
                           <div style={{ position: 'relative', height: 140, background: '#000', cursor: 'pointer', overflow: 'hidden' }}
                             onClick={() => setPreviewVideo(m.url)}>
                             <video src={m.url} muted preload="metadata"
                               style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                             {/* 中央播放按钮提示可点击播放 */}
                             <div style={{
                               position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                               pointerEvents: 'none',
                             }}>
                               <div style={{
                                 width: 40, height: 40, borderRadius: '50%', background: 'rgba(0,0,0,0.55)',
                                 display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16,
                               }}>▶</div>
                             </div>
                           </div>
                         ) : m.category === 'audio' ? (
                           <div style={{ height: 140, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'var(--color-fill-3)', cursor: 'pointer' }}
                             onClick={() => setPreviewAudio(m.url)}>
                             <IconSound style={{ fontSize: 36, color: 'var(--color-text-3)' }} />
                             <span style={{ fontSize: 11, color: 'var(--color-text-2)' }}>▶ 点击播放</span>
                           </div>
                         ) : (
                           <div style={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-fill-3)' }}>
                             <IconSound style={{ fontSize: 40, color: 'var(--color-text-3)' }} />
                           </div>
                         )
                       }
                       actions={[
                         <Dropdown key="more" droplist={materialMenu(m)} position="br" trigger="click">
                           <IconMoreVertical />
                         </Dropdown>,
                       ]}
                     >
                       <Card.Meta
                         title={<Text ellipsis style={{ maxWidth: 140 }}>{m.name}</Text>}
                         description={
                           <Text type="secondary" style={{ fontSize: 12 }}>
                             {formatSize(m.size_bytes)} · {formatDate(m.created_at)}
                           </Text>
                         }
                       />
                     </Card>
                   </Col>
                 ))}
               </Row>
             )
            }
          </Card>
        </Col>
      </Row>

      {/* 新建文件夹弹窗 */}
      <Modal
        title="新建文件夹" visible={folderModalVisible}
        onCancel={() => setFolderModalVisible(false)} onOk={handleCreateFolder}
        okText="创建" cancelText="取消"
      >
        <Input placeholder="文件夹名称" value={newFolderName} onChange={setNewFolderName} />
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
            style={{ width: '100%', maxHeight: '80vh', objectFit: 'contain', display: 'block' }} />
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

      {/* 同步至项目库弹窗 */}
      <Modal
        title="同步至项目库" visible={syncModalVisible}
        onCancel={() => setSyncModalVisible(false)} onOk={handleSync}
        okText="同步" cancelText="取消"
      >
        <p style={{ color: 'var(--color-text-3)' }}>将素材 <b>{syncTarget?.name}</b> 复制到项目库作为项目资源</p>
        <div style={{ marginTop: 12 }}>
          <Text style={{ display: 'block', marginBottom: 6 }}>选择项目</Text>
          <select style={{ width: '100%', padding: 8 }} value={syncProject} onChange={(e) => setSyncProject(e.target.value)}>
            <option value="">请选择项目</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={{ marginTop: 12 }}>
          <Text style={{ display: 'block', marginBottom: 6 }}>目标类型</Text>
          <RadioGroup value={syncType} onChange={setSyncType}>
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
          </RadioGroup>
        </div>
      </Modal>

      {/* 移动弹窗 */}
      <Modal
        title="移动素材" visible={moveModalVisible}
        onCancel={() => setMoveModalVisible(false)} onOk={handleMove}
        okText="移动" cancelText="取消"
      >
        <p style={{ color: 'var(--color-text-3)' }}>将 <b>{moveTarget?.name}</b> 移动到：</p>
        <select style={{ width: '100%', padding: 8 }} value={moveFolder} onChange={(e) => setMoveFolder(e.target.value)}>
          <option value="">未分类</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </Modal>
    </div>
  )
}

export default MaterialLibraryPage
