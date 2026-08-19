/**
 * SaveToLibraryButton - 生成图存为素材库（图片生成节点用）
 *
 * 文生图/图生图/融合生成完成后，把（第一张）结果图入库为项目资源。
 * 点击弹出确认框：可编辑名称（预填自动生成的唯一名）+ 选资源类型（角色/场景/道具），
 * 名称实时查重。入库后连线到下游节点即自动 @引用；
 * 未入库时连线会用自动别名 @引用（媒体仍按连线传输，只是不展开资源描述）。
 * 已入库资源在资源管理里被删除时显示「已删除」并支持重新入库（预填原名）。
 */
import React from 'react'
import { Button, Tag, Modal, Input, Select, Message } from '@arco-design/web-react'
import { IconBook } from '@arco-design/web-react/icon'
import { resourceService } from '@/api/services'

type ImageClass = 'character' | 'scene_bg' | 'prop'

export interface SavedMaterial {
  name: string
  imageClass: ImageClass
  resourceId?: string
  url: string
}

const CLASS_OPTIONS = [
  { value: 'character', label: '角色' },
  { value: 'scene_bg', label: '场景' },
  { value: 'prop', label: '道具' },
]

/** 从提示词生成基础名：取前 8 个非空白字符，无则「生成图」 */
function baseNameOf(prompt?: string): string {
  const s = (prompt || '').replace(/\s+/g, '').slice(0, 8)
  return s || '生成图'
}

/** 在已有名称集合中找唯一名：base、base2、base3… */
function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const n = `${base}${i}`
    if (!existing.has(n)) return n
  }
  return `${base}${Date.now()}`
}

async function fetchClassList(projectId: string, cls: ImageClass): Promise<any[]> {
  let list: any
  if (cls === 'character') list = await resourceService.characters.list(projectId)
  else if (cls === 'scene_bg') list = await resourceService.sceneBg.list(projectId)
  else list = await resourceService.props.list(projectId)
  return Array.isArray(list) ? list : (list?.data ?? [])
}

async function fetchClassNames(projectId: string, cls: ImageClass): Promise<string[]> {
  const arr = await fetchClassList(projectId, cls)
  return arr.map((r) => (r.name || '').trim())
}

export const SaveToLibraryButton: React.FC<{
  projectId?: string
  imageUrl?: string
  prompt?: string
  saved?: SavedMaterial | null
  onSaved: (m: SavedMaterial) => void
}> = ({ projectId, imageUrl, prompt, saved, onSaved }) => {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [imageClass, setImageClass] = React.useState<ImageClass>('character')
  const [preparing, setPreparing] = React.useState(false)
  const [nameExists, setNameExists] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  /** 已入库资源在资源管理里被删除 → 失效，允许重新入库 */
  const [stale, setStale] = React.useState(false)

  // 校验已入库资源是否仍存在（资源管理里可能已被删除）
  React.useEffect(() => {
    if (!projectId || !saved?.resourceId || saved.url !== imageUrl) {
      setStale(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const arr = await fetchClassList(projectId, saved.imageClass)
        if (!cancelled) setStale(!arr.some((r) => r.id === saved.resourceId))
      } catch {
        // 校验失败（网络等）不置失效，按已入库显示
        if (!cancelled) setStale(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, saved?.resourceId, saved?.url, imageUrl])

  // 名称实时查重（类型切换后按新类型的资源列表检查）
  React.useEffect(() => {
    if (!open || !name.trim() || !projectId) { setNameExists(false); return }
    let cancelled = false
    setChecking(true)
    const timer = setTimeout(async () => {
      try {
        const names = await fetchClassNames(projectId, imageClass)
        if (!cancelled) setNameExists(names.includes(name.trim()))
      } catch {
        if (!cancelled) setNameExists(false)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }, 400)
    return () => { cancelled = true; clearTimeout(timer); setChecking(false) }
  }, [open, name, imageClass, projectId])

  /** 打开弹窗：预填唯一名称（重新入库时用原名，保持下游 @引用 有效；否则按提示词生成） */
  const openDialog = async (prefillName?: string) => {
    if (!projectId) { Message.warning('请先选择项目'); return }
    setOpen(true)
    setNameExists(false)
    setPreparing(true)
    try {
      const existing = new Set(await fetchClassNames(projectId, imageClass))
      setName(prefillName?.trim() || uniqueName(baseNameOf(prompt), existing))
    } catch {
      setName(prefillName?.trim() || baseNameOf(prompt))
    } finally {
      setPreparing(false)
    }
  }

  const handleSave = async () => {
    if (!projectId) return
    const n = name.trim()
    if (!n) { Message.warning('请输入素材名称'); return }
    if (nameExists) { Message.warning('名称已存在，请换一个'); return }
    setSaving(true)
    try {
      const payload = { name: n, image_url: imageUrl, prompt: prompt || '' }
      let res: any
      if (imageClass === 'character') res = await resourceService.characters.create(projectId, payload as any)
      else if (imageClass === 'scene_bg') res = await resourceService.sceneBg.create(projectId, payload as any)
      else res = await resourceService.props.create(projectId, payload as any)
      const r = res?.data ?? res
      onSaved({ name: n, imageClass, resourceId: r?.id, url: imageUrl! })
      Message.success(`已存为素材「${n}」，连线或 @${n} 即可引用`)
      setOpen(false)
    } catch (e: any) {
      Message.error(e?.response?.data?.detail || e?.message || '入库失败')
    } finally {
      setSaving(false)
    }
  }

  if (!imageUrl) return null
  const isSavedCurrent = saved && saved.url === imageUrl

  // 按钮区视图：已入库(有效) / 已删除(失效) / 未入库
  let body: React.ReactNode
  if (isSavedCurrent && !stale) {
    body = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Tag size="small" color="green" style={{ flexShrink: 0 }}>已入库</Tag>
        <span style={{ fontSize: 11, color: 'var(--color-text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={`@${saved!.name}`}>@{saved!.name} 可引用</span>
      </div>
    )
  } else if (isSavedCurrent && stale) {
    body = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Tag size="small" color="orange" style={{ flexShrink: 0 }}>已删除</Tag>
        <Button size="mini" type="text" long onClick={() => openDialog(saved!.name)}
          title="资源已在资源管理中删除，重新入库可恢复 @引用展开">
          重新入库
        </Button>
      </div>
    )
  } else {
    body = (
      <Button size="mini" type="outline" long icon={<IconBook />} onClick={() => openDialog()}
        title="弹窗编辑名称与类型后入库">
        存为素材库
      </Button>
    )
  }

  return (
    <>
      {body}
      <Modal
        title="存为项目素材"
        visible={open}
        onCancel={() => setOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: preparing || !name.trim() || nameExists || checking }}
        style={{ width: 440, maxWidth: '92vw' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ borderRadius: 6, overflow: 'hidden', maxHeight: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-fill-2)' }}>
            <img src={imageUrl} alt="待保存" style={{ maxWidth: '100%', maxHeight: 140, objectFit: 'contain', display: 'block' }} />
          </div>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>素材名称（提示词 @引用 使用，需唯一）</div>
            <Input
              value={name}
              onChange={setName}
              placeholder={preparing ? '正在生成唯一名称…' : '如：管家、雨夜街道'}
              maxLength={60}
              disabled={preparing}
              status={nameExists ? 'error' : undefined}
            />
            <div style={{ fontSize: 11, marginTop: 4, minHeight: 16, color: nameExists ? 'rgb(var(--danger-6))' : 'var(--color-text-3)' }}>
              {checking ? '检查名称唯一性…'
                : nameExists ? '❌ 该名称已存在同名资源，请换一个名称'
                : name.trim() ? '✓ 名称可用' : '请输入名称'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>资源类型（入库后按此分类）</div>
            <Select value={imageClass} onChange={(v: any) => setImageClass(v)} style={{ width: '100%' }}>
              {CLASS_OPTIONS.map(o => <Select.Option key={o.value} value={o.value}>{o.label}</Select.Option>)}
            </Select>
          </div>
        </div>
      </Modal>
    </>
  )
}

export default SaveToLibraryButton
