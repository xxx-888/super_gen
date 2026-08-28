/**
 * UploadMaterialNode - 上传素材节点
 *
 * 上传本地图片/视频/音频，作为生成节点的参考输入。
 * - 选中文件后弹窗一次性确认：图片选资源类型（角色/场景/道具）+ 素材名称，
 *   名称实时查重（同名资源冲突直接拦截），确认后自动上传并入库为项目资源
 *   （提示词 @引用 立即可用）——节点编辑器内不放命名/入库操作
 * - 三种类型的素材独立保存（files 映射）：切换类型再切回，已传素材不丢失
 * - 节点内缩略图预览 + 点击放大全屏播放
 * - 多值连线：多个本节点可同时连到生成节点的参考输入口，运行时自动 @引用
 */
import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { IconUpload, IconImage, IconVideoCamera, IconSound, IconRefresh, IconPlayCircle, IconDelete } from '@arco-design/web-react/icon'
import { Button, Tag, Radio, Message, Spin, Modal, Input, Select } from '@arco-design/web-react'
import { BaseNodeShell } from '../BaseNodeShell'
import { NODE_REGISTRY } from '../types'
import { useCanvasRuntime } from '../CanvasContext'
import { resourceService } from '@/api/services'
import {
  registerMaterial, uploadAndRegisterMaterial,
  type MediaType, type ImageClass,
} from '../materialUpload'

const MEDIA_OPTIONS: { value: MediaType; label: string; accept: string; icon: React.ReactNode }[] = [
  { value: 'image', label: '图片', accept: 'image/*', icon: <IconImage /> },
  { value: 'video', label: '视频', accept: 'video/*', icon: <IconVideoCamera /> },
  { value: 'audio', label: '音频', accept: 'audio/*', icon: <IconSound /> },
]

const IMAGE_CLASS_OPTIONS = [
  { value: 'character', label: '角色' },
  { value: 'scene_bg', label: '场景' },
  { value: 'prop', label: '道具' },
]

/** 单个素材条目（按类型存进 data.files） */
interface MaterialFile {
  url: string
  name: string
  imageClass?: ImageClass
  resourceId?: string
}

export const UploadMaterialNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const meta = NODE_REGISTRY.uploadMaterial
  const d = data as any
  const { projectId, updateNodeData, deleteNode } = useCanvasRuntime()
  const [previewOpen, setPreviewOpen] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // 上传确认弹窗（选文件后弹出：类型 + 名称 + 查重）
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [pendingFile, setPendingFile] = React.useState<File | null>(null)
  const [confirmName, setConfirmName] = React.useState('')
  const [confirmClass, setConfirmClass] = React.useState<ImageClass>('character')
  const [nameChecking, setNameChecking] = React.useState(false)
  const [nameExists, setNameExists] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  const mediaType = (d.mediaType || 'image') as MediaType
  const opt = MEDIA_OPTIONS.find(o => o.value === mediaType)!
  // 兼容旧版平铺字段（url/fileName）
  const current: MaterialFile | undefined = d.files?.[mediaType]
    || (d.url ? { url: d.url, name: d.fileName || '' } : undefined)

  /** 已入库资源在资源管理里被删除 → 失效，可一键重新入库 */
  const [stale, setStale] = React.useState(false)
  React.useEffect(() => {
    if (!projectId || !current?.resourceId) { setStale(false); return }
    let cancelled = false
    ;(async () => {
      try {
        let list: any
        if (mediaType === 'video') list = await resourceService.video.list(projectId)
        else if (mediaType === 'audio') list = await resourceService.audio.list(projectId)
        else {
          const cls = current.imageClass || 'character'
          list = cls === 'character' ? await resourceService.characters.list(projectId)
            : cls === 'scene_bg' ? await resourceService.sceneBg.list(projectId)
            : await resourceService.props.list(projectId)
        }
        const arr: any[] = Array.isArray(list) ? list : (list?.data ?? [])
        if (!cancelled) setStale(!arr.some((r) => r.id === current.resourceId))
      } catch {
        if (!cancelled) setStale(false)  // 校验失败按已入库显示
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, current?.resourceId, current?.imageClass, mediaType])

  /** 一键重新入库：用原名称/类型重建资源（下游 @引用 保持有效；名称被占用时报错提示） */
  const handleReRegister = async () => {
    if (!projectId || !current?.url) return
    setSubmitting(true)
    try {
      const resourceId = await registerMaterial(projectId, mediaType, {
        name: current.name, url: current.url, imageClass: current.imageClass,
      })
      setFile({ ...current, resourceId })
      setStale(false)
      Message.success(`已重新入库「${current.name}」，@引用恢复有效`)
    } catch (e: any) {
      Message.error(e?.response?.data?.detail?.includes?.('exists')
        ? '原名称已被其他资源占用，请重新上传并用新名称入库'
        : (e?.response?.data?.detail || e?.message || '重新入库失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const setFile = (file: MaterialFile | null) => {
    const files = { ...(d.files || {}) }
    if (file) files[mediaType] = file
    else delete files[mediaType]
    updateNodeData(id, { files })
  }

  // 名称查重：按当前素材类型拉对应资源列表，同名即冲突
  React.useEffect(() => {
    if (!confirmOpen || !pendingFile || !confirmName.trim() || !projectId) {
      setNameExists(false)
      return
    }
    let cancelled = false
    setNameChecking(true)
    const timer = setTimeout(async () => {
      try {
        const name = confirmName.trim()
        let list: any
        if (mediaType === 'video') list = await resourceService.video.list(projectId)
        else if (mediaType === 'audio') list = await resourceService.audio.list(projectId)
        else if (confirmClass === 'character') list = await resourceService.characters.list(projectId)
        else if (confirmClass === 'scene_bg') list = await resourceService.sceneBg.list(projectId)
        else list = await resourceService.props.list(projectId)
        const arr: any[] = Array.isArray(list) ? list : (list?.data ?? [])
        if (!cancelled) setNameExists(arr.some((r) => (r.name || '').trim() === name))
      } catch {
        if (!cancelled) setNameExists(false)
      } finally {
        if (!cancelled) setNameChecking(false)
      }
    }, 400)
    return () => { cancelled = true; clearTimeout(timer); setNameChecking(false) }
  }, [confirmOpen, confirmName, confirmClass, mediaType, pendingFile, projectId])

  const openConfirm = (file: File) => {
    setPendingFile(file)
    setConfirmName(file.name.replace(/\.[^.]+$/, ''))
    // 图片默认类型跟随上次选择
    setConfirmClass((d.files?.image?.imageClass as ImageClass) || 'character')
    setNameExists(false)
    setConfirmOpen(true)
  }

  /** 确认：上传文件 + 入库项目资源（@引用立即可用，流程见 materialUpload） */
  const handleConfirm = async () => {
    if (!pendingFile || !projectId) return
    const name = confirmName.trim()
    if (!name) { Message.warning('请输入素材名称'); return }
    if (nameExists) { Message.warning('名称已存在，请换一个'); return }
    setSubmitting(true)
    try {
      const imageClass = mediaType === 'image' ? confirmClass : undefined
      const { url, resourceId } = await uploadAndRegisterMaterial(projectId, mediaType, pendingFile, {
        name, imageClass,
      })
      setFile({ url, name, imageClass, resourceId })
      Message.success(`素材「${name}」已上传并入库，提示词 @${name} 可直接引用`)
      setConfirmOpen(false)
      setPendingFile(null)
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || e?.message || '上传失败')
    } finally {
      setSubmitting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <BaseNodeShell
      label={meta.label}
      color={meta.color}
      icon={<IconUpload style={{ fontSize: 14 }} />}
      selected={selected}
      outputs={meta.outputs.filter(h => h.id === mediaType)}
      status={current ? 'completed' : d._status}
      onDelete={() => deleteNode(id)}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* 素材类型切换（各类型素材独立保存，切换不丢失） */}
        <Radio.Group
          size="mini" type="button"
          value={mediaType}
          onChange={(v: string) => updateNodeData(id, { mediaType: v })}
          style={{ width: '100%' }}
        >
          {MEDIA_OPTIONS.map(o => <Radio key={o.value} value={o.value}>{o.label}</Radio>)}
        </Radio.Group>

        <input
          ref={fileInputRef}
          type="file"
          accept={opt.accept}
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) openConfirm(f)
          }}
        />

        {current ? (
          <>
            {/* 节点内预览（点击放大全屏播放） */}
            {mediaType !== 'audio' ? (
              <div
                style={{ position: 'relative', borderRadius: 4, overflow: 'hidden', aspectRatio: '16/9', background: 'var(--color-fill-2)', cursor: 'pointer' }}
                onClick={() => setPreviewOpen(true)}
                title="点击放大预览"
              >
                {mediaType === 'image' ? (
                  <img src={current.url} alt={current.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3' }} />
                ) : (
                  <video src={current.url} muted preload="metadata"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
                {mediaType === 'video' && (
                  <IconPlayCircle style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: 26, color: 'rgba(255,255,255,0.85)', pointerEvents: 'none' }} />
                )}
              </div>
            ) : (
              <audio src={current.url} controls preload="metadata" style={{ width: '100%', height: 36, display: 'block' }} />
            )}
            {/* 已入库信息（名称/类型在上传弹窗确认，节点内只读展示）；资源被删时可重新入库 */}
            {current.resourceId && stale ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Tag size="small" color="orange" style={{ flexShrink: 0 }}>已删除</Tag>
                <Button size="mini" type="text" long loading={submitting} onClick={handleReRegister}
                  title="资源已在资源管理中删除，一键重新入库恢复 @引用">
                  重新入库
                </Button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Tag size="small" color="green" style={{ flexShrink: 0 }}>已入库</Tag>
                <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={`@${current.name}`}>@{current.name}</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 4 }}>
              <Button size="mini" type="text" long icon={<IconRefresh />} onClick={() => fileInputRef.current?.click()}>
                重新上传
              </Button>
              {mediaType !== 'audio' && (
                <Button size="mini" type="text" long icon={<IconPlayCircle />} onClick={() => setPreviewOpen(true)}>
                  预览
                </Button>
              )}
              <Button size="mini" type="text" status="danger" icon={<IconDelete />} title="移除当前素材"
                onClick={() => setFile(null)} />
            </div>
          </>
        ) : (
          <Button
            size="small" type="dashed" long icon={opt.icon}
            onClick={() => fileInputRef.current?.click()}
          >
            上传{opt.label}
          </Button>
        )}
      </div>

      {/* 上传确认弹窗：类型 + 名称 + 唯一性检查，一次确认到位 */}
      <Modal
        title={`上传${opt.label}素材`}
        visible={confirmOpen}
        onCancel={() => { setConfirmOpen(false); setPendingFile(null) }}
        onOk={handleConfirm}
        confirmLoading={submitting}
        okText="上传并入库"
        cancelText="取消"
        okButtonProps={{ disabled: !confirmName.trim() || nameExists || nameChecking }}
        style={{ width: 440, maxWidth: '92vw' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
            文件：{pendingFile?.name}（{(pendingFile ? pendingFile.size / 1024 / 1024 : 0).toFixed(1)}MB）
          </div>
          {mediaType === 'image' && (
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>资源类型（入库后按此分类）</div>
              <Select value={confirmClass} onChange={(v: any) => setConfirmClass(v)} style={{ width: '100%' }}>
                {IMAGE_CLASS_OPTIONS.map(o => <Select.Option key={o.value} value={o.value}>{o.label}</Select.Option>)}
              </Select>
            </div>
          )}
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>素材名称（提示词 @引用 使用，需唯一）</div>
            <Input
              value={confirmName}
              onChange={setConfirmName}
              placeholder="如：管家、雨夜街道、打斗BGM"
              maxLength={60}
              status={nameExists ? 'error' : undefined}
            />
            <div style={{ fontSize: 11, marginTop: 4, minHeight: 16, color: nameExists ? 'rgb(var(--danger-6))' : 'var(--color-text-3)' }}>
              {nameChecking ? '检查名称唯一性…'
                : nameExists ? '❌ 该名称已存在同名资源，请换一个名称'
                : confirmName.trim() ? '✓ 名称可用' : '请输入名称'}
            </div>
          </div>
        </div>
      </Modal>

      {/* 放大预览弹窗：图片看原图 / 视频完整播放 */}
      <Modal
        title={current?.name || '素材预览'}
        visible={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw', padding: 0 }}
      >
        {current && mediaType === 'image' && (
          <img src={current.url} alt={current.name}
            style={{ maxWidth: '85vw', maxHeight: '80vh', objectFit: 'contain', display: 'block' }} />
        )}
        {current && mediaType === 'video' && (
          <video src={current.url} controls autoPlay
            style={{ maxWidth: '85vw', maxHeight: '80vh', display: 'block' }} />
        )}
      </Modal>
    </BaseNodeShell>
  )
}
