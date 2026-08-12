/**
 * useNodeModels - 画布节点加载可用模型的通用 hook
 *
 * 节点 mount 时调 creationService.models.list 加载对应类型的模型。
 * 只加载启用的模型（后端 /creation/models 只返回 is_enabled=true 的）。
 */
import { useState, useEffect } from 'react'
import { creationService } from '@/api/services'

export function useNodeModels(modelType: string) {
  const [models, setModels] = useState<any[]>([])
  useEffect(() => {
    let cancelled = false
    creationService.models.list({ type: modelType }).then((res: any) => {
      if (cancelled) return
      const list = Array.isArray(res) ? res : (res?.data ?? [])
      setModels(list)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [modelType])
  return models
}
