/**
 * DropUploadModal - 画布拖拽文件的批量上传弹窗
 *
 * 本地文件拖入画布后先在此统一确认再上传：
 * - 每个文件可改素材名（默认=文件名去扩展名，本批次内同名自动加序号去重），
 *   图片逐个选资源类型（角色/场景/道具）
 * - 打开时拉取相关资源列表查重：与已有资源或本批次内重名均拦截
 * - 确认后逐个「上传+入库」（共用 materialUpload 流程），每个文件完成即
 *   回调 onFileUploaded，画布随之在落点创建「上传素材」节点
 * - 失败项可改名后点「继续上传」重试；中途关闭取消未开始的文件
 */
import React from 'react'
import { Modal, Button, Input, Select, Tag, Tooltip, Progress } from '@arco-design/web-react'
import { IconImage, IconVideoCamera, IconSound, IconUpload } from '@arco-design/web-react/icon'
import {
  mediaBucket, listResourceNames, uploadAndRegisterMaterial,
  type MediaType, type ImageClass,
} from './materialUpload'

export interface DropFileItem { file: File; mediaType: MediaType }

export interface DropUploadResult {
  index: number
  mediaType: MediaType
  url: string
  name: string
  imageClass?: ImageClass
  resourceId?: string
}

interface RowState {
  name: string
  imageClass: ImageClass
  status: 'pending' | 'uploading' | 'done' | 'error'
  progress: number
  error?: string
}

const IMAGE_CLASS_OPTIONS = [
  { value: 'character', label: '角色' },
  { value: 'scene_bg', label: '场景' },
  { value: 'prop', label: '道具' },
]

const MEDIA_TAG: Record<MediaType, { label: string; color: string; icon: React.ReactNode }> = {
  image: { label: '图片', color: 'purple', icon: <IconImage /> },
  video: { label: '视频', color: 'red', icon: <IconVideoCamera /> },
  audio: { label: '音频', color: 'arcoblue', icon: <IconSound /> },
}

interface DropUploadModalProps {
  visible: boolean
  files: DropFileItem[]
  projectId?: string
  onClose: () => void
  /** 单个文件上传+入库成功后回调（画布据此创建节点） */
  onFileUploaded: (result: DropUploadResult) => void
}

export const DropUploadModal: React.FC<DropUploadModalProps> = ({ visible, files, projectId, onClose, onFileUploaded }) => {
  const [rows, setRows] = React.useState<RowState[]>([])
  const [existing, setExisting] = React.useState<Record<string, Set<string>>>({})
  const [checking, setChecking] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const cancelRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  const rowsRef = React.useRef<RowState[]>([])
  rowsRef.current = rows
  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 打开时初始化各文件行（默认名=文件名去扩展名，本批次内同名自动加 -2/-3 序号）
  React.useEffect(() => {
    if (!visible || files.length === 0) return
    cancelRef.current = false
    const used = new Set<string>()
    setRows(files.map(({ file }) => {
      const base = (file.name.replace(/\.[^.]+$/, '') || '素材').trim()
      let name = base
      let n = 2
      while (used.has(name)) name = `${base}-${n++}`
      used.add(name)
      return { name, imageClass: 'character', status: 'pending', progress: 0 }
    }))
  }, [visible, files])

  // 打开时拉取涉及的资源名集合（图片三种分类都拉，行内改类型无需重查）
  React.useEffect(() => {
    if (!visible || !projectId || files.length === 0) { setExisting({}); setChecking(false); return }
    let cancelled = false
    setChecking(true)
    ;(async () => {
      const buckets = new Set<string>()
      for (const f of files) {
        if (f.mediaType === 'image') {
          buckets.add('image:character'); buckets.add('image:scene_bg'); buckets.add('image:prop')
        } else buckets.add(f.mediaType)
      }
      const entries = await Promise.all([...buckets].map(async (b) => [b, await listResourceNames(projectId, b)] as const))
      if (!cancelled) { setExisting(Object.fromEntries(entries)); setChecking(false) }
    })()
    return () => { cancelled = true }
  }, [visible, projectId, files])

  /** 行内校验：非空 / 本批次内同桶不重名 / 不与已有资源重名（已完成/上传中行不再校验） */
  const rowError = (i: number): string | undefined => {
    const row = rows[i]
    const item = files[i]
    if (!row || !item || row.status === 'done' || row.status === 'uploading') return undefined
    const name = row.name.trim()
    if (!name) return '请输入名称'
    for (let j = 0; j < rows.length; j++) {
      if (j === i) continue
      const rj = rows[j]
      if (!rj || rj.status === 'done' || rj.status === 'uploading') continue
      if (files[j]?.mediaType !== item.mediaType) continue
      if (item.mediaType === 'image' && rj.imageClass !== row.imageClass) continue
      if (rj.name.trim() === name) return '与本批次文件重名'
    }
    if (existing[mediaBucket(item.mediaType, row.imageClass)]?.has(name)) return '已有同名资源'
    return undefined
  }

  /** 顺序上传给定行（pending/error），每个完成即回调；cancelRef 置位后停在当前文件 */
  const runUpload = async (indexes: number[]) => {
    if (!projectId || indexes.length === 0) return
    cancelRef.current = false
    setRunning(true)
    for (const i of indexes) {
      if (cancelRef.current) break
      const row = rowsRef.current[i]
      const item = files[i]
      if (!row || !item || row.status === 'done' || row.status === 'uploading') continue
      const name = row.name.trim()
      const imageClass = item.mediaType === 'image' ? row.imageClass : undefined
      const patch = (p: Partial<RowState>) => {
        if (mountedRef.current) setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)))
      }
      patch({ status: 'uploading', progress: 0, error: undefined })
      try {
        const { url, resourceId } = await uploadAndRegisterMaterial(projectId, item.mediaType, item.file, {
          name, imageClass,
          onProgress: (p) => patch({ progress: Math.min(100, p) }),
        })
        patch({ status: 'done', progress: 100 })
        onFileUploaded({ index: i, mediaType: item.mediaType, url, name, imageClass, resourceId })
      } catch (e: any) {
        const detail = e?.response?.data?.detail
        patch({ status: 'error', error: typeof detail === 'string' && detail ? detail : (e?.message || '上传失败') })
      }
    }
    if (mountedRef.current) setRunning(false)
  }

  const todoIndexes = rows.map((r, i) => (r.status === 'pending' || r.status === 'error' ? i : -1)).filter((i) => i >= 0)
  const doneCount = rows.filter((r) => r.status === 'done').length
  const failedCount = rows.filter((r) => r.status === 'error').length
  const started = rows.some((r) => r.status !== 'pending')
  const invalid = todoIndexes.some((i) => rowError(i))

  const handleClose = () => {
    cancelRef.current = true
    onClose()
  }

  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 12, color: failedCount ? 'rgb(var(--danger-6))' : 'var(--color-text-3)' }}>
        {running ? '上传中…（已完成文件已生成画布节点）'
          : doneCount === 0 ? '上传后自动入库为项目资源，提示词 @名称 可直接引用'
          : `已入库 ${doneCount}/${rows.length}${failedCount ? `，失败 ${failedCount} 个` : ''}`}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        {running ? (
          <Button status="warning" onClick={() => { cancelRef.current = true }}>取消剩余</Button>
        ) : (
          <>
            <Button onClick={handleClose}>{todoIndexes.length ? '取消' : '完成'}</Button>
            {todoIndexes.length > 0 && (
              <Button
                type="primary" icon={<IconUpload />}
                disabled={invalid || checking || !projectId}
                onClick={() => runUpload(todoIndexes)}
              >
                {started ? `继续上传（${todoIndexes.length}）` : '开始上传'}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )

  return (
    <Modal
      title={`拖拽上传素材（${files.length} 个文件）`}
      visible={visible}
      onCancel={handleClose}
      maskClosable={!running}
      footer={footer}
      style={{ width: 720, maxWidth: '94vw' }}
    >
      <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginBottom: 10 }}>
        单次上限：图片 9 张 · 视频 3 个 · 音频 3 个。名称需唯一（@引用 使用），图片入库前先选资源类型。
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflowY: 'auto' }}>
        {files.map(({ file, mediaType }, i) => {
          const row = rows[i]
          if (!row) return null
          const err = rowError(i)
          const tag = MEDIA_TAG[mediaType]
          const locked = running || row.status === 'done' || row.status === 'uploading'
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: 'var(--color-fill-1)', borderRadius: 4 }}>
              <Tag size="small" color={tag.color} icon={tag.icon} style={{ flexShrink: 0 }}>{tag.label}</Tag>
              <span
                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}
                title={`${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB）`}
              >
                {file.name}
              </span>
              {mediaType === 'image' && (
                <Select
                  size="small" style={{ width: 84, flexShrink: 0 }}
                  value={row.imageClass} disabled={locked}
                  onChange={(v: any) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, imageClass: v } : r)))}
                >
                  {IMAGE_CLASS_OPTIONS.map((o) => <Select.Option key={o.value} value={o.value}>{o.label}</Select.Option>)}
                </Select>
              )}
              <Input
                size="small" style={{ width: 190, flexShrink: 0 }}
                value={row.name} maxLength={60} disabled={locked}
                status={err ? 'error' : undefined}
                onChange={(v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, name: v } : r)))}
              />
              <div style={{ width: 128, flexShrink: 0, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                {row.status === 'uploading' && (
                  <Progress size="small" percent={row.progress} showText style={{ width: 120 }} />
                )}
                {row.status === 'done' && <Tag size="small" color="green">已入库</Tag>}
                {row.status === 'error' && (
                  <Tooltip content={row.error}>
                    <Tag size="small" color="red">失败，可重试</Tag>
                  </Tooltip>
                )}
                {row.status === 'pending' && (
                  <span style={{ fontSize: 11, color: err ? 'rgb(var(--danger-6))' : 'var(--color-text-4)', textAlign: 'right' }}>
                    {checking && !err ? '查重中…' : (err || '待上传')}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
