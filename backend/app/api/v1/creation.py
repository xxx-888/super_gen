"""
Creation API - AI 创作工作流接口 (M5)

路由前缀: /creation
端点(对标目标网站创作面板):
- POST /fusion          融合生图(元素组合)
- POST /image-to-video  图生视频
- POST /first-last-frame 首尾帧生成视频
- POST /lip-sync        对口型
- POST /tts             语音合成
- POST /image-edit      图片改创
- POST /clip/{scene_id}/generate  分镜创作(集内)

每个端点: 参数校验 -> verify_credits -> 创建任务 -> 调适配器 -> 返回结果
"""
import logging
from uuid import UUID
from typing import Optional, Dict, Any, List
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.api.deps import get_current_org
from app.models import User, Organization, AIModel, PromptTemplate
from app.schemas import CreationRequest
from app.services import creation_service

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/models")
async def list_available_models(
    type: Optional[str] = Query(None, description="按类型筛选: text_to_image/image_to_video/tts/asr"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取当前可用的 AI 模型列表（所有登录用户可访问，用于生成时选择模型）。

    与 admin 端的 GET /admin/models 区别：
    - 这里只需 get_current_user（普通用户即可），不需要 admin 权限
    - 只返回已启用的模型
    - 脱敏：不返回 api_key（避免泄露密钥给普通用户）
    """
    stmt = select(AIModel).where(AIModel.is_enabled == True)  # noqa: E712
    if type:
        stmt = stmt.where(AIModel.type == type)
    stmt = stmt.order_by(AIModel.priority.desc(), AIModel.created_at.desc())
    result = await db.execute(stmt)
    models = result.scalars().all()
    return [{
        "id": m.id,
        "name": m.name,
        "type": m.type,
        "provider": m.provider,
        "config": m.config or {},
        "priority": m.priority,
        "description": m.description,
        # 不返回 api_key/endpoint（脱敏）
    } for m in models]


@router.get("/prompt-templates")
async def list_available_prompt_templates(
    category: Optional[str] = Query(None, description="按分类筛选: script_parse/shot_generate/..."),
    mode: Optional[str] = Query(None, description="按子模式筛选"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取可用的提示词模板列表（所有登录用户可访问，用于解析/生成时选择模板）。

    与 admin 端的 GET /admin/prompt-templates 区别：
    - 只需 get_current_user，不需要 admin 权限
    - 只返回已启用的模板
    """
    stmt = select(PromptTemplate).where(PromptTemplate.is_enabled == True)  # noqa: E712
    if category:
        stmt = stmt.where(PromptTemplate.category == category)
    if mode:
        stmt = stmt.where(PromptTemplate.mode == mode)
    stmt = stmt.order_by(PromptTemplate.is_default.desc(), PromptTemplate.priority.desc(), PromptTemplate.created_at.desc())
    result = await db.execute(stmt)
    templates = result.scalars().all()
    return [{
        "id": t.id,
        "name": t.name,
        "category": t.category,
        "mode": t.mode,
        "content": t.content,
        "description": t.description,
        "is_default": t.is_default,
        "priority": t.priority,
    } for t in templates]


async def _run(
    task_type: str, body: CreationRequest,
    db: AsyncSession, current_user: User, org: Organization,
    project_id: Optional[UUID] = None, episode_id: Optional[UUID] = None,
) -> Dict[str, Any]:
    params = body.model_dump(exclude_none=True)
    if body.elements is not None:
        params["elements"] = [e.model_dump(exclude_none=True) for e in body.elements]

    # 解析模型：若请求体指定了 model（AIModel.id），加载其 config
    model_name = "auto"
    model_config = None
    if body.model:
        from sqlalchemy import select as _sel
        from app.models import AIModel
        ml_r = await db.execute(_sel(AIModel).where(AIModel.id == body.model))
        ml = ml_r.scalar_one_or_none()
        if ml and ml.is_enabled:
            model_name = (ml.config or {}).get("model", ml.name) or ml.name
            model_config = {
                "provider": ml.provider,
                "type": ml.type,
                "endpoint": ml.endpoint,
                "api_key": ml.api_key,
                "config": ml.config or {},
            }

    # 模型能力适配：MiniMax 等纯视频模型不支持 fusion，自动降级为 image_to_video
    if task_type == "fusion" and model_config:
        provider = model_config.get("provider", "")
        if provider in ("minimax", "h3", "hailuo"):
            task_type = "image_to_video"
            logger.info("MiniMax model doesn't support fusion, auto-switching to image_to_video")

    return await creation_service.submit_creation(
        db, org.id, current_user.id, task_type, params,
        project_id=project_id, episode_id=episode_id,
        model=model_name, model_config=model_config,
    )


@router.post("/fusion")
async def fusion_generate(
    body: CreationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    project_id: Optional[UUID] = Query(None),
):
    """融合生图(角色+场景+物品+姿态+特效 组合)"""
    return await _run("fusion", body, db, current_user, org, project_id)


@router.post("/image-to-video")
async def image_to_video(
    body: CreationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    project_id: Optional[UUID] = Query(None),
    episode_id: Optional[UUID] = Query(None),
):
    """图生视频"""
    return await _run("image_to_video", body, db, current_user, org, project_id, episode_id)


@router.post("/first-last-frame")
async def first_last_frame(
    body: CreationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    project_id: Optional[UUID] = Query(None),
    episode_id: Optional[UUID] = Query(None),
):
    """首尾帧生成视频"""
    return await _run("first_last_frame", body, db, current_user, org, project_id, episode_id)


@router.post("/lip-sync")
async def lip_sync(
    body: CreationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    project_id: Optional[UUID] = Query(None),
):
    """对口型(视频+音频 -> 口型同步)"""
    return await _run("lip_sync", body, db, current_user, org, project_id)


@router.post("/tts")
async def tts(
    body: CreationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    project_id: Optional[UUID] = Query(None),
):
    """语音合成(文本 -> 音频)"""
    return await _run("tts", body, db, current_user, org, project_id)


@router.post("/image-edit")
async def image_edit(
    body: CreationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    project_id: Optional[UUID] = Query(None),
):
    """图片改创"""
    return await _run("image_edit", body, db, current_user, org, project_id)


@router.post("/clip/{scene_id}/generate")
async def clip_generate(
    scene_id: UUID,
    body: CreationRequest,
    creation_mode: str = Query("image_to_video", pattern="^(image_to_video|first_last_frame|fusion)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
):
    """单个分镜生成（片段管理用）：读 Scene 的 prompt/参数，扩展 @引用，调适配器生成，回写视频URL。

    - creation_mode: image_to_video / first_last_frame / fusion
    - body.model: 指定模型（AIModel.id），不传则用后台最高优先级模型
    - body 里的 prompt/size/duration/quality 等会覆盖分镜自身存的值
    """
    from sqlalchemy import select
    from app.models import Scene, AIModel
    from app.services.prompt_builder import PromptBuilderService

    # 1. 读 Scene
    result = await db.execute(select(Scene).where(Scene.id == scene_id))
    scene = result.scalar_one_or_none()
    if not scene:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("Scene not found")

    # 状态检测：该分镜正在生成中时拒绝重复提交（防止多用户/多次点击重复扣费）
    if scene.status == "generating":
        from app.core.exceptions import BadRequestException
        raise BadRequestException("该分镜正在生成视频，请等待完成后再操作")

    # 2. 合并参数：请求体 > Scene 存的值 > 默认
    scene_meta = scene.meta or {}
    prompt = body.prompt or scene.prompt or ""
    duration = body.duration or scene.duration or 5.0
    size = body.size or scene_meta.get("size", "16:9")
    quality = body.quality or scene_meta.get("quality", "hd")
    resolution = body.resolution or scene_meta.get("resolution", "720p")
    watermark = body.watermark_enabled if body.watermark_enabled is not None else scene_meta.get("watermark_enabled", False)

    # 3. 扩展 prompt 里的 @引用（@沈知姬 → 完整角色描述），并收集引用资源的图片
    ref_image_urls = []  # @引用关联的角色/场景/道具图片，作为参考图传给 MiniMax
    try:
        builder = PromptBuilderService(db)
        expanded = await builder.build_preview(scene_id, prompt)
        # ScenePromptPreview 是 pydantic model，用 model_dump 或属性访问
        exp_prompt = getattr(expanded, "expanded_prompt", None) or (expanded.get("expanded_prompt") if isinstance(expanded, dict) else None)
        if exp_prompt:
            prompt = exp_prompt
        # 收集引用资源的图片 URL（角色/场景/道具已生成的图）
        refs = getattr(expanded, "referenced_resources", None) or (expanded.get("referenced_resources") if isinstance(expanded, dict) else [])
        from app.models import Character, SceneBackground, Prop
        for ref in refs:
            rid = ref.get("id") if isinstance(ref, dict) else getattr(ref, "id", None)
            rtype = ref.get("type") if isinstance(ref, dict) else getattr(ref, "type", None)
            if not rid or not rtype:
                continue
            model_cls = {"character": Character, "scene_bg": SceneBackground, "prop": Prop}.get(rtype)
            if not model_cls:
                continue
            try:
                r = await db.execute(select(model_cls).where(model_cls.id == rid))
                obj = r.scalar_one_or_none()
                if obj and obj.image_url and obj.image_url not in ref_image_urls:
                    ref_image_urls.append(obj.image_url)
            except Exception:
                pass
    except Exception:
        pass  # 扩展失败不阻断，用原始 prompt

    # 4. 解析模型：若指定了 AIModel.id 则加载其 config
    model_name = "auto"
    model_config = None
    if body.model:
        # body.model 可能是 AIModel.id 或模型标识名
        ml_result = await db.execute(select(AIModel).where(AIModel.id == body.model))
        ml = ml_result.scalar_one_or_none()
        if ml and ml.is_enabled:
            model_name = (ml.config or {}).get("model", ml.name) or ml.name
            model_config = {
                "provider": ml.provider,
                "type": ml.type,
                "endpoint": ml.endpoint,
                "api_key": ml.api_key,
                "config": ml.config or {},
            }

    # 5. 构造 params 并提交
    type_map = {"image_to_video": "image_to_video", "first_last_frame": "first_last_frame", "fusion": "fusion"}
    task_type = type_map.get(creation_mode, "image_to_video")

    # 模型能力适配：MiniMax 等纯视频模型不支持 fusion（融合生图），自动降级为 image_to_video
    # （MiniMax H3 的 image_to_video 在无 image_url 时走文生视频，效果等同 fusion）
    if task_type == "fusion" and model_config:
        provider = model_config.get("provider", "")
        if provider in ("minimax", "h3", "hailuo"):
            task_type = "image_to_video"
            logger.info(f"MiniMax model doesn't support fusion, auto-switching to image_to_video (text-to-video)")
    params = {
        "prompt": prompt,
        "size": size,
        "count": body.count or 1,
        "duration": duration,
        "quality": quality,
        "watermark_enabled": watermark,
        "resolution": resolution,
    }
    if body.image_url:
        params["image_url"] = body.image_url
    if body.first_frame_url:
        params["first_frame_url"] = body.first_frame_url
    if body.last_frame_url:
        params["last_frame_url"] = body.last_frame_url
    # 把 @引用 关联的资源图片作为 elements 传入（MiniMax 会作为 reference_image 参考图）
    all_elements = [e.model_dump(exclude_none=True) for e in (body.elements or [])]
    for img_url in ref_image_urls:
        all_elements.append({"type": "reference", "name": "ref_image", "image_url": img_url})
    if all_elements:
        params["elements"] = all_elements

    # project_id 通过 script 关联获取（Scene 无直接 project_id 列）
    from app.models import Script
    script_result = await db.execute(select(Script).where(Script.id == scene.script_id))
    script_obj = script_result.scalar_one_or_none()
    project_id = script_obj.project_id if script_obj else None
    episode_id = scene.episode_id
    return await creation_service.submit_creation(
        db, org.id, current_user.id, task_type, params,
        project_id=project_id, episode_id=episode_id,
        model=model_name, model_config=model_config,
        scene_id=scene_id,
    )
