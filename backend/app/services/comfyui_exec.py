"""ComfyUI 直连执行服务（M8 收尾）

补齐工作流库「可执行」的最后一公里：
- submit_prompt:   POST /prompt 提交 API 格式 graph（带 client_id 关联 WS 进度）
- get_queue:       GET /queue 队列查询（running + pending）
- get_history:     GET /history/{prompt_id} 执行结果（状态 + 输出图片）
- iter_ws_events:  连接 ComfyUI /ws 转发进度事件（status/progress/execution_*）

服务端点来源: settings.COMFYUI_API_URL（默认 http://127.0.0.1:8188），
COMFYUI_ENABLED=False 时 API 层直接 403（部署未接 ComfyUI 的环境不暴露）。
"""
import asyncio
import json
import logging
import uuid as _uuid
from typing import Any, AsyncIterator, Dict, List, Optional

import aiohttp

from app.core.config import settings
from app.core.exceptions import BadRequestException, ServiceUnavailableException

logger = logging.getLogger(__name__)

TIMEOUT_SUBMIT = 15
TIMEOUT_POLL = 15


def base_url() -> str:
    return (settings.COMFYUI_API_URL or "http://127.0.0.1:8188").rstrip("/")


def ensure_enabled() -> None:
    if not getattr(settings, "COMFYUI_ENABLED", False):
        raise ServiceUnavailableException(
            "ComfyUI 直连未启用：请在 .env 配置 COMFYUI_ENABLED=true 与 COMFYUI_API_URL")


def new_client_id() -> str:
    return str(_uuid.uuid4())


async def submit_prompt(api_graph: Dict[str, Any], client_id: str) -> str:
    """提交工作流到 ComfyUI /prompt 队列, 返回 prompt_id。"""
    ensure_enabled()
    url = f"{base_url()}/prompt"
    payload = {"prompt": api_graph, "client_id": client_id}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=TIMEOUT_SUBMIT)) as s:
            async with s.post(url, json=payload) as resp:
                body = await resp.json(content_type=None)
                if resp.status != 200 or body.get("error"):
                    msg = body.get("error") or body.get("message") or f"HTTP {resp.status}"
                    # node_errors 带出第一个可读错误, 便于前端定位工作流问题
                    node_errors = body.get("node_errors") or {}
                    if node_errors:
                        first = next(iter(node_errors.items()))
                        msg = f"{msg}; 节点 {first[0]}: {json.dumps(first[1], ensure_ascii=False)[:200]}"
                    raise BadRequestException(f"ComfyUI 提交失败: {msg}")
                return body["prompt_id"]
    except (BadRequestException, ServiceUnavailableException):
        raise
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        logger.error(f"[ComfyUI] 提交失败({url}): {e}")
        raise ServiceUnavailableException(f"ComfyUI 服务不可达: {base_url()}")


async def get_queue() -> Dict[str, Any]:
    """队列查询: running/pending 摘要（剥离完整 graph, 只留 id/提示元信息）。"""
    ensure_enabled()
    url = f"{base_url()}/queue"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=TIMEOUT_POLL)) as s:
            async with s.get(url) as resp:
                data = await resp.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        logger.error(f"[ComfyUI] 队列查询失败: {e}")
        raise ServiceUnavailableException(f"ComfyUI 服务不可达: {base_url()}")

    def _brief(entry: List[Any]) -> Dict[str, Any]:
        # entry 结构: [number, prompt_id, prompt_graph, extra_data, outputs_to_execute]
        return {
            "prompt_id": entry[1] if len(entry) > 1 else None,
            "number": entry[0] if entry else None,
        }

    return {
        "queue_running": [_brief(e) for e in data.get("queue_running", [])],
        "queue_pending": [_brief(e) for e in data.get("queue_pending", [])],
        "running": len(data.get("queue_running", [])),
        "pending": len(data.get("queue_pending", [])),
    }


async def get_history(prompt_id: str) -> Dict[str, Any]:
    """单次执行结果: 状态(完成/失败/排队中) + 输出图片(/view 访问 URL)。"""
    ensure_enabled()
    url = f"{base_url()}/history/{prompt_id}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=TIMEOUT_POLL)) as s:
            async with s.get(url) as resp:
                data = await resp.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        logger.error(f"[ComfyUI] history 查询失败: {e}")
        raise ServiceUnavailableException(f"ComfyUI 服务不可达: {base_url()}")

    entry = (data or {}).get(prompt_id)
    if not entry:
        # 尚不在 history → 可能在排队/执行中, 附队列位置
        q = await get_queue()
        where = "running" if any(x["prompt_id"] == prompt_id for x in q["queue_running"]) \
            else ("pending" if any(x["prompt_id"] == prompt_id for x in q["queue_pending"]) else "unknown")
        return {"prompt_id": prompt_id, "status": where, "outputs": [], "images": []}

    status_info = entry.get("status") or {}
    status_str = status_info.get("status_str") or ("completed" if entry.get("outputs") else "unknown")
    outputs: Dict[str, Any] = entry.get("outputs") or {}
    images: List[Dict[str, str]] = []
    for _node_id, out in outputs.items():
        for img in out.get("images", []):
            images.append({
                "filename": img.get("filename"),
                "subfolder": img.get("subfolder", ""),
                "type": img.get("type", "output"),
                "url": view_url(img.get("filename", ""), img.get("subfolder", ""), img.get("type", "output")),
            })
    if status_info.get("completed") is False and status_info.get("status_str") == "error":
        status_str = "error"
    return {
        "prompt_id": prompt_id,
        "status": status_str,  # success/completed/error/running/pending
        "completed": bool(status_info.get("completed")),
        "messages_tail": (status_info.get("messages") or [])[-3:],
        "outputs": outputs,
        "images": images,
    }


def view_url(filename: str, subfolder: str = "", image_type: str = "output") -> str:
    """生成 /view 输出文件访问 URL（由本服务代理, 见 proxy_view）。"""
    from urllib.parse import urlencode
    q = urlencode({"filename": filename, "subfolder": subfolder, "type": image_type})
    return f"/api/v1/comfyui/view?{q}"


async def proxy_view(filename: str, subfolder: str = "", image_type: str = "output") -> aiohttp.ClientResponse:
    """代理 ComfyUI /view 文件流（避免直连内网地址暴露）。"""
    ensure_enabled()
    from urllib.parse import urlencode
    url = f"{base_url()}/view?{urlencode({'filename': filename, 'subfolder': subfolder, 'type': image_type})}"
    session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60))
    try:
        resp = await session.get(url)
        if resp.status != 200:
            await resp.release()
            await session.close()
            raise BadRequestException("ComfyUI 输出文件不存在或已被清理")
        resp._session_holder = session  # 调用方读完流后需 close
        return resp
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        await session.close()
        raise ServiceUnavailableException(f"ComfyUI 服务不可达: {base_url()}")


async def iter_ws_events(client_id: str, prompt_id: Optional[str] = None) -> AsyncIterator[Dict[str, Any]]:
    """连接 ComfyUI WS, 转发文本帧事件(二进制预览帧跳过)。

    事件类型: status / execution_start / executing / progress / executed /
    execution_error / execution_interrupted。
    prompt_id 传入时只转发该任务相关事件 + 全局 status。
    """
    ensure_enabled()
    ws_url = f"{base_url().replace('http', 'ws', 1)}/ws?clientId={client_id}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_close=30)) as s:
            async with s.ws_connect(ws_url, heartbeat=25) as ws:
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue  # 二进制为 latent 预览帧, 不转发
                    try:
                        evt = json.loads(msg.data)
                    except (ValueError, TypeError):
                        continue
                    data = evt.get("data") or {}
                    if prompt_id and data.get("prompt_id") not in (prompt_id, None):
                        continue
                    yield evt
                    # 执行结束(成功或失败)即断开, 释放连接
                    if evt.get("type") in ("executing",) and data.get("node") is None:
                        return
                    if evt.get("type") in ("execution_error", "execution_interrupted"):
                        return
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        logger.warning(f"[ComfyUI] WS 连接断开: {e}")
        yield {"type": "ws_closed", "data": {"reason": f"ComfyUI WS 断开: {e}"}}
