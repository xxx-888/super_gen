"""OpenAI 兼容 TTS 适配器 - 文本生成语音

协议: POST {base_url}/audio/speech
  请求: {"model", "input", "voice", "response_format": "mp3", "speed"?}
  响应: 音频文件二进制流

兼容平台（在后台「配置模型」录入对应 endpoint/api_key/model 即可）:
- 硅基流动:    https://api.siliconflow.cn/v1  模型如 FunAudioLLM/CosyVoice2-0.5B、fishaudio/fish-speech-1.5
- OpenAI:      https://api.openai.com/v1      模型 tts-1 / tts-1-hd / gpt-4o-mini-tts，音色 alloy/echo/...
- Groq 等      同协议平台

生成结果落本地存储（/uploads/audio/...），返回本地 URL。
"""
import logging
from typing import Any, Dict, Optional

import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult, append_logs
from app.core.config import settings

logger = logging.getLogger(__name__)

# 单次合成文本上限（字符），各平台普遍支持到 5k+，留安全余量
_MAX_INPUT_CHARS = 4000


class OpenAITTSAdapter(BaseAdapter):
    """OpenAI 兼容协议的语音合成适配器。"""

    ADAPTER_NAME = "openai_tts"
    DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
    DEFAULT_MODEL = "FunAudioLLM/CosyVoice2-0.5B"

    SUPPORTS = {
        "text_to_image": False,
        "image_to_image": False,
        "fusion_generate": False,
        "image_to_video": False,
        "first_last_frame": False,
        "lip_sync": False,
        "tts": True,
        "image_edit": False,
    }

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        super().__init__(model_config)
        cfg = self.config or {}
        self.api_key = cfg.get("api_key") or getattr(settings, "OPENAI_API_KEY", None)
        base = cfg.get("endpoint") or cfg.get("base_url") or self.DEFAULT_BASE_URL
        # 容错：剥离误填的完整路径后缀
        base = base.rstrip("/")
        for suffix in ("/audio/speech",):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
        self.base_url = base.rstrip("/")
        cfg_inner = cfg.get("config") if isinstance(cfg.get("config"), dict) else {}
        self.model = cfg_inner.get("model") or cfg.get("model") or self.DEFAULT_MODEL
        self.default_voice = cfg_inner.get("voice") or "alloy"

    def _available(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def test_connection(self) -> bool:
        """GET /models 探测鉴权（非 401 即 Key 有效；个别平台未开放该端点也视为通过）。"""
        if not self._available():
            return False
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(f"{self.base_url}/models", headers=self._headers())
                return resp.status_code != 401
        except Exception as e:
            logger.warning(f"TTS test_connection error: {e}")
            return False

    async def tts(self, inp: GenInput) -> GenResult:
        """文本 → 语音。生成 MP3 落本地存储，返回本地 URL。"""
        if not self._available():
            return GenResult(success=False, error="TTS api_key not configured")
        text = (inp.text or inp.prompt or "").strip()
        if not text:
            return GenResult(success=False, error="TTS 需要输入文本")
        voice = inp.voice_id or self.default_voice
        payload: Dict[str, Any] = {
            "model": self.model,
            "input": text[:_MAX_INPUT_CHARS],
            "voice": voice,
            "response_format": "mp3",
        }
        if inp.extra.get("speed"):
            payload["speed"] = float(inp.extra["speed"])
        logs_meta: Dict[str, Any] = {"logs": []}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=180.0)) as client:
                resp = await client.post(
                    f"{self.base_url}/audio/speech", json=payload, headers=self._headers()
                )
            ctype = (resp.headers.get("content-type") or "").lower()
            if resp.status_code != 200 or "audio" not in ctype:
                err = resp.text[:300] if resp.status_code != 200 else f"非音频响应: {ctype}"
                return GenResult(
                    success=False,
                    error=f"TTS HTTP {resp.status_code}: {err}",
                    meta=append_logs(logs_meta, "error", "submit", f"合成失败: HTTP {resp.status_code}",
                                     {"endpoint": "/audio/speech", "model": self.model,
                                      "voice": voice, "response": err}),
                )
            data = resp.content
            from app.services.storage import get_storage_singleton
            storage = get_storage_singleton()
            stored = await storage.save(
                data=data, filename="tts.mp3", mime_type="audio/mpeg", category="audio",
            )
            logger.info(f"TTS generated {len(data)} bytes -> {stored.url} (model={self.model}, voice={voice})")
            logs_meta = append_logs(logs_meta, "info", "submit",
                                    f"语音合成成功: {len(data)} bytes",
                                    {"model": self.model, "voice": voice, "chars": len(text)})
            return GenResult(
                urls=[stored.url],
                meta={**logs_meta, "adapter": self.ADAPTER_NAME, "model": self.model,
                      "voice": voice, "bytes": len(data)},
            )
        except Exception as e:
            logger.error(f"TTS error: {e}", exc_info=True)
            return GenResult(
                success=False,
                error=f"TTS error: {e}",
                meta=append_logs(logs_meta, "error", "submit", f"合成异常: {e}"),
            )
