"""
Cloud API Adapter 骨架 - 云端模型 API 适配器(预留)

后续接入具体厂商(星融/Kling/Runway/通义等)时实现 httpx 调用.
当前未在 factory 启用, 仅作骨架.
"""
from typing import Optional, Dict, Any
import httpx

from app.adapters.base import BaseAdapter, GenInput, GenResult


class CloudAPIAdapter(BaseAdapter):
    """云 API 适配器骨架.

    config 示例: {"endpoint": "...", "api_key": "...", "vendor": "jurilu|kling|runway"}
    """

    SUPPORTS = {k: True for k in BaseAdapter.SUPPORTS}

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        super().__init__(model_config)
        self.endpoint = self.config.get("endpoint")
        self.api_key = self.config.get("api_key")
        self.vendor = self.config.get("config", {}).get("vendor", "generic")
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.endpoint,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=120,
            )
        return self._client

    async def test_connection(self) -> bool:
        # TODO: 实现厂商特定的健康检查
        if not self.endpoint or not self.api_key:
            return False
        # 占位: 返回 True(实际应调用 /health 或 auth/test)
        return True

    async def text_to_image(self, inp: GenInput) -> GenResult:
        # TODO: 按 vendor 实现
        # client = await self._get_client()
        # resp = await client.post("/v1/text2image", json={...})
        raise NotImplementedError("CloudAPIAdapter.text_to_image 待实现 - 请在 factory 临时回退到 placeholder")

    # 其余方法同样待实现...
