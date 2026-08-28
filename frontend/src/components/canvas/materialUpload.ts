/**
 * 画布素材上传公共流程
 *
 * 「上传素材节点」与「画布拖拽批量上传」共用：上传文件 → 入库项目资源
 * （提示词 @引用 立即可用）。名称唯一性由后端 create 接口兜底（重名报错），
 * 前端查重仅作提前拦截。
 */
import { uploadService, resourceService } from '@/api/services'

export type MediaType = 'image' | 'video' | 'audio'
export type ImageClass = 'character' | 'scene_bg' | 'prop'

/** 扩展名兜底识别（部分浏览器拖拽文件不带 MIME type） */
const EXT_MEDIA: Record<string, MediaType> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio',
}

/** 识别文件素材类型；图片/视频/音频之外返回 null */
export function detectMediaType(file: File): MediaType | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  return EXT_MEDIA[ext] || null
}

/** 名称查重用的桶 key（图片按资源类型分桶，同名角色/场景互不冲突） */
export function mediaBucket(mediaType: MediaType, imageClass?: ImageClass): string {
  return mediaType === 'image' ? `image:${imageClass || 'character'}` : mediaType
}

/** 拉取某桶内已有资源名集合（查重用；失败返回空集合，交给后端兜底） */
export async function listResourceNames(projectId: string, bucket: string): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    let list: any
    if (bucket === 'video') list = await resourceService.video.list(projectId)
    else if (bucket === 'audio') list = await resourceService.audio.list(projectId)
    else if (bucket === 'image:character') list = await resourceService.characters.list(projectId)
    else if (bucket === 'image:scene_bg') list = await resourceService.sceneBg.list(projectId)
    else if (bucket === 'image:prop') list = await resourceService.props.list(projectId)
    else return names
    const arr: any[] = Array.isArray(list) ? list : (list?.data ?? [])
    for (const r of arr) {
      const n = (r?.name || '').trim()
      if (n) names.add(n)
    }
  } catch { /* 拉取失败按无重名处理，后端 create 仍会兜底 */ }
  return names
}

/** 入库项目资源（角色/场景/道具/视频/音频），返回资源 id */
export async function registerMaterial(
  projectId: string,
  mediaType: MediaType,
  opts: { name: string; url: string; imageClass?: ImageClass },
): Promise<string | undefined> {
  let res: any
  if (mediaType === 'video') {
    res = await resourceService.video.create(projectId, { name: opts.name, url: opts.url })
  } else if (mediaType === 'audio') {
    res = await resourceService.audio.create(projectId, { name: opts.name, type: 'sfx', url: opts.url, content: '' })
  } else {
    const payload = { name: opts.name, image_url: opts.url, prompt: '' }
    const cls = opts.imageClass || 'character'
    res = cls === 'character'
      ? await resourceService.characters.create(projectId, payload as any)
      : cls === 'scene_bg'
        ? await resourceService.sceneBg.create(projectId, payload as any)
        : await resourceService.props.create(projectId, payload as any)
  }
  return (res?.data ?? res)?.id
}

/** 上传文件 + 入库项目资源一条龙 */
export async function uploadAndRegisterMaterial(
  projectId: string,
  mediaType: MediaType,
  file: File,
  opts: { name: string; imageClass?: ImageClass; onProgress?: (p: number) => void },
): Promise<{ url: string; resourceId?: string }> {
  const res: any = await uploadService[mediaType](file, opts.onProgress)
  const r = res?.data ?? res
  const url = r?.url || r?.file_url || (typeof r === 'string' ? r : '')
  if (!url) throw new Error('上传失败：未返回文件地址')
  const resourceId = await registerMaterial(projectId, mediaType, { name: opts.name, url, imageClass: opts.imageClass })
  return { url, resourceId }
}
