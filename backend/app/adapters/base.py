"""
Adapter Base - 适配器抽象基类与数据结构

所有具体适配器(placeholder/cloud_api/comfyui/local)都实现此接口.
任务层(tasks/*)只依赖此抽象, 不感知具体厂商.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
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
