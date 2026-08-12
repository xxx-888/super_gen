/**
 * 节点组件注册表 - 把所有节点组件集中导出，供 React Flow nodeTypes 使用。
 */
import { PromptNode } from './PromptNode'
import { MaterialNode } from './MaterialNode'
import { ImageGenNode } from './ImageGenNode'
import { FusionGenNode } from './FusionGenNode'
import { VideoGenNode } from './VideoGenNode'
import { FirstLastFrameNode } from './FirstLastFrameNode'
import { LipSyncNode } from './LipSyncNode'
import { TTSNode } from './TTSNode'
import { OutputNode } from './OutputNode'

/** React Flow 的 nodeTypes 映射 */
export const canvasNodeTypes = {
  prompt: PromptNode,
  material: MaterialNode,
  imageGen: ImageGenNode,
  fusionGen: FusionGenNode,
  videoGen: VideoGenNode,
  firstLastFrame: FirstLastFrameNode,
  lipSync: LipSyncNode,
  tts: TTSNode,
  output: OutputNode,
}
