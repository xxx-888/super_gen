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
import type { BaseNodeData, CanvasNodeType } from '@/components/canvas/types'

// ==================== 上游数据收集 ====================
export interface NodeInputs {
  text?: string
  image?: string
  /** 连到 image / ref 输入的全部图片（多上游聚合，按连线顺序） */
  images?: string[]
  firstFrame?: string
  lastFrame?: string
  video?: string
  audio?: string
  refs?: { type: string; name: string; image_url?: string; resource_id?: string }[]
}

/**
 * 根据当前节点 id 和 edges，找出所有上游节点并按 handle 类型归类输入。
 * image / ref 输入为多值聚合：任意多个上游（素材节点、生成结果）的图
 * 都会收集进 images（首帧类语义取第 1 张，参考类语义全量使用）。
 */
export function collectInputs(nodeId: string, nodes: Node[], edges: Edge[]): NodeInputs {
  const inputs: NodeInputs = { refs: [], images: [] }
  const pushImage = (url?: string) => {
    if (url && !inputs.images!.includes(url)) inputs.images!.push(url)
  }
  // 找所有连到本节点的边（保持 edges 顺序，连线先后即参考图顺序）
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
    if (handleKey === 'text') {
      inputs.text = inputs.text || (sourceData as any).text || ''
    } else if (handleKey === 'first_frame') {
      inputs.firstFrame = inputs.firstFrame || sourceData._result?.[0] || (sourceData as any).image_url || ''
    } else if (handleKey === 'last_frame') {
      inputs.lastFrame = inputs.lastFrame || sourceData._result?.[0] || (sourceData as any).image_url || ''
    } else if (handleKey === 'video') {
      inputs.video = inputs.video || sourceData._result?.[0] || ''
    } else if (handleKey === 'audio') {
      inputs.audio = inputs.audio || sourceData._result?.[0] || ''
    } else if (handleKey.startsWith('ref')) {
      // ref / ref1 / ref2 / ref3（多值，兼容 image→ref 连线）：
      // - 素材节点（有 name）→ 收集为元素引用
      // - 生成节点（无 name、有 _result）→ 图片直接并入 images 参考列表
      if ((sourceData as any).name) {
        inputs.refs!.push({
          type: (sourceData as any).classType || 'character',
          name: (sourceData as any).name,
          image_url: (sourceData as any).image_url,
          resource_id: (sourceData as any).resource_id,
        })
        pushImage((sourceData as any).image_url)
      } else {
        pushImage(sourceData._result?.[0] || '')
      }
    } else if (semanticType === 'image' || handleKey === 'image') {
      // image 输入（多值）：上游 _result（生成结果）或 material 的 image_url
      pushImage(sourceData._result?.[0] || (sourceData as any).image_url || '')
    }
  }
  inputs.image = inputs.images?.[0]
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
  // OpenAI edits ≤4 张、MiniMax r2va ≤9 张）；首帧/驱动图语义的分支取第 1 张
  const linkedImages = (inputs.images || []).filter(Boolean)
  const linkedImageElements = linkedImages.map((u, i) => ({
    type: 'reference', name: `连线参考图${i + 1}`, image_url: u,
  }))
  const elementsWithImages = [...elements, ...linkedImageElements]

  switch (nodeType) {
    case 'imageGen':
    case 'fusionGen': {
      const payload = {
        prompt: inputs.text || d.prompt || '',
        elements: elementsWithImages, // 连线图片全部作为参考图
        size: d.size || '16:9',
        count: d.count || 1,
        quality: d.quality,
        resolution: d.resolution || undefined,
        watermark_enabled: d.watermark,
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
        prompt: inputs.text || d.prompt || '',
        elements: [
          ...(d.ref_image ? [{ type: 'reference', name: '节点参考图', image_url: d.ref_image }] : []),
          ...elementsWithImages,
        ],
        image_url: refImage,
        size: d.size || '16:9',
        count: d.count || 1,
        quality: d.quality,
        watermark_enabled: d.watermark,
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
      // 新脸图之外的连线图片作为附加参考
      const extraRefs = linkedImageElements.filter(
        (e: any) => e.image_url !== faceImage && e.image_url !== d.ref_face)
      const payload = {
        prompt: inputs.text || d.prompt || '',
        video_url: refVideo,
        image_url: faceImage || undefined,
        elements: [
          ...(d.ref_face ? [{ type: 'reference', name: '新脸参考图', image_url: d.ref_face }] : []),
          ...extraRefs,
        ],
        size: d.size || '16:9',
        duration: d.duration || 5,
        resolution: d.resolution,
        quality: d.quality,
        watermark_enabled: d.watermark,
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
      // 第 1 张连线图作为首帧/驱动图；其余连线图作为附加参考（r2va 多图参考）
      const extraRefs = linkedImageElements.filter((e: any) => e.image_url !== inputs.image)
      const payload = {
        prompt: inputs.text || d.prompt || '',
        image_url: inputs.image,
        elements: extraRefs,
        size: d.size || '16:9',
        duration: d.duration || 5,
        resolution: d.resolution,
        quality: d.quality,
        watermark_enabled: d.watermark,
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
    case 'output':
      // 这三种节点不需要执行生成
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
    // prompt / material / output 不执行
    if (['prompt', 'material', 'output'].includes(nodeType)) return

    runningRef.current.add(nodeId)
    updateNodeData(nodeId, { _status: 'running', _errorMessage: undefined, _result: undefined })

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
