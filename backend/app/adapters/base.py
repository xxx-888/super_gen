"""
Adapter Base - 适配器抽象基类与数据结构

所有具体适配器(placeholder/cloud_api/comfyui/local)都实现此接口.
任务层(tasks/*)只依赖此抽象, 不感知具体厂商.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any


@dataclass
class GenElement:
    """生成元素(角色/场景/物品/姿态/特效)"""
    type: str  # character/scene/prop/pose/effect
    name: str
    image_url: Optional[str] = None  # 参考图
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class GenInput:
    """生成请求统一输入"""
    prompt: str
    elements: List[GenElement] = field(default_factory=list)
    size: str = "16:9"            # 16:9/9:16/4:3/3:4
    count: int = 1               # 生成数量
    image_url: Optional[str] = None   # 图生视频/改创的输入图
    first_frame_url: Optional[str] = None  # 首尾帧-首帧
    last_frame_url: Optional[str] = None   # 首尾帧-尾帧
    video_url: Optional[str] = None  # 对口型/改视频的输入视频
    audio_url: Optional[str] = None  # 对口型/TTS 的输入音频
    text: Optional[str] = None       # TTS 的输入文本
    voice_id: Optional[str] = None   # TTS 音色
    duration: Optional[float] = None  # 视频时长(秒)
    extra: Dict[str, Any] = field(default_factory=dict)  # 模型特定参数


@dataclass
class GenResult:
    """生成结果"""
    urls: List[str] = field(default_factory=list)  # 输出文件 URL
    thumbnail_urls: List[str] = field(default_factory=list)
    duration: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    meta: Dict[str, Any] = field(default_factory=dict)
    success: bool = True
    error: Optional[str] = None
    credits_cost: int = 0  # 实际消耗积分(可覆盖预估)


class BaseAdapter(ABC):
    """AI 模型适配器抽象基类.

    子类只需实现实际生成方法; 不支持的能力返回 GenResult(success=False, error='not supported').
    """

    # 该适配器支持的能力
    SUPPORTS = {
        "text_to_image": False,
        "image_to_image": False,
        "fusion_generate": False,  # 融合生图(元素组合)
        "image_to_video": False,
        "first_last_frame": False,
        "lip_sync": False,         # 对口型
        "tts": False,
        "image_edit": False,
    }

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        """model_config: AIModel 序列化后的配置(name/endpoint/api_key/config等)"""
        self.config = model_config or {}

    @abstractmethod
    async def test_connection(self) -> bool:
        """测试连接是否正常."""
        ...

    def _unsupported(self, capability: str) -> GenResult:
        return GenResult(success=False, error=f"Capability '{capability}' not supported by {self.__class__.__name__}")

    # ==================== 生成能力(默认不支持, 子类按需实现) ====================

    async def text_to_image(self, inp: GenInput) -> GenResult:
        return self._unsupported("text_to_image")

    async def fusion_generate(self, inp: GenInput) -> GenResult:
        """融合生图: 角色+场景+物品+姿态+特效 组合生成."""
        return self._unsupported("fusion_generate")

    async def image_to_video(self, inp: GenInput) -> GenResult:
        """图生视频: 输入图片+描述 -> 视频."""
        return self._unsupported("image_to_video")

    async def first_last_frame_video(self, inp: GenInput) -> GenResult:
        """首尾帧生成视频."""
        return self._unsupported("first_last_frame")

    async def lip_sync(self, inp: GenInput) -> GenResult:
        """对口型: 视频+音频 -> 口型同步视频."""
        return self._unsupported("lip_sync")

    async def tts(self, inp: GenInput) -> GenResult:
        """语音合成: 文本 -> 音频."""
        return self._unsupported("tts")

    async def image_edit(self, inp: GenInput) -> GenResult:
        """图片改创."""
        return self._unsupported("image_edit")


# ==================== 接口日志工具 ====================
# 适配器把关键节点（提交/轮询/下载/成功/失败）的日志累积进 GenResult.meta["logs"]，
# 由 creation_service 在写 task.meta 时 merge 进数据库，供后台任务详情展示和调试。
# 格式：{time, level, stage, message, data?}，与已有 image_gen.py stub 的
# {time, level, message} 约定兼容（多了 stage/data 两个可选字段）。

# ==================== 日志脱敏 ====================
# 适配器记录日志时，payload 可能含超长字符串（典型：本地图片被转成
# data:image/png;base64,<几万字符> 的 data URI）。这些巨型字符串写进
# task.meta 后会导致 DB 存储/查询变慢、API 响应变大、前端渲染卡顿。
# 这里在日志写入的最底层统一拦截：超过阈值的字符串替换成截断占位。
# 同一个函数在 API 返回层（tasks.py）也会再跑一次，处理历史已入库数据。
_REDACT_THRESHOLD = 200       # 超过这个长度的字符串才截断（URL/task_id/错误消息都远小于此）
_REDACT_KEEP_HEAD = 80        # 截断后保留的前缀长度，方便辨认类型


def redact_large_strings(obj: Any, threshold: int = _REDACT_THRESHOLD) -> Any:
    """递归遍历 dict/list/tuple，把超长字符串替换成截断占位。

    - data URI（如 data:image/png;base64,xxxx）单独处理，保留 mime 前缀更易读。
    - 普通超长字符串保留头部，尾部标注省略了多少字符。
    - 其他类型（int/bool/None/...）原样返回。
    """
    if isinstance(obj, dict):
        return {k: redact_large_strings(v, threshold) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_large_strings(v, threshold) for v in obj]
    if isinstance(obj, tuple):
        return tuple(redact_large_strings(v, threshold) for v in obj)
    if isinstance(obj, str):
        total = len(obj)
        if total <= threshold:
            return obj
        # data URI 特殊处理：保留 mime + 编码标记，省略 base64 正文
        if obj.startswith("data:") and "," in obj:
            head = obj.split(",", 1)[0]  # 如 "data:image/png;base64"
            return f"{head},<已省略 base64 {total - len(head) - 1} 字符>"
        # 普通超长字符串：保留头部 + 标注省略总量
        return f"{obj[:_REDACT_KEEP_HEAD]}…<已省略 {total - _REDACT_KEEP_HEAD} 字符>"
    return obj


def redact_task_meta(meta: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """对 task.meta 里的 logs 做超长字符串脱敏（用于 API 返回历史已入库数据）。

    新任务的日志在写入时已由 make_log 脱敏，但 DB 里可能残留早期未脱敏的
    巨型 base64 字符串（如 MiniMax 提交日志里的图片 data URI）。这里在 API 返回前
    再跑一次 redact_large_strings，保证接口响应和前端展示都不卡。
    只脱敏 logs，其余 meta 字段（remote_task_id/adapter/...）原样保留。
    """
    if not meta:
        return meta or {}
    logs = meta.get("logs")
    if logs:
        new_meta = dict(meta)
        new_meta["logs"] = redact_large_strings(logs)
        return new_meta
    return meta


def make_log(
    level: str,
    stage: str,
    message: str,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """构造一条接口日志条目。

    Args:
        level:   info / warning / error
        stage:   submit / poll / download / refund / scene_writeback / ...
        message: 人类可读描述
        data:    可选的请求/响应摘要（如 payload、status_code、job_id），用于调试
    """
    entry: Dict[str, Any] = {
        "time": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "stage": stage,
        "message": message,
    }
    if data:
        # 写入前脱敏：截断 base64 / 超长字符串，避免 DB 膨胀和前端卡顿
        entry["data"] = redact_large_strings(data)
    return entry


def append_logs(
    meta: Optional[Dict[str, Any]],
    level: str,
    stage: str,
    message: str,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """往 meta 字典追加一条日志，返回新 meta（不修改原 dict 引用语义之外的内容）。

    用法：result = GenResult(success=True, meta=append_logs(result.meta, "info", "poll", "..."))
    """
    new_meta = dict(meta or {})
    logs = list(new_meta.get("logs") or [])
    logs.append(make_log(level, stage, message, data))
    new_meta["logs"] = logs
    return new_meta

