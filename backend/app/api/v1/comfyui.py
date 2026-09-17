"""ComfyUI 直连执行 API（M8 收尾）

路由:
- GET  /comfyui/queue                    队列查询(running/pending)
- POST /comfyui/execute                  提交工作流执行(工作流库按 id 取图, 占位符替换)
- GET  /comfyui/executions/{prompt_id}   单次执行结果(状态+输出图片)
- GET  /comfyui/view                     输出文件代理(防内网地址暴露)
- WS   /comfyui/progress                 进度推送(代理 ComfyUI WS 事件)

前置: settings.COMFYUI_ENABLED=true(未启用时 403, 不暴露半成品功能)。
"""
import json
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import User, ComfyUIWorkflow
from app.services import comfyui_exec
from app.services.comfyui_workflow import build_export

router = APIRouter()


class ComfyExecuteRequest(BaseModel):
    """提交执行: 工作流库 id + 占位符实参"""
    workflow_id: UUID
    inputs: dict = Field(default_factory=dict, description="占位符替换: prompt/negative/seed/width/height/model 等")


@router.get("/queue")
async def comfy_queue(
    current_user: User = Depends(get_current_user),
):
    """ComfyUI 队列查询(正在执行 + 排队中)"""
    return await comfyui_exec.get_queue()


@router.post("/execute")
async def comfy_execute(
    body: ComfyExecuteRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """提交工作流到 ComfyUI 执行。

    - 工作流从工作流库按 id 取（is_enabled 限制）
    - UI 格式自动转 API 执行格式（转换 warnings 一并返回）
    - inputs 替换 {{prompt}} 等占位符（未提供的原样保留）
    - 返回 prompt_id 与 client_id——前端用 WS /comfyui/progress 订阅进度
    """
    wf = (await db.execute(
        select(ComfyUIWorkflow).where(ComfyUIWorkflow.id == body.workflow_id)
    )).scalar_one_or_none()
    if wf is None:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("Workflow not found", resource="ComfyUIWorkflow")
    if not wf.is_enabled:
        from app.core.exceptions import BadRequestException
        raise BadRequestException("该工作流已停用")

    payload, warnings = build_export(wf.format, wf.graph, overrides=body.inputs or None)
    client_id = comfyui_exec.new_client_id()
    prompt_id = await comfyui_exec.submit_prompt(payload, client_id)
    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "warnings": warnings,
        "message": "已提交到 ComfyUI 队列",
    }


@router.get("/executions/{prompt_id}")
async def comfy_execution(
    prompt_id: str,
    current_user: User = Depends(get_current_user),
):
    """单次执行结果: 状态 + 输出图片(/view 代理 URL)"""
    return await comfyui_exec.get_history(prompt_id)


@router.get("/view")
async def comfy_view(
    filename: str,
    subfolder: str = "",
    type: str = "output",
    current_user: User = Depends(get_current_user),
):
    """代理 ComfyUI /view 输出文件（需登录, 防内网地址直接暴露）"""
    resp = await comfyui_exec.proxy_view(filename, subfolder, type)
    session = getattr(resp, "_session_holder", None)

    async def _stream():
        try:
            async for chunk in resp.content.iter_any():
                yield chunk
        finally:
            resp.close()
            if session:
                await session.close()

    media = resp.headers.get("Content-Type", "image/png")
    return StreamingResponse(_stream(), media_type=media)


@router.websocket("/progress")
async def comfy_progress(ws: WebSocket):
    """进度订阅 WS。

    握手: 前端连接 /api/v1/comfyui/progress?token=<JWT>&client_id=<execute 返回值>&prompt_id=<可选>
    服务端校验 token 后连接 ComfyUI WS 转发事件(文本 JSON);
    executing(node=null)/execution_error/execution_interrupted 时自动结束。
    """
    from app.core.security import decode_token

    await ws.accept()
    token = ws.query_params.get("token", "")
    try:
        payload = decode_token(token)
    except Exception:
        await ws.close(code=4401)
        return
    if not payload or payload.get("type") != "access" or not payload.get("sub"):
        await ws.close(code=4401)
        return

    client_id = ws.query_params.get("client_id") or comfyui_exec.new_client_id()
    prompt_id = ws.query_params.get("prompt_id") or None
    try:
        async for evt in comfyui_exec.iter_ws_events(client_id, prompt_id):
            await ws.send_text(json.dumps(evt, ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_text(json.dumps({"type": "ws_error", "data": {"reason": str(e)[:200]}}))
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
