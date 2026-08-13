"""
LLM Client - 统一的大语言模型客户端封装

为 Agent 模式提供决策能力。设计目标:
- 优先从 AIModel 表读取 type='llm' 的配置（管理员可在后台配置）
- 回退到 settings.LLM_* 配置项
- 支持智谱 GLM（默认，国内友好）和 OpenAI 兼容接口
- 支持工具调用（function calling），用于 agent 的 plan-execute 循环
- 无可用 LLM 时降级为"基于规则"的兜底，保证骨架可演示

注意：当前项目未安装 zhipuai/openai SDK，这里用 httpx 直接调 OpenAI 兼容的
/chat/completions 接口（智谱 GLM 也提供 OpenAI 兼容端点），避免引入额外依赖。
"""
import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

logger = logging.getLogger(__name__)


# ==================== 类型定义 ====================
class LLMMessage(Dict[str, Any]):
    """聊天消息: {role: system/user/assistant/tool, content: str, tool_calls?: [...]}"""
    pass


def _fix_json_quoting(text: str) -> str:
    """
    修复常见的非标准 JSON 引号问题：
    1. 单引号 → 双引号（{'a':1} → {"a":1}）
    2. 无引号的 key → 加双引号（{a: 1} → {"a": 1}）
    3. 无引号的字符串值 → 加双引号（{a: foo} → {"a": "foo"}）
    只做粗粒度修复，不保证 100% 正确（最后还有 json.loads 校验兜底）。
    """
    import re

    # 1. 单引号字符串 → 双引号。处理转义的单引号和字符串内部的双引号。
    #    简化策略：把 '...' 包裹的 token 里的双引号转义，再把外层单引号换双引号。
    def _single_to_double(m: "re.Match") -> str:
        inner = m.group(1).replace('"', '\\"')
        return '"' + inner + '"'

    text = re.sub(r"'([^'\\]*(?:\\.[^'\\]*)*)'", _single_to_double, text)

    # 2. 无引号的 key：{ key:  或 , key: → {"key": （key 为标识符）
    text = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)', r'\1"\2"\3', text)

    # 3. 无引号的字符串值：: value 后跟 , } ]（value 是纯字母数字汉字组成的非布尔/非数字 token）
    bool_num = {"true", "false", "null"}
    def _quote_value(m: "re.Match") -> str:
        prefix = m.group(1)
        val = m.group(2).strip()
        if val.lower() in bool_num:
            return prefix + val
        # 已是数字/负数/小数，不加引号
        if re.fullmatch(r'-?\d+(\.\d+)?', val):
            return prefix + val
        return prefix + '"' + val + '"'

    # 值匹配：冒号后空格 + 值（直到遇到逗号/右括号，不含引号）
    text = re.sub(r'(:\s)([^",\]{}]+?)(\s*[,}\]])', _quote_value, text)

    return text


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """
    强力 JSON 提取器，处理 LLM 返回的各种格式问题：
    1. 纯 JSON
    2. ```json ... ``` 代码块包裹
    3. JSON 前后有说明文字
    4. 尾随逗号
    5. 被截断的不完整 JSON（尝试补全）
    6. 单引号 / 无引号 key（部分模型不严格遵守 JSON 规范）
    """
    import re

    # 1. 先尝试直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. 去掉 markdown 代码块标记
    cleaned = text
    if "```" in cleaned:
        # 提取 ```json ... ``` 或 ``` ... ``` 之间的内容
        blocks = re.findall(r'```(?:json)?\s*\n?(.*?)```', cleaned, re.DOTALL)
        if blocks:
            cleaned = blocks[0].strip()
            try:
                return json.loads(cleaned)
            except json.JSONDecodeError:
                pass

    # 3. 找第一个 { 到最后一个 } 之间的内容（JSON 前后有文字）
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        candidate = cleaned[first_brace:last_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
        # 尾随逗号修复
        fixed = re.sub(r',\s*}', '}', candidate)
        fixed = re.sub(r',\s*]', ']', fixed)
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            pass
        # 引号修复（单引号 / 无引号 key）—— 常见于部分国产模型
        try:
            return json.loads(_fix_json_quoting(candidate))
        except json.JSONDecodeError:
            pass
        result = _try_complete_json(candidate)
        if result is not None:
            return result

    # 3.5 如果有 { 但没有 }（截断），尝试补全
    if first_brace != -1 and last_brace == -1:
        candidate = cleaned[first_brace:]
        result = _try_complete_json(candidate)
        if result is not None:
            return result

    # 4. 如果以上都失败，尝试找到最后一个完整的 JSON 对象
    # 逐个 } 往前找
    for i in range(len(cleaned) - 1, -1, -1):
        if cleaned[i] == '}':
            start = cleaned.rfind('{', 0, i)
            if start != -1:
                candidate = cleaned[start:i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    fixed = re.sub(r',\s*}', '}', candidate)
                    fixed = re.sub(r',\s*]', ']', fixed)
                    try:
                        return json.loads(fixed)
                    except json.JSONDecodeError:
                        pass
                    try:
                        return json.loads(_fix_json_quoting(candidate))
                    except json.JSONDecodeError:
                        continue

    return None


def _try_complete_json(text: str) -> Optional[Dict[str, Any]]:
    """尝试补全被截断的 JSON（LLM 输出被 max_tokens 截断时）。"""
    import re
    # 策略1：直接在末尾补全括号（交替关闭，从内到外）
    open_braces = text.count('{') - text.count('}')
    open_brackets = text.count('[') - text.count(']')
    if open_braces > 0 or open_brackets > 0:
        candidate = text
        if candidate.count('"') % 2 != 0:
            candidate += '"'
        # 交替补全：每次补一个最内层的闭合符
        # 通过模拟栈来判断
        stack = []
        for ch in candidate:
            if ch in '{[':
                stack.append(ch)
            elif ch == '}' and stack and stack[-1] == '{':
                stack.pop()
            elif ch == ']' and stack and stack[-1] == '[':
                stack.pop()
        # 按栈逆序关闭
        closing = ''.join('}' if s == '{' else ']' for s in reversed(stack))
        candidate += closing
        candidate = re.sub(r',\s*}', '}', candidate)
        candidate = re.sub(r',\s*]', ']', candidate)
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # 策略2：回退到最后一个完整元素（逗号/右括号），截掉不完整部分
    for marker in [',', '}', ']', '"', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'e', 'E']:
        idx = text.rfind(marker)
        if idx > 0:
            truncated = text[:idx + 1].rstrip()
            # 去掉尾随逗号
            truncated = re.sub(r',\s*$', '', truncated)
            ob = truncated.count('{') - truncated.count('}')
            obr = truncated.count('[') - truncated.count(']')
            if ob > 0 or obr > 0:
                if truncated.count('"') % 2 != 0:
                    truncated += '"'
                truncated += '}' * max(ob, 0) + ']' * max(obr, 0)
                truncated = re.sub(r',\s*}', '}', truncated)
                truncated = re.sub(r',\s*]', ']', truncated)
                try:
                    return json.loads(truncated)
                except json.JSONDecodeError:
                    continue

    return None


class ToolDef(Dict[str, Any]):
    """工具定义: {name, description, parameters(JSON Schema)}"""
    pass


class LLMResponse:
    """LLM 响应的统一封装"""

    def __init__(self, content: str, tool_calls: Optional[List[Dict[str, Any]]] = None,
                 raw: Optional[Dict[str, Any]] = None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.raw = raw or {}

    @property
    def has_tool_call(self) -> bool:
        return len(self.tool_calls) > 0


# ==================== 超时 / 重试 ====================
def _build_timeout(timeout: int) -> httpx.Timeout:
    """
    把单一标量超时拆成多段，更贴合流式语义：
    - connect/pool/write 用较短上限，快速暴露网络问题；
    - read 用较长上限，表示「两次 chunk 之间」允许的最大间隔（流式下不会是整请求时长）。
    标量 timeout 仍向后兼容（不小于 30s 时作为 read 上限参考）。
    """
    total = max(int(timeout), 30) if timeout else 300
    # read 取 total，但单独的 connect/write/pool 给保守小值
    return httpx.Timeout(
        connect=15.0,
        read=float(total),
        write=30.0,
        pool=15.0,
    )


# 可重试的瞬时错误：超时、连接重置、读中断等。HTTP 状态错误（4xx/5xx）不在此列。
def _is_transient(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError, httpx.NetworkError)):
        return True
    # httpx.ConnectError / RemoteProtocolError / ReadError 等都是 TransportError 子类
    return isinstance(exc, httpx.HTTPError) and not isinstance(exc, httpx.HTTPStatusError)


def _trunc(s: Any, n: int = 300) -> str:
    """截断长文本用于日志（保留开头 + 总长度提示），避免整段剧本撑爆 meta。"""
    text = s if isinstance(s, str) else str(s)
    if len(text) <= n:
        return text
    return text[:n] + f"...(共{len(text)}字符,已截断)"


# ==================== 客户端 ====================
class LLMClient:
    """
    统一 LLM 客户端。

    使用 OpenAI 兼容的 /chat/completions 接口，兼容:
    - 智谱 GLM (https://open.bigmodel.cn/api/paas/v4/chat/completions)
    - OpenAI (https://api.openai.com/v1/chat/completions)
    - 任何 OpenAI 兼容服务 (通过 base_url + api_key)
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: int = 300,
        extra_body: Optional[Dict[str, Any]] = None,
        max_tokens: Optional[int] = None,
    ):
        self.api_key = api_key
        # 容错：剥离尾部的方法路径，只保留 base（如 .../paas/v4）
        _base = (base_url or "").rstrip("/")
        for suffix in ("/chat/completions", "/images/generations", "/videos/generations"):
            if _base.endswith(suffix):
                _base = _base[:-len(suffix)]
                break
        self.base_url = _base
        self.model = model or "glm-4-flash"  # 智谱免费档默认
        self.timeout = timeout  # 默认 300 秒（复杂剧本解析可能要 2-4 分钟）
        # 额外请求体参数（透传给上游 API）。用于支持各厂商专属能力，如：
        # DeepSeek 推理：{"thinking": {"type": "enabled"}, "reasoning_effort": "high"}
        # 这些参数会被原样合并进 /chat/completions 的 payload。
        self.extra_body = extra_body or {}
        # 输出 token 上限（后台模型配置 config.max_tokens 可调）。
        # 语义：只会「抬高」调用方请求的 max_tokens，不会调小——
        # 防止推理模型把输出额度耗在思考上导致正文为空。
        self.max_tokens = int(max_tokens) if max_tokens else None
        self._available = bool(api_key and base_url)
        # 对外调用的接口日志（真实请求参数/响应摘要），由调用方写入任务 meta.logs
        self.api_logs: List[Dict[str, Any]] = []

    def _log_api(self, level: str, stage: str, message: str,
                 data: Optional[Dict[str, Any]] = None) -> None:
        """累积一条接口日志到 self.api_logs（与适配器 meta.logs 条目结构一致）。"""
        entry: Dict[str, Any] = {
            "time": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "stage": stage,
            "message": message,
        }
        if data:
            entry["data"] = data
        self.api_logs.append(entry)
        # 上限 50 条，防止长会话累积过大
        if len(self.api_logs) > 50:
            self.api_logs = self.api_logs[-50:]

    @classmethod
    async def from_config(cls, db: Optional[AsyncSession] = None) -> "LLMClient":
        """
        按优先级构造客户端:
        1. AIModel 表 type='llm' 且 is_enabled 的最高优先级记录
        2. settings.LLM_* 配置项兜底
        """
        # 1. 尝试从 AIModel 表读取
        if db is not None:
            try:
                from app.models import AIModel
                result = await db.execute(
                    select(AIModel)
                    .where(AIModel.type == "llm", AIModel.is_enabled == True)
                    .order_by(AIModel.priority.desc())
                    .limit(1)
                )
                m = result.scalar_one_or_none()
                if m is not None:
                    cfg = m.config or {}
                    endpoint = m.endpoint or cfg.get("base_url") or ""
                    # 容错：用户可能填了完整路径（含 /chat/completions），剥离避免拼接重复
                    for suffix in ("/chat/completions", "/images/generations", "/videos/generations"):
                        if endpoint.endswith(suffix):
                            endpoint = endpoint[:-len(suffix)]
                            break
                    # model 名优先用 config.model，否则用 m.name
                    model_name = cfg.get("model") or m.name
                    # 提取透传的额外请求体参数（DeepSeek thinking/reasoning_effort 等）
                    extra: Dict[str, Any] = {}
                    for k in ("thinking", "reasoning_effort", "top_p", "frequency_penalty", "presence_penalty"):
                        if k in cfg:
                            extra[k] = cfg[k]
                    return cls(
                        api_key=m.api_key,
                        base_url=endpoint,
                        model=model_name,
                        timeout=cfg.get("timeout", 300),
                        extra_body=extra if extra else None,
                        max_tokens=cfg.get("max_tokens"),
                    )
            except Exception as e:
                logger.warning(f"Read AIModel(llm) failed, fallback to settings: {e}")

        # 2. 回退到 settings
        return cls(
            api_key=getattr(settings, "LLM_API_KEY", None),
            base_url=getattr(settings, "LLM_BASE_URL", None),
            model=getattr(settings, "LLM_MODEL", "glm-4-flash"),
            timeout=getattr(settings, "LLM_TIMEOUT", 300),
        )

    @property
    def available(self) -> bool:
        """是否配置了可用的 LLM（api_key + base_url 都存在）"""
        return self._available

    async def chat(
        self,
        messages: List[LLMMessage],
        tools: Optional[List[ToolDef]] = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        response_format: Optional[Dict[str, Any]] = None,
    ) -> LLMResponse:
        """
        发起一次 chat completion 请求。

        Args:
            messages: 消息列表
            tools: 工具定义（OpenAI function calling 格式）
            temperature: 采样温度
            max_tokens: 最大输出 token

        Returns:
            LLMResponse（含 content 和 tool_calls）

        Raises:
            RuntimeError: 当 LLM 不可用或请求失败时
        """
        if not self._available:
            raise RuntimeError(
                "LLM not configured. Set LLM_API_KEY/LLM_BASE_URL in settings "
                "or configure an AIModel with type='llm'."
            )

        # 输出上限：模型配置里的 max_tokens 只会抬高，不会调小调用方的请求
        effective_max_tokens = max(int(max_tokens), self.max_tokens or 0)

        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": effective_max_tokens,
            # 流式输出：长 JSON（如剧本解析 max_tokens=12000）非流式极易触发
            # ReadTimeout——整段响应未读完就被判超时。开 stream 后连接持续有
            # chunk 到达，read 超时退化为「两次 chunk 之间的间隔」，几乎不会触发。
            "stream": True,
        }
        # 工具定义（OpenAI tools 格式）
        if tools:
            payload["tools"] = [
                {"type": "function", "function": t} for t in tools
            ]
        # 透传厂商专属参数（如 DeepSeek 的 thinking/reasoning_effort）
        if self.extra_body:
            payload.update(self.extra_body)
        # JSON Output 模式（DeepSeek/OpenAI 等支持 response_format={'type':'json_object'}，
        # 强制模型输出合法 JSON；不支持的厂商会 400，由调用方去掉重试）
        if response_format:
            payload["response_format"] = response_format

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        url = f"{self.base_url}/chat/completions"

        # 记录真实请求参数（消息内容截断，避免整段剧本撑爆日志）
        self._log_api("info", "llm_request", f"POST {url}", {
            "model": self.model,
            "temperature": temperature,
            "max_tokens": effective_max_tokens,
            "response_format": response_format,
            "stream": True,
            "tools_count": len(tools) if tools else 0,
            "extra_body": self.extra_body or None,
            "messages": [
                {"role": (m.get("role") if isinstance(m, dict) else None),
                 "content": _trunc((m.get("content") if isinstance(m, dict) else "") or "", 300)}
                for m in (messages or [])
            ],
        })

        # 流式聚合 + 重试。瞬时错误（超时/连接重置）最多重试 2 次（共 3 次），
        # HTTP 4xx/5xx 立即抛出不重试。
        max_retries = 2
        last_exc: Optional[Exception] = None
        data: Optional[Dict[str, Any]] = None
        for attempt in range(max_retries + 1):
            try:
                data = await self._do_request(url, payload, headers)
                last_exc = None
                break
            except httpx.HTTPStatusError as e:
                # 业务层错误（鉴权失败/限流/参数错），重试无益
                logger.error(f"LLM HTTP error: {e.response.status_code} {e.response.text[:300]}")
                self._log_api("error", "llm_response", f"HTTP {e.response.status_code}", {
                    "status_code": e.response.status_code,
                    "body_preview": _trunc(e.response.text, 300),
                })
                raise RuntimeError(f"LLM request failed: HTTP {e.response.status_code}") from e
            except Exception as e:
                last_exc = e
                transient = _is_transient(e)
                if not transient or attempt >= max_retries:
                    logger.error(f"LLM request error (attempt {attempt + 1}): {e}")
                    self._log_api("error", "llm_response", f"request failed: {e}", {
                        "attempt": attempt + 1,
                    })
                    raise RuntimeError(f"LLM request failed: {e}") from e
                # 指数退避：1s, 2s
                backoff = 2 ** attempt
                logger.warning(
                    f"LLM transient error ({e}), retry {attempt + 1}/{max_retries} after {backoff}s"
                )
                self._log_api("warning", "llm_retry",
                              f"transient error, retry {attempt + 1}/{max_retries} after {backoff}s",
                              {"error": _trunc(e, 200)})
                await asyncio.sleep(backoff)

        # 理论上不会到这（上面要么 break 要么 raise），保险起见
        if last_exc is not None and data is None:  # pragma: no cover
            raise RuntimeError(f"LLM request failed: {last_exc}")

        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message", {})
        content = msg.get("content") or ""
        tool_calls = msg.get("tool_calls") or []
        # 记录真实响应摘要
        self._log_api("info", "llm_response", "OK", {
            "model": self.model,
            "finish_reason": choice.get("finish_reason"),
            "content_preview": _trunc(content, 500),
            "content_chars": len(content or ""),
            "reasoning_chars": data.get("_reasoning_chars"),
            "tool_calls_count": len(tool_calls),
            "usage": data.get("usage"),
        })
        # 规范化 tool_calls：解析 arguments JSON
        normalized_calls = []
        for tc in tool_calls:
            fn = tc.get("function", {})
            args_raw = fn.get("arguments", "{}")
            try:
                args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
            except json.JSONDecodeError:
                args = {"_raw": args_raw}
            normalized_calls.append({
                "id": tc.get("id"),
                "name": fn.get("name"),
                "arguments": args,
            })
        return LLMResponse(content=content, tool_calls=normalized_calls, raw=data)

    async def _do_request(
        self,
        url: str,
        payload: Dict[str, Any],
        headers: Dict[str, str],
    ) -> Dict[str, Any]:
        """
        执行单次请求。优先走 SSE 流式聚合；若上游不支持 stream（返回普通 JSON），
        自动回退为非流式解析。对外统一返回 OpenAI 的 choices 结构 dict。
        """
        timeout = _build_timeout(self.timeout)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                # 4xx/5xx：读取少量 body 供日志，然后抛 HTTPStatusError（由 chat() 决定不重试）
                if resp.status_code >= 400:
                    body = await resp.aread()
                    dummy = httpx.Response(
                        resp.status_code, headers=resp.headers, content=body,
                        request=resp.request,
                    )
                    raise httpx.HTTPStatusError(
                        f"HTTP {resp.status_code}", request=resp.request, response=dummy,
                    )
                content_type = resp.headers.get("content-type", "")
                # 流式：SSE (text/event-stream) 或请求了 stream —— 逐 chunk 聚合
                if "text/event-stream" in content_type or payload.get("stream"):
                    aggregated = await self._consume_sse(resp)
                    if aggregated is not None:
                        return aggregated
                # 上游忽略了 stream，返回完整 JSON —— 读出 body 走非流式分支
                raw = await resp.aread()
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    # 极少数网关把 SSE 放进普通 body，再试一次 SSE 解析
                    agg = self._parse_sse_text(raw.decode("utf-8", errors="ignore"))
                    if agg is not None:
                        return agg
                    raise
            # 流式上下文里的传输异常（超时/连接重置）会自然向上抛，由 chat() 决定是否重试

    async def _consume_sse(self, response: "httpx.Response") -> Optional[Dict[str, Any]]:
        """逐行读取 SSE 流，把增量 delta 聚合成与非流式等价的结构。

        支持 DeepSeek / OpenAI o1 等推理模型的流式格式：
        - delta.content：最终答案文本（剧本解析的 JSON 就在这里）
        - delta.reasoning_content：思考过程（DeepSeek thinking 模式，仅记录，不当作答案）
        推理阶段 content 为空是正常的，不能据此判定"空响应"。
        """
        content_buf: List[str] = []
        reasoning_buf: List[str] = []  # 推理过程（仅用于判断流是否真的空，不作为答案返回）
        # tool_calls 按 index 聚合：{index: {"id":..,"name":..,"arguments": ""}}
        tool_acc: Dict[int, Dict[str, Any]] = {}
        finish_reason: Optional[str] = None
        model_name: Optional[str] = None

        async for line in response.aiter_lines():
            line = line.strip()
            if not line or line.startswith(":"):  # 注释/心跳
                continue
            if not line.startswith("data:"):
                continue
            data_str = line[len("data:"):].strip()
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
            except json.JSONDecodeError:
                continue
            model_name = model_name or chunk.get("model")
            choices = chunk.get("choices") or []
            if not choices:
                continue
            choice = choices[0]
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]
            delta = choice.get("delta") or {}
            piece = delta.get("content")
            if piece:
                content_buf.append(piece)
            # DeepSeek 推理模型：思考过程走 reasoning_content，与 content 平级
            reasoning_piece = delta.get("reasoning_content")
            if reasoning_piece:
                reasoning_buf.append(reasoning_piece)
            for tc in delta.get("tool_calls") or []:
                idx = tc.get("index", 0)
                slot = tool_acc.setdefault(idx, {"id": None, "name": None, "arguments": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]

        # 真正"空响应"判定：content/tool_calls/reasoning 全都没有 且 没有 finish_reason。
        # 注意：推理模型如果只输出了 reasoning_content 没有 content（极端截断），
        # 也算收到了数据，返回给上层让 _extract_json 兜底，而不是当 None 丢弃。
        if not content_buf and not tool_acc and not reasoning_buf and finish_reason is None:
            return None

        tool_calls_out = [
            {
                "id": v.get("id"),
                "type": "function",
                "function": {"name": v.get("name") or "", "arguments": v.get("arguments") or ""},
            }
            for _, v in sorted(tool_acc.items())
        ]
        return {
            "id": "chatcmpl-stream",
            "object": "chat.completion",
            "model": model_name or self.model,
            # 诊断字段（仅内部使用，方便定位"content 为空但模型确实输出了思考"的情况）
            "_reasoning_chars": len("".join(reasoning_buf)),
            "choices": [
                {
                    "index": 0,
                    "finish_reason": finish_reason or "stop",
                    "message": {
                        "role": "assistant",
                        "content": "".join(content_buf),
                        "tool_calls": tool_calls_out if tool_calls_out else None,
                    },
                }
            ],
        }

    @staticmethod
    def _parse_sse_text(text: str) -> Optional[Dict[str, Any]]:
        """把一整段 SSE 文本（某些网关会把多条 data: 一次性返回）聚合成结构。

        同步版本，同样处理 DeepSeek 推理模型的 reasoning_content（避免推理阶段被误判为空）。
        """
        content_buf: List[str] = []
        reasoning_buf: List[str] = []
        finish_reason: Optional[str] = None
        model_name: Optional[str] = None
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            data_str = line[len("data:"):].strip()
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
            except json.JSONDecodeError:
                continue
            model_name = model_name or chunk.get("model")
            choices = chunk.get("choices") or []
            if choices:
                choice = choices[0]
                if choice.get("finish_reason"):
                    finish_reason = choice["finish_reason"]
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    content_buf.append(delta["content"])
                if delta.get("reasoning_content"):
                    reasoning_buf.append(delta["reasoning_content"])
        if not content_buf and not reasoning_buf and finish_reason is None:
            return None
        return {
            "id": "chatcmpl-stream",
            "object": "chat.completion",
            "model": model_name or "unknown",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": finish_reason or "stop",
                    "message": {"role": "assistant", "content": "".join(content_buf)},
                }
            ],
        }

    async def chat_with_json(
        self,
        messages: List[LLMMessage],
        temperature: float = 0.2,
        max_tokens: int = 2048,
        json_mode: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """
        请求 LLM 返回 JSON 并解析。容错处理各种格式问题：
        - ```json 代码块包裹
        - JSON 前后有说明文字
        - 尾随逗号
        - 被截断的不完整 JSON

        json_mode=True 时带 response_format={'type':'json_object'}（DeepSeek/OpenAI
        的 JSON Output 模式，强制合法 JSON）。注意：JSON 模式下模型有小概率返回
        空 content（DeepSeek 官方已知问题），调用方需自行兜底重试；
        不支持该参数的厂商返回 400 时会自动去掉参数重试一次。
        """
        if not self._available:
            return None
        try:
            try:
                resp = await self.chat(
                    messages, temperature=temperature, max_tokens=max_tokens,
                    response_format={"type": "json_object"} if json_mode else None,
                )
            except RuntimeError as e:
                # 厂商不支持 response_format（400 参数错）→ 去掉参数重试一次
                if json_mode and "HTTP 400" in str(e):
                    logger.warning(f"response_format 不被支持，去掉后重试: {e}")
                    resp = await self.chat(
                        messages, temperature=temperature, max_tokens=max_tokens,
                    )
                else:
                    raise
            text = resp.content.strip()
            if not text:
                logger.warning("chat_with_json: empty response")
                return None

            parsed = _extract_json(text)
            if parsed is not None:
                return parsed

            logger.warning(f"chat_with_json parse failed, raw text (first 200): {text[:200]}")
            return None
        except RuntimeError as e:
            logger.warning(f"chat_with_json: LLM request failed: {e}")
            return None
        except Exception as e:
            logger.warning(f"chat_with_json: unexpected error: {e}")
            return None
