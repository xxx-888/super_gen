"""
Script Processor - AI 剧本预处理服务

功能：
1. 智能清理水印/版权声明/保密标记（如「麦芽涉密剧本·严禁网络传播或二次转发」）
2. AI 辅助分集识别（多集剧本自动拆分）

依赖 LLMClient，LLM 不可用时优雅降级（返回原始内容）。
"""
import logging
from typing import Dict, Any, List, Optional

from app.services.llm_client import LLMClient, LLMMessage

logger = logging.getLogger(__name__)

# 发给 LLM 的内容上限（避免超 token / 超时）
MAX_CONTENT_CHARS = 12000

SYSTEM_PROMPT = """你是一个专业的剧本预处理助手。请处理用户提供的剧本文本，完成以下任务：

## 任务 1：清理水印和无关标记
删除以下类型的内容（保留正文）：
- 水印/保密标记（如「麦芽涉密剧本·严禁网络传播或二次转发」「严禁外传」等）
- 版权声明、平台广告、推广信息
- 页眉页脚中的重复标记
- 不属于剧情的元信息（如文件编号、审核标记）

## 任务 2：分集识别
判断剧本是否包含多集内容：
- 如果有多集（如「第1集」「第2集」「第一集」「Episode 1」等标记），按集拆分
- 如果只有一集或无法判断，返回单个 episode

## 返回格式（严格 JSON）
```json
{
  "episodes": [
    {"title": "第1集", "content": "该集的完整剧本内容（已清理水印）"},
    {"title": "第2集", "content": "..."}
  ],
  "removed_lines": ["被删除的水印行1", "被删除的水印行2"]
}
```

注意：
- episodes 数组至少包含 1 个元素
- content 必须是该集的完整剧本正文，不要截断
- removed_lines 记录被删除的非正文内容（若无则为空数组）
- 如果原文就是干净的单一剧本，episodes 只有 1 个元素，removed_lines 为空"""


async def clean_and_split(content: str, llm: Optional[LLMClient]) -> Dict[str, Any]:
    """AI 清理水印 + 分集识别。

    Args:
        content: 原始剧本文本
        llm: LLM 客户端（None 或不可用时降级）

    Returns:
        {"episodes": [{"title","content"}...], "removed_lines": [...]}
        LLM 不可用时降级为 {episodes: [{title:"完整剧本", content: 原文}], removed_lines: []}
    """
    # 降级：LLM 不可用
    if llm is None or not llm.available:
        logger.info("script_processor: LLM not available, skip AI processing")
        return _fallback(content)

    # 内容太短不值得调 AI
    if len(content.strip()) < 50:
        return _fallback(content)

    # 截断超长内容（避免超 token）
    truncated = content[:MAX_CONTENT_CHARS]
    if len(content) > MAX_CONTENT_CHARS:
        truncated += "\n\n[... 内容过长，已截断 ...]"
        logger.info(f"script_processor: content truncated from {len(content)} to {MAX_CONTENT_CHARS}")

    try:
        messages = [
            LLMMessage(role="system", content=SYSTEM_PROMPT),
            LLMMessage(role="user", content=f"请处理以下剧本文本：\n\n{truncated}"),
        ]
        result = await llm.chat_with_json(messages, temperature=0.1, max_tokens=8192)

        if result is None:
            logger.warning("script_processor: LLM returned unparseable result, fallback")
            return _fallback(content)

        episodes = result.get("episodes", [])
        removed_lines = result.get("removed_lines", [])

        # 校验 episodes 格式
        if not isinstance(episodes, list) or len(episodes) == 0:
            logger.warning("script_processor: invalid episodes format, fallback")
            return _fallback(content)

        # 清洗每个 episode
        clean_episodes: List[Dict[str, str]] = []
        for i, ep in enumerate(episodes):
            if not isinstance(ep, dict):
                continue
            ep_title = str(ep.get("title", "")).strip() or f"第{i + 1}集"
            ep_content = str(ep.get("content", "")).strip()
            if ep_content:
                clean_episodes.append({"title": ep_title, "content": ep_content})

        if not clean_episodes:
            return _fallback(content)

        # 确保截断的内容只影响分集，不影响单集完整性
        # 如果只有1集且内容被截断过，用原始内容（避免丢失后半段）
        if len(clean_episodes) == 1 and len(content) > MAX_CONTENT_CHARS:
            clean_episodes[0]["content"] = content  # 用原文，只保留 AI 的清理效果不太行——这里折中
            # 实际上截断后 AI 只看到前半段，无法可靠清理全文。
            # 折中：标记为需要用户检查
            clean_episodes[0]["title"] = clean_episodes[0]["title"] + "（内容过长，建议检查）"

        logger.info(f"script_processor: AI processed {len(clean_episodes)} episodes, removed {len(removed_lines)} lines")
        return {
            "episodes": clean_episodes,
            "removed_lines": [str(l).strip() for l in removed_lines if str(l).strip()],
        }

    except Exception as e:
        logger.warning(f"script_processor: AI processing failed: {e}, fallback")
        return _fallback(content)


def _fallback(content: str) -> Dict[str, Any]:
    """降级：不做 AI 处理，返回原始内容。"""
    return {
        "episodes": [{"title": "完整剧本", "content": content}],
        "removed_lines": [],
    }
