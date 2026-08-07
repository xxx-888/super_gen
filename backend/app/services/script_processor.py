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
**重要：水印可能出现在剧本的任何位置（开头、结尾、每段之间、甚至每页页脚），必须全部删除。**
删除以下类型的内容（保留正文）：
- 水印/保密标记（如「麦芽涉密剧本·严禁网络传播或二次转发」「严禁外传」「XXX独家」等）
  这类水印经常在正文中间反复出现（每隔几段就有一行），必须逐行识别并删除
- 版权声明、平台广告、推广信息
- 页眉页脚中的重复标记
- 不属于剧情的元信息（如文件编号、审核标记）

## 任务 2：分集识别
判断剧本是否包含多集内容：
- 如果有多集（如「第1集」「第二集」「Episode 1」等标记），按集拆分
- 如果只有一集或无法判断，返回单个 episode

## 返回格式（严格 JSON）
```json
{
  "episodes": [
    {"title": "第1集", "content": "该集的完整剧本内容（已清理所有水印）"},
    {"title": "第2集", "content": "..."}
  ],
  "removed_lines": ["麦芽涉密剧本·严禁网络传播或二次转发"]
}
```

注意：
- episodes 数组至少包含 1 个元素
- content 必须是该集的完整剧本正文，不要截断，**水印必须全部清除**
- removed_lines 记录被删除的非正文内容（去重，只列不同内容的行；若无则为空数组）
- 如果原文就是干净的单一剧本，episodes 只有 1 个元素，removed_lines 为空
- **再次强调：像「麦芽涉密剧本·严禁网络传播或二次转发」这类水印会反复出现在正文中间，必须全部删除，不能遗漏**"""


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
        # 构造不带 thinking 模式的 LLM 客户端（剧本清理是简单任务，不需要推理，
        # 且 thinking 会占大量 max_tokens 导致 content 为空）
        import copy
        simple_llm = copy.copy(llm)
        simple_llm.extra_body = {}  # 清除 thinking/reasoning_effort 等透传参数
        result = await simple_llm.chat_with_json(messages, temperature=0.1, max_tokens=8192)

        if result is None:
            logger.warning("script_processor: LLM returned unparseable result, fallback")
            return _fallback(content)

        episodes = result.get("episodes", [])
        removed_lines = result.get("removed_lines", [])

        # 校验 episodes 格式
        if not isinstance(episodes, list) or len(episodes) == 0:
            logger.warning("script_processor: invalid episodes format, fallback")
            return _fallback(content)

        # 清洗每个 episode（含正则兜底清理水印）
        clean_episodes: List[Dict[str, str]] = []
        all_stripped_lines: List[str] = []
        for i, ep in enumerate(episodes):
            if not isinstance(ep, dict):
                continue
            ep_title = str(ep.get("title", "")).strip() or f"第{i + 1}集"
            ep_content = str(ep.get("content", "")).strip()
            if ep_content:
                # 正则兜底：清理 LLM 可能遗漏的水印行（如「麦芽涉密剧本·严禁网络传播或二次转发」）
                ep_content, stripped = _strip_watermark_lines(ep_content)
                all_stripped_lines.extend(stripped)
                clean_episodes.append({"title": ep_title, "content": ep_content})

        if not clean_episodes:
            return _fallback(content)

        # 合并 LLM 报告的删除行 + 正则兜底删除行（去重）
        reported = [str(l).strip() for l in removed_lines if str(l).strip()]
        for l in all_stripped_lines:
            if l not in reported:
                reported.append(l)
        removed_lines = reported

        logger.info(f"script_processor: AI processed {len(clean_episodes)} episodes, removed {len(removed_lines)} lines")
        return {
            "episodes": clean_episodes,
            "removed_lines": [str(l).strip() for l in removed_lines if str(l).strip()],
        }

    except Exception as e:
        logger.warning(f"script_processor: AI processing failed: {e}, fallback")
        return _fallback(content)


def _fallback(content: str) -> Dict[str, Any]:
    """降级：不做 AI 处理，返回原始内容（仍跑正则清理水印）。"""
    cleaned, stripped = _strip_watermark_lines(content)
    return {
        "episodes": [{"title": "完整剧本", "content": cleaned}],
        "removed_lines": stripped,
    }


# 水印/保密标记正则模式（兜底清理，不依赖 LLM）
# 匹配各种常见水印：麦芽涉密、严禁传播、独家首发、版权所有 等
import re as _re
_WATERMARK_PATTERNS = [
    _re.compile(r"麦芽涉密剧本.*?(?:传播|转发).*", _re.IGNORECASE),
    _re.compile(r"严禁(?:网络)?(?:传播|外传|转发|转载|复制).*", _re.IGNORECASE),
    _re.compile(r"(?:本作品|本文|本书).*(?:严禁|禁止|不得).*(?:传播|转载|转发|外传).*", _re.IGNORECASE),
    _re.compile(r"版权所有.*?侵权必究.*", _re.IGNORECASE),
    _re.compile(r"(?:独家|首发).*(?:授权|发布).*", _re.IGNORECASE),
]


def _strip_watermark_lines(text: str) -> tuple:
    """正则兜底清理水印行。返回 (清理后文本, 被删除的行列表)。

    逐行检查，整行匹配水印模式的删除，并压缩多余空行。
    """
    lines = text.split("\n")
    cleaned: List[str] = []
    stripped: List[str] = []
    for line in lines:
        trimmed = line.strip()
        is_watermark = False
        for pat in _WATERMARK_PATTERNS:
            if pat.search(trimmed):
                is_watermark = True
                break
        if is_watermark:
            if trimmed and trimmed not in stripped:
                stripped.append(trimmed)
            continue
        cleaned.append(line)
    # 压缩连续空行（水印删除后可能留下大片空行）
    result: List[str] = []
    blank_streak = 0
    for line in cleaned:
        if line.strip() == "":
            blank_streak += 1
            if blank_streak <= 2:
                result.append(line)
        else:
            blank_streak = 0
            result.append(line)
    return "\n".join(result).strip(), stripped
