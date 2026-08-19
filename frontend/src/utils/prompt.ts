/**
 * Prompt 工具函数 - 处理提示词中 @引用 的显示转换
 *
 * 编辑器（PromptEditorLite）内部存储格式为模板语法 @{type:uuid:name}，
 * 而只读展示位（分镜列表、预览面板等）需要把它转成人类可读的 @名称。
 *
 * 该函数同时保留旧的裸 @名称 格式（向后兼容）。
 */

// 匹配 @{type:uuid:name} 模板格式（name 部分可含除 } 外的任意字符，也可缺失）
const TEMPLATE_RE = /@\{(\w+):([a-f0-9-]{36})(?::([^}]+))?\}/g

/**
 * 将提示词中的 @{type:uuid:name} 模板转换为人类可读的 @名称。
 * - 模板带 name：转为 @name
 * - 模板无 name（旧 @{type:uuid}）：转为 @type（无名称时退化为类型标识，避免露出 uuid）
 * - 裸 @名称：原样保留
 *
 * 例：
 *   '@{scene_bg:abc-123:京大报到处}'  →  '@京大报到处'
 *   '@{character:def-456:林夏} 冲出'   →  '@林夏 冲出'
 *
 * @param prompt 原始提示词（可能含模板）
 * @returns 人类可读的提示词（@引用显示为 @名称）
 */
export function renderPromptText(prompt: string | undefined | null): string {
  if (!prompt) return ''
  return prompt.replace(TEMPLATE_RE, (_match, _type, _uuid, name) => {
    return `@${name || _type}`
  })
}

/**
 * 截断提示词（先转可读文本再截断），用于列表/卡片等空间有限的展示位。
 *
 * @param prompt 原始提示词
 * @param maxLen 最大字符数（默认 50）
 * @returns 截断后的可读提示词，超出部分以 … 结尾
 */
export function truncatePromptText(
  prompt: string | undefined | null,
  maxLen = 50,
): string {
  const text = renderPromptText(prompt)
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

/**
 * 判断提示词里是否已引用某素材（@引用 双格式识别）。
 * 编辑器芯片序列化为 @{type:uuid:name} 模板，连线自动插入的是 @名称 裸名，
 * 去重判断必须两种形态都认，否则同一素材会被重复注入。
 */
export function promptHasMention(prompt: string | undefined | null, name: string): boolean {
  if (!prompt || !name) return false
  if (prompt.includes(`@${name}`)) return true
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@\\{\\w+:[a-f0-9-]{36}:${esc}\\}`).test(prompt)
}
