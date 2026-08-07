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


async def clean_and_split(content: str, llm: Optional[LLMClient]) -> Dict[str, Any]:
    """AI 清理水印 + 正则分集识别。

    分两步执行：
    1. LLM 只负责清理水印（不回显全文，输出 token 少，不超限）
    2. 正则识别分集标记（第一集/第二集/数字行等），在 Python 里切割

    这样既利用了 AI 的语义理解能力清理水印，又用确定性的正则做分集，
    避免了「让 LLM 回显全文导致 token 超限/分集失败」的问题。
    """
    # 第一步：清理水印（正则先跑，LLM 兜底）
    cleaned_content, stripped_lines = _strip_watermark_lines(content)

    if llm is not None and llm.available and len(cleaned_content.strip()) >= 50:
        try:
            import copy
            simple_llm = copy.copy(llm)
            simple_llm.extra_body = {}
            cleaned_content, llm_stripped = await _llm_clean_watermark(cleaned_content, simple_llm)
            for l in llm_stripped:
                if l not in stripped_lines:
                    stripped_lines.append(l)
        except Exception as e:
            logger.warning(f"script_processor: LLM watermark cleanup failed: {e}, using regex-only result")

    # 第二步：正则分集
    episodes = _split_episodes(cleaned_content)

    logger.info(f"script_processor: {len(episodes)} episodes, removed {len(stripped_lines)} watermark lines")
    return {
        "episodes": episodes,
        "removed_lines": stripped_lines,
    }


async def _llm_clean_watermark(content: str, llm: "LLMClient") -> tuple:
    """让 LLM 清理水印，只返回清理后的文本 + 被删除的行（不回显全文）。

    用一个精巧的 prompt：只输出被删除的行号，Python 端按行号删除。
    这样输出 token 极少（只输出数字），不会超限。
    """
    lines = content.split("\n")
    # 给每行编号，让 LLM 判断哪些行是水印
    numbered = "\n".join(f"[{i}] {line}" for i, line in enumerate(lines))
    # 截断（超长内容只处理前半段，后半段水印交给正则）
    if len(numbered) > MAX_CONTENT_CHARS:
        numbered = numbered[:MAX_CONTENT_CHARS]

    prompt = """你是水印清理助手。下面是带行号的剧本文本。请找出所有水印行（保密标记、版权声明、广告推广等非正文内容）。

只返回 JSON：{"watermark_lines": [行号1, 行号2, ...]}
不要返回剧本内容，只返回水印行的行号。如果没有任何水印行，返回 {"watermark_lines": []}。"""

    messages = [
        LLMMessage(role="system", content=prompt),
        LLMMessage(role="user", content=numbered),
    ]
    result = await llm.chat_with_json(messages, temperature=0.0, max_tokens=2048)
    if result is None:
        return content, []

    wm_indices = result.get("watermark_lines", [])
    if not isinstance(wm_indices, list):
        wm_indices = []

    # 按行号删除
    wm_set = set()
    for idx in wm_indices:
        try:
            wm_set.add(int(idx))
        except (ValueError, TypeError):
            continue

    if not wm_set:
        return content, []

    kept_lines = []
    stripped = []
    for i, line in enumerate(lines):
        if i in wm_set:
            if line.strip() and line.strip() not in stripped:
                stripped.append(line.strip())
        else:
            kept_lines.append(line)

    cleaned = "\n".join(kept_lines)
    # 压缩空行
    cleaned = _compress_blank_lines(cleaned)
    return cleaned, stripped


def _fallback(content: str) -> Dict[str, Any]:
    """降级：不做 AI 处理，返回原始内容（仍跑正则清理水印 + 分集）。"""
    cleaned, stripped = _strip_watermark_lines(content)
    episodes = _split_episodes(cleaned)
    return {
        "episodes": episodes,
        "removed_lines": stripped,
    }


def _compress_blank_lines(text: str) -> str:
    """压缩连续空行，最多保留 2 个。"""
    lines = text.split("\n")
    result: List[str] = []
    blank_streak = 0
    for line in lines:
        if line.strip() == "":
            blank_streak += 1
            if blank_streak <= 2:
                result.append(line)
        else:
            blank_streak = 0
            result.append(line)
    return "\n".join(result).strip()


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
    """正则兜底清理水印行。返回 (清理后文本, 被删除的行列表)。"""
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
    return _compress_blank_lines("\n".join(cleaned)), stripped


# 分集标记正则：匹配「第一集」「第1集」「第二集」等中文数字集
# 注意：行必须是「第X集」本身（最多后跟冒号/空格/集名），不能匹配「第五集内容...」这种正文行
_EPISODE_CN = _re.compile(r"^第[一二三四五六七八九十百千零〇\d]+集(?:[\s:：、].*)?$")
# 匹配「第1章」「第一节」等变体
_EPISODE_CHAPTER = _re.compile(r"^第[一二三四五六七八九十百千零〇\d]+(?:章|节|回|话)")
# 匹配纯数字行（如「5」「10」单独一行作为集号）
_EPISODE_NUM = _re.compile(r"^(\d{1,3})$")
# 匹配「Episode 1」「EP1」


_CN_NUM_MAP = {'零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
               '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}


def _cn_to_num(s: str) -> int:
    """中文数字转 int（支持 一~九十九、十X、X十、X十X、百 等）。"""
    if s.isdigit():
        return int(s)
    if s in _CN_NUM_MAP:
        return _CN_NUM_MAP[s]
    # 十X (十一~十九)
    if s.startswith('十'):
        if len(s) == 1:
            return 10
        return 10 + _cn_to_num(s[1:])
    # X十 / X十X
    if '十' in s:
        parts = s.split('十')
        tens = _cn_to_num(parts[0]) if parts[0] else 1
        ones = _cn_to_num(parts[1]) if len(parts) > 1 and parts[1] else 0
        return tens * 10 + ones
    # 百量级（简陋支持）
    if '百' in s:
        parts = s.split('百')
        hundreds = _cn_to_num(parts[0]) if parts[0] else 1
        rest = 0
        if len(parts) > 1 and parts[1]:
            rest = _cn_to_num(parts[1])
        return hundreds * 100 + rest
    return 0
_EPISODE_EN = _re.compile(r"^(?:Episode|EP|ep)\s*(\d+)", _re.IGNORECASE)


def _split_episodes(content: str) -> List[Dict[str, str]]:
    """正则识别分集标记，把剧本按集拆分。

    支持的格式：
    - 第一集 / 第1集 / 第二集（中文集号）
    - 第一章 / 第一节 / 第一回（章节标记）
    - Episode 1 / EP1（英文标记）
    - 纯数字行（5 / 10 等单独成行的集号）

    如果没有识别到任何分集标记，返回整个内容作为一个 episode。
    """
    lines = content.split("\n")
    # 找到所有分集标记的行号 + 标题
    markers: List[tuple] = []  # [(line_index, title), ...]
    last_ep_num = 0  # 追踪上一个集号，用于验证纯数字行是否连续
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if _EPISODE_CN.match(stripped):
            # 从「第X集」中提取数字用于序列追踪
            import re as _re2
            cn_num_match = _re2.search(r'第([一二三四五六七八九十百千零〇\d]+)集', stripped)
            if cn_num_match:
                last_ep_num = _cn_to_num(cn_num_match.group(1))
            markers.append((i, stripped[:20]))
        elif _EPISODE_CHAPTER.match(stripped):
            markers.append((i, stripped[:20]))
        elif _EPISODE_EN.match(stripped):
            markers.append((i, stripped[:20]))
        elif _EPISODE_NUM.match(stripped):
            num = int(stripped)
            # 纯数字行：当数字是「上一个集号+1」或前一行是空行时识别为集号
            # （解决 PDF 导出时集号前无空行的问题，如对话行紧跟「5」）
            prev_blank = i == 0 or not lines[i - 1].strip()
            is_sequential = num == last_ep_num + 1  # 紧接上一集
            if prev_blank or is_sequential:
                markers.append((i, f"第{stripped}集"))
                last_ep_num = num

    if len(markers) <= 1:
        # 无分集标记或只有1个 → 整体作为一个 episode
        return [{"title": "完整剧本", "content": content.strip()}]

    # 按标记切割
    episodes: List[Dict[str, str]] = []
    for idx, (start_line, title) in enumerate(markers):
        end_line = markers[idx + 1][0] if idx + 1 < len(markers) else len(lines)
        # 标题行本身不算入内容（除非标题行后面紧跟的是正文而非空行）
        ep_lines = lines[start_line:end_line]
        # 第一行是标记本身，去掉它（但保留标题后面的内容）
        if len(ep_lines) > 1:
            ep_content = "\n".join(ep_lines[1:]).strip()
        else:
            ep_content = ""
        if ep_content:
            episodes.append({"title": title, "content": ep_content})

    # 如果某些集内容为空（标题行后面直接是下一个标题），跳过
    episodes = [ep for ep in episodes if ep["content"]]
    if not episodes:
        return [{"title": "完整剧本", "content": content.strip()}]

    return episodes
