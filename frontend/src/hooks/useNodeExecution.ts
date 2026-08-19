/**
 * useNodeExecution - 画布节点执行引擎
 *
 * 职责：
 * 1. 收集上游连线数据：根据 edges 找到目标节点的所有上游 source 节点，
 *    按 handle 类型提取 text / image / ref / video / audio 等输入值。
 * 2. 按 nodeType 分发到对应的 creationService API。
 * 3. 轮询 taskService.get 直到 completed/failed（复用 getTaskPollTimeout）。
 * 4. 把产出 URL 回填到节点 data._result，刷新积分。
 *
 * 设计原则：
 * - 节点 data 是 mutable 对象（React Flow 推荐模式），直接改 data 字段 + 触发 setNodes 重渲染。
 * - 执行逻辑是纯函数（传入 nodes/edges/projectId），不耦合组件状态。
 */
import { useCallback, useRef } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { Message } from '@arco-design/web-react'
import { creationService, taskService } from '@/api/services'
import { apiClient } from '@/api/client'
import { useCreditStore } from '@/stores'
import { getTaskPollTimeout } from '@/hooks/useSiteConfig'
import { handleTypeOf } from '@/components/canvas/types'
import { promptHasMention } from '@/utils/prompt'
import type { BaseNodeData, CanvasNodeType } from '@/components/canvas/types'

// ==================== 上游数据收集 ====================
export interface NodeInputs {
  text?: string
  image?: string
  /** 连到 image / ref 输入的全部图片（多上游聚合，name 为素材名，rtype 为资源类型） */
  images?: { url: string; name?: string; rtype?: string }[]
  firstFrame?: string
  lastFrame?: string
  video?: string
  /** 连到 video 输入的全部视频（多上游聚合，首个为主输入） */
  videos?: { url: string; name?: string; rtype?: string }[]
  audio?: string
  /** 连到 audio 输入的全部音频（多上游聚合，首个为主输入） */
  audios?: { url: string; name?: string; rtype?: string }[]
  refs?: { type: string; name: string; image_url?: string; resource_id?: string }[]
}

/**
 * 根据当前节点 id 和 edges，找出所有上游节点并按 handle 类型归类输入。
 * image / ref / video / audio 输入均为多值聚合：任意多个上游（上传素材节点、
 * 素材节点、生成结果）都会按连线顺序收集（首个作为主输入，其余作参考）。
 */
export function collectInputs(nodeId: string, nodes: Node[], edges: Edge[]): NodeInputs {
  const inputs: NodeInputs = { refs: [], images: [], videos: [], audios: [] }
  const pushMedia = (
    arr: { url: string; name?: string; rtype?: string }[],
    url?: string, name?: string, rtype?: string,
  ) => {
    if (url && !arr.some((m) => m.url === url)) arr.push(name || rtype ? { url, name, rtype } : { url })
  }
  const pushImage = (url?: string, name?: string, rtype?: string) =>
    pushMedia(inputs.images!, url, name, rtype)
  // 找所有连到本节点的边（保持 edges 顺序，连线先后即参考顺序）
  const incomingEdges = edges.filter((e) => e.target === nodeId)
  for (const edge of incomingEdges) {
    const sourceNode = nodes.find((n) => n.id === edge.source)
    if (!sourceNode) continue
    const sourceData = sourceNode.data as BaseNodeData
    // 分支路由按句柄 id 首段（first_frame/ref1 等细分句柄各有专门分支），
    // 句柄类型索引（handleTypeOf）只用于连线校验 —— 两者语义不同不能混用：
    // first_frame 在注册表中的类型是 image，但收集时必须走首帧分支
    const handleKey = edge.targetHandle?.split('-')[0] || ''
    const semanticType = handleTypeOf(edge.targetHandle)
    // 上游取值：生成节点的产出（_result 首个）、素材/上传素材节点的素材地址与名称
    // （上传素材节点按类型存 files.image/video/audio，兼容旧版平铺 url 字段）
    const srcFiles = (sourceData as any).files || {}
    const srcMedia = (k: 'image' | 'video' | 'audio'): string | undefined => {
      if (k === 'image')
        return sourceData._result?.[0] || (sourceData as any).image_url
          || srcFiles.image?.url || (sourceData as any).url
      return sourceData._result?.[0] || srcFiles[k]?.url || (sourceData as any).url
    }
    // 素材名：素材库节点 name；上传素材节点 files；图片生成节点 savedMaterial
    // （入库后）；未入库的生成结果用自动别名 refAlias（连线 @引用 指代用）
    const srcName = (k: 'image' | 'video' | 'audio'): string | undefined =>
      (sourceData as any).name || srcFiles[k]?.name
      || (k === 'image' ? (sourceData as any).savedMaterial?.name : undefined)
      || (sourceData as any).refAlias || undefined
    // 资源类型（连线参考芯片配色用）：素材库节点 classType；上传节点 imageClass/mediaType；
    // 图片生成节点 savedMaterial.imageClass
    const srcRtype = (k: 'image' | 'video' | 'audio'): string | undefined => {
      if ((sourceData as any).name) return (sourceData as any).classType || 'character'
      if (k === 'image') return srcFiles.image?.imageClass || (sourceData as any).savedMaterial?.imageClass || undefined
      return k
    }
    if (handleKey === 'text') {
      inputs.text = inputs.text || (sourceData as any).text || ''
    } else if (handleKey === 'first_frame') {
      inputs.firstFrame = inputs.firstFrame || srcMedia('image') || ''
    } else if (handleKey === 'last_frame') {
      inputs.lastFrame = inputs.lastFrame || srcMedia('image') || ''
    } else if (handleKey === 'video') {
      // 参考视频输入（多值）：上传素材节点 / videoToVideo / 生成结果
      pushMedia(inputs.videos!, srcMedia('video'), srcName('video'), srcRtype('video'))
    } else if (handleKey === 'audio') {
      pushMedia(inputs.audios!, srcMedia('audio'), srcName('audio'), srcRtype('audio'))
    } else if (handleKey.startsWith('ref')) {
      // ref / ref1 / ref2 / ref3（多值，兼容 image→ref 连线）：
      // - 素材节点（有 name）→ 收集为元素引用
      // - 生成节点 / 上传素材节点 → 图片直接并入 images 参考列表
      if ((sourceData as any).name) {
        inputs.refs!.push({
          type: (sourceData as any).classType || 'character',
          name: (sourceData as any).name,
          image_url: (sourceData as any).image_url,
          resource_id: (sourceData as any).resource_id,
        })
        pushImage((sourceData as any).image_url, (sourceData as any).name, (sourceData as any).classType)
      } else {
        pushImage(srcMedia('image'), srcName('image'), srcRtype('image'))
      }
    } else if (semanticType === 'image' || handleKey === 'image') {
      // image 输入（多值）：上游 _result（生成结果）或 material/upload 节点的图片
      pushImage(srcMedia('image'), srcName('image'), srcRtype('image'))
    }
  }
  inputs.image = inputs.images?.[0]?.url
  inputs.video = inputs.videos?.[0]?.url
  inputs.audio = inputs.audios?.[0]?.url
  return inputs
}

// ==================== 节点类型 → API 分发 ====================
async function dispatchGeneration(
  nodeType: CanvasNodeType,
  data: BaseNodeData,
  inputs: NodeInputs,
  projectId?: string,
): Promise<{ taskId?: string; urls?: string[]; credits?: number; sync?: boolean }> {
  const d = data as any
  // 构造 elements（来自 ref 输入或节点自带的）
  const elements = inputs.refs?.length
    ? inputs.refs.map((r) => ({ type: r.type, name: r.name, image_url: r.image_url }))
    : []
  // 连线图片多上游聚合：全部作为参考图元素（适配器按模型能力去重/限量，
  // OpenAI edits ≤4 张、MiniMax r2va ≤9 张）；首帧/驱动图语义的分支取第 1 张。
  // name 用素材实际名称（上传节点可命名），模型能据此区分各参考图
  const linkedImages = (inputs.images || []).filter((m) => m.url)
  const linkedImageElements = linkedImages.map((m, i) => ({
    type: 'reference', name: m.name || `连线参考图${i + 1}`, image_url: m.url,
  }))
  // 连线视频/音频多上游聚合：作为 reference_video/reference_audio 元素
  // （适配器按渠道能力透传公网 URL，渠道不支持时自动跳过）
  const linkedVideoElements = (inputs.videos || []).filter((m) => m.url).slice(0, 3)
    .map((m, i) => ({ type: 'video', name: m.name || `参考视频${i + 1}`, video_url: m.url }))
  const linkedAudioElements = (inputs.audios || []).filter((m) => m.url).slice(0, 3)
    .map((m, i) => ({ type: 'audio', name: m.name || `参考音频${i + 1}`, audio_url: m.url }))
  const mediaElements = [...linkedVideoElements, ...linkedAudioElements]
  const elementsWithImages = [...elements, ...linkedImageElements, ...mediaElements]

  // 连线素材自动 @引用：连线时 CanvasPage 已把 @名称 写进目标节点提示词（编辑器
  // 可见/可编辑），这里的注入只作兜底 —— 补上缺失的（素材后命名/改名、旧画布
  // 未写入等场景），已在提示词文本里的不重复。后端 expand_mentions_for_project
  // 会把 @名称 展开为 [角色:名] 并把引用资源媒体并入参考元素（按 URL 去重）。
  // 去重需双格式识别：编辑器芯片序列化为 @{type:uuid:name} 模板、连线插入为
  // @名称 裸名，只匹配裸名会把已引用的素材再注入一遍（表现为展开后重复）
  const basePromptText = String(inputs.text || d.prompt || '')
  const mentionPrefix = (() => {
    const names: string[] = []
    for (const m of [...(inputs.images || []), ...(inputs.videos || []), ...(inputs.audios || [])]) {
      if (m.name && !names.includes(m.name)) names.push(m.name)
    }
    const missing = names.filter((n) => !promptHasMention(basePromptText, n))
    return missing.length ? missing.map((n) => `@${n}`).join(' ') + ' ' : ''
  })()

  switch (nodeType) {
    case 'imageGen':
    case 'fusionGen': {
      const payload = {
        prompt: mentionPrefix + (inputs.text || d.prompt || ''),
        elements: elementsWithImages, // 连线图片全部作为参考图
        size: d.size || '16:9',
        count: d.count || 1,
        quality: d.quality,
        resolution: d.resolution || undefined,
        watermark_enabled: d.watermark,
        skip_ref_binding: true,  // 画布链路：提示词原文即所发，不注入参考绑定语
        model: d.model || undefined,
      }
      // 用 apiClient 直接调，设置长 timeout + async_submit
      const res: any = await apiClient.post('/creation/fusion', payload, {
        params: { ...(projectId ? { project_id: projectId } : {}), async_submit: true },
        timeout: 300000,
      })
      const r = res?.data ?? res
      return { taskId: r.task_id, urls: r.urls, credits: r.credits_consumed }
    }
    case 'imageToImage': {
      // 图生图：参考图优先连线上游，其次节点内上传（ref_image）；连线多图全部作为参考
      const refImage = inputs.image || d.ref_image
      if (!refImage) throw new Error('请上传参考图或连线图片输入')
      const payload = {
        prompt: mentionPrefix + (inputs.text || d.prompt || ''),
        elements: [
          ...(d.ref_image ? [{ type: 'reference', name: '节点参考图', image_url: d.ref_image }] : []),
          ...elementsWithImages,
        ],
        image_url: refImage,
        size: d.size || '16:9',
        count: d.count || 1,
        quality: d.quality,
        watermark_enabled: d.watermark,
        skip_ref_binding: true,  // 画布链路：提示词原文即所发，不注入参考绑定语
        model: d.model || undefined,
      }
      const res: any = await apiClient.post('/creation/fusion', payload, {
        params: { ...(projectId ? { project_id: projectId } : {}), async_submit: true },
        timeout: 300000,
      })
      const r = res?.data ?? res
      return { taskId: r.task_id, urls: r.urls, credits: r.credits_consumed }
    }
    case 'videoToVideo': {
      // 视频生视频：参考视频（连线或节点上传）+ 新脸参考图（连线第一张或上传）
      // 走 reference_video 参考生成；参考视频需公网 URL（渠道不收本地地址）
      const refVideo = inputs.video || d.ref_video
      if (!refVideo) throw new Error('请上传参考视频或连线视频输入')
      const faceImage = inputs.image || d.ref_face
      // 新脸图之外的连线图片作为附加参考；主参考视频之外的连线视频、
      // 全部连线音频作为 reference_video/reference_audio 元素
      const extraRefs = linkedImageElements.filter(
        (e: any) => e.image_url !== faceImage && e.image_url !== d.ref_face)
      const extraVideoElements = linkedVideoElements.filter((e: any) => e.video_url !== refVideo)
      const payload = {
        prompt: mentionPrefix + (inputs.text || d.prompt || ''),
        video_url: refVideo,
        image_url: faceImage || undefined,
        elements: [
          ...(d.ref_face ? [{ type: 'reference', name: '新脸参考图', image_url: d.ref_face }] : []),
          ...extraRefs,
          ...extraVideoElements,
          ...linkedAudioElements,
        ],
        size: d.size || '16:9',
        duration: d.duration || 5,
        resolution: d.resolution,
        quality: d.quality,
        watermark_enabled: d.watermark,
        skip_ref_binding: true,  // 画布链路：提示词原文即所发，不注入参考绑定语
        model: d.model || undefined,
      }
      const res: any = await apiClient.post('/creation/image-to-video', payload, {
        params: { project_id: projectId, async_submit: true },
        timeout: 300000,
      })
      const r = res?.data ?? res
      return { taskId: r.task_id, urls: r.urls, credits: r.credits_consumed }
    }
    case 'videoGen': {
      if (!inputs.image) throw new Error('请连线图片输入（或上游节点先生成图片）')
      // 第 1 张连线图作为首帧/驱动图；其余连线图作为附加参考（r2va 多图参考）；
      // 连线视频/音频作为 reference_video/reference_audio 元素；
      // 提示词注入各参考图名称（多图时模型才能区分综合参考，避免只跟第 1 张）
      const extraRefs = linkedImageElements.filter((e: any) => e.image_url !== inputs.image)
      const payload = {
        prompt: mentionPrefix + (inputs.text || d.prompt || ''),
        image_url: inputs.image,
        elements: [...extraRefs, ...mediaElements],
        size: d.size || '16:9',
        duration: d.duration || 5,
        resolution: d.resolution,
        quality: d.quality,
        watermark_enabled: d.watermark,
        skip_ref_binding: true,  // 画布链路：提示词原文即所发，不注入参考绑定语
        model: d.model || undefined,
      }
      const res: any = await apiClient.post('/creation/image-to-video', payload, {
        params: { project_id: projectId, async_submit: true },
        timeout: 300000,
      })
      const r = res?.data ?? res
      return { taskId: r.task_id, urls: r.urls, credits: r.credits_consumed }
    }
    case 'firstLastFrame': {
      if (!inputs.firstFrame) throw new Error('请连线首帧图片输入')
      const payload = {
        prompt: inputs.text || d.prompt || '',
        first_frame_url: inputs.firstFrame,
        last_frame_url: inputs.lastFrame || undefined,
        size: d.size || '16:9',
        duration: d.duration || 5,
        resolution: d.resolution,
        quality: d.quality,
        watermark_enabled: d.watermark,
        skip_ref_binding: true,  // 画布链路：提示词原文即所发，不注入参考绑定语
        model: d.model || undefined,
      }
      const res: any = await apiClient.post('/creation/first-last-frame', payload, {
        params: { project_id: projectId, async_submit: true },
        timeout: 300000,
      })
      const r = res?.data ?? res
      return { taskId: r.task_id, urls: r.urls, credits: r.credits_consumed }
    }
    case 'tts': {
      const payload = {
        text: inputs.text || d.text || '',
        voice_id: d.voice_id || undefined,
        model: d.model || undefined,
      }
      const res: any = await apiClient.post('/creation/tts', payload, {
        params: { ...(projectId ? { project_id: projectId } : {}), async_submit: true },
        timeout: 300000,
      })
      const r = res?.data ?? res
      return { taskId: r.task_id, urls: r.urls, credits: r.credits_consumed }
    }
    case 'lipSync': {
      if (!inputs.video) throw new Error('请连线视频输入')
      if (!inputs.audio) throw new Error('请连线音频输入')
      const payload = {
        video_url: inputs.video,
        audio_url: inputs.audio,
        model: d.model || undefined,
      }
      const res: any = await apiClient.post('/creation/lip-sync', payload, {
        params: { ...(projectId ? { project_id: projectId } : {}), async_submit: true },
        timeout: 300000,
      })
      const r = res?.data ?? res
      return { taskId: r.task_id, urls: r.urls, credits: r.credits_consumed }
    }
    case 'prompt':
    case 'material':
    case 'uploadMaterial':
    case 'output':
      // 这几种节点不需要执行生成
      return {}
  }
  return {}
}

// ==================== 主 hook ====================
export interface UseNodeExecutionOptions {
  projectId?: string
  /** 触发节点重渲染（传入新的 nodes 数组） */
  onNodesChange?: (updater: (nodes: Node[]) => Node[]) => void
  /** 获取当前 nodes/edges（避免闭包陈旧） */
  getNodesEdges?: () => { nodes: Node[]; edges: Edge[] }
}

export function useNodeExecution(opts: UseNodeExecutionOptions) {
  const { projectId, onNodesChange, getNodesEdges } = opts
  const { loadBalance } = useCreditStore()
  const runningRef = useRef<Set<string>>(new Set())

  // 用 ref 保存最新的 opts 引用，避免 callbacks 每次渲染都新建导致 runNode 不稳定
  const optsRef = useRef(opts)
  optsRef.current = opts

  /** 更新单个节点的 data 字段（immutable，触发重渲染） */
  const updateNodeData = useCallback((nodeId: string, patch: Partial<BaseNodeData>) => {
    optsRef.current.onNodesChange?.((nodes) => nodes.map((n) => {
      if (n.id !== nodeId) return n
      return { ...n, data: { ...n.data, ...patch } as any }
    }))
  }, [])

  /** 轮询任务直到完成 */
  const pollTask = useCallback(async (taskId: string, nodeId: string) => {
    const intervalSec = 3
    const maxAttempts = Math.ceil(getTaskPollTimeout() / intervalSec) + 10
    let attempt = 0
    return new Promise<void>((resolve) => {
      const timer = setInterval(async () => {
        attempt++
        try {
          const res: any = await taskService.get(taskId)
          const task = res?.data ?? res
          if (task.status === 'completed') {
            clearInterval(timer)
            const urls = task.output_urls || []
            updateNodeData(nodeId, {
              _status: 'completed',
              _taskId: undefined,
              _result: urls,
              _errorMessage: undefined,
              _updatedAt: Date.now(),
            })
            Message.success(`节点完成（产出 ${urls.length} 个）`)
            resolve()
          } else if (task.status === 'failed') {
            clearInterval(timer)
            updateNodeData(nodeId, {
              _status: 'failed',
              _taskId: undefined,
              _errorMessage: task.error_message || '生成失败',
              _updatedAt: Date.now(),
            })
            Message.error(task.error_message || '生成失败')
            resolve()
          }
          if (attempt >= maxAttempts) {
            clearInterval(timer)
            updateNodeData(nodeId, {
              _status: 'failed',
              _errorMessage: '生成超时',
              _updatedAt: Date.now(),
            })
            Message.warning('生成超时，请稍后在任务列表查看结果')
            resolve()
          }
        } catch {
          // 网络错误静默，继续轮询
        }
      }, intervalSec * 1000)
    })
  }, [updateNodeData])

  /** 执行单个节点 */
  const runNode = useCallback(async (nodeId: string) => {
    if (runningRef.current.has(nodeId)) return
    const ne = optsRef.current.getNodesEdges?.()
    if (!ne) return
    const { nodes, edges } = ne
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) return
    const nodeType = node.type as CanvasNodeType
    // prompt / material / uploadMaterial / output 不执行
    if (['prompt', 'material', 'uploadMaterial', 'output'].includes(nodeType)) return

    runningRef.current.add(nodeId)
    // savedMaterial 一并清除：重新生成 = 新图片，旧的入库关联不再对应当前结果
    updateNodeData(nodeId, { _status: 'running', _errorMessage: undefined, _result: undefined, savedMaterial: undefined })

    try {
      const inputs = collectInputs(nodeId, nodes, edges)
      const result = await dispatchGeneration(nodeType, node.data as BaseNodeData, inputs, optsRef.current.projectId)
      // 刷新积分（不论成功失败，已扣费）
      loadBalance()

      if (result.urls?.length && !result.taskId) {
        // 同步完成
        updateNodeData(nodeId, {
          _status: 'completed',
          _result: result.urls,
          _updatedAt: Date.now(),
        })
        Message.success(`完成！消耗 ${result.credits || 0} 积分`)
      } else if (result.taskId) {
        // 异步任务，开始轮询
        updateNodeData(nodeId, { _taskId: result.taskId })
        Message.info('已提交，生成中…')
        await pollTask(result.taskId, nodeId)
      }
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || '执行失败'
      updateNodeData(nodeId, { _status: 'failed', _errorMessage: msg, _updatedAt: Date.now() })
      Message.error(msg)
    } finally {
      runningRef.current.delete(nodeId)
    }
  }, [updateNodeData, pollTask, loadBalance])

  return { runNode, updateNodeData, collectInputs: (nodeId: string) => {
    const ne = optsRef.current.getNodesEdges?.()
    return ne ? collectInputs(nodeId, ne.nodes, ne.edges) : { refs: [] }
  } }
}
