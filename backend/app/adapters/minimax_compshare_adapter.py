"""
MiniMax H3 视频生成适配器 - 优云智算(CompShare) ModelVerse 渠道

API 文档: https://www.compshare.cn/docs/modelverse/models/video_api/minimax-h3-video-api

接口协议与 MiniMax 官方 /v2 视频接口完全一致（提交/查询路径、content 结构、
状态机 queued/running/succeeded/failed/cancelled 均相同），因此直接继承
MinimaxAdapter，仅覆盖渠道差异：
- base_url: https://cp.compshare.cn/minimax（API Key 为优云智算平台的 sk-ml- 密钥）
- resolution 仅开放 768P（2K 档会被 API 以参数错误拒绝）→ 一律映射 768P
- aigc_watermark 仅支持 false → 强制不带水印
- 文本提示词合并上限 5000 字符（官方 7000）
- 支持取消任务: DELETE /v2/video_generation/{task_id}（官方无公开取消接口）

使用方式: 后台「配置模型」添加 provider=minimax_compshare 的图生视频模型，
endpoint 填 https://cp.compshare.cn/minimax，api_key 填优云智算的 API Key。
"""
import logging
from typing import Any, Dict, Optional

import httpx

from app.adapters.minimax_adapter import MinimaxAdapter

logger = logging.getLogger(__name__)


class MinimaxCompshareAdapter(MinimaxAdapter):
    """MiniMax H3 视频生成适配器（优云智算 CompShare 渠道）。"""

    ADAPTER_NAME = "minimax_compshare"
    DEFAULT_BASE_URL = "https://cp.compshare.cn/minimax"
    MAX_PROMPT_CHARS = 5000
    FORCE_WATERMARK_FALSE = True
    # 实测（2026-08-18）：该渠道对任意 URL（含公网直链）的 reference_video 一律
    # 返回 RetCode 230 "Params [reference URL] not available"（参数未实现；
    # 图片 URL 参考可正常服务端下载），故禁发视频/音频参考，自动跳过并警告。
    SUPPORTS_REFERENCE_MEDIA = False

    def __init__(self, model_config: Optional[Dict[str, Any]] = None):
        super().__init__(model_config)
        # 容错：只填了平台主站域名（如 https://cp.compshare.cn）时补上 /minimax 前缀，
        # 避免拼接出 https://cp.compshare.cn/v2/... 这种不存在的路径
        if "compshare.cn" in self.base_url and not self.base_url.rstrip("/").endswith("/minimax"):
            self.base_url = self.base_url.rstrip("/") + "/minimax"

    def _map_resolution(self, resolution: str) -> str:
        # 该渠道仅开放 768P；2K 等其他档位会被 API 以参数错误拒绝
        return "768P"

    async def cancel_task(self, remote_task_id: str) -> bool:
        """取消远端任务: DELETE /v2/video_generation/{task_id}。

        已被执行节点领取的任务，首次取消响应里的 status 可能仍为 running，
        需以单任务查询轮询到 cancelled 为准；这里尽力而为（HTTP 非 4xx/5xx
        即认为已受理），本地任务状态由 tasks.cancel_task 端点负责。
        """
        url = f"{self.base_url}/v2/video_generation/{remote_task_id}"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.delete(url, headers=self._headers())
            try:
                body = resp.json()
            except Exception:
                body = {"raw": (resp.text or "")[:200]}
            ok = resp.status_code < 400
            logger.info(f"[MinimaxCompshare] cancel {remote_task_id}: "
                        f"HTTP {resp.status_code} {body}")
            return ok
        except Exception as e:
            logger.warning(f"[MinimaxCompshare] cancel {remote_task_id} failed: {e}")
            return False
