"""
Resources API - 资源管理接口 (角色/场景/道具/音频)

AI 生图采用异步模式：提交后立即返回 task_id，后台异步生成，前端轮询状态。
"""
import asyncio
from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from uuid import UUID
from typing import List

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import NotFoundException
from app.models import (
    User,
    Character,
    SceneBackground,
    Prop,
    AudioAsset,
    VideoAsset,
    GenerationTask,
    Project,
    AIModel,
)
from app.services import gen_task_tracker
from app.schemas import (
    CharacterCreate,
    CharacterUpdate,
    CharacterResponse,
    GenerateCharacterImageRequest,
    GenerateImageOptions,
    SceneBackgroundCreate,
    SceneBackgroundUpdate,
    SceneBackgroundResponse,
    PropCreate,
    PropUpdate,
    PropResponse,
    AudioAssetCreate,
    AudioAssetUpdate,
    AudioAssetResponse,
    AudioGenerateRequest,
    VideoAssetCreate,
    VideoAssetUpdate,
    VideoAssetResponse,
    TTSRequest,
)

router = APIRouter()


async def _check_name_unique(db: AsyncSession, Model, project_id: UUID, name: str, exclude_id: UUID = None) -> None:
    """检查同一项目下资源名称是否唯一，重复时抛出 400。"""
    from app.core.exceptions import BadRequestException
    q = select(Model).where(Model.project_id == project_id, Model.name == name)
    if exclude_id:
        q = q.where(Model.id != exclude_id)
    result = await db.execute(q)
    if result.scalar_one_or_none():
        raise BadRequestException(f"该项目下已存在同名{Model.__name__}「{name}」，名称不可重复")


# ==================== 异步生图（提交+轮询模式）====================

async def _check_and_set_generating(db: AsyncSession, Model, resource_id: UUID) -> bool:
    """提交生图前检查：如果已在生成中返回 False（防重复），否则设 meta.gen_status='generating' 并返回 True。

    如果 generating 状态超过 5 分钟（可能是后端重启导致任务中断），视为僵尸状态，允许重新提交。
    """
    import time
    result = await db.execute(select(Model).where(Model.id == resource_id))
    obj = result.scalar_one_or_none()
    if obj is None:
        raise NotFoundException(f"{Model.__name__} not found")
    meta = dict(obj.meta or {})
    if meta.get("gen_status") == "generating":
        # 检查是否是僵尸状态（超过 5 分钟）
        gen_started = meta.get("gen_started_at", 0)
        if gen_started and (time.time() - gen_started) < 300:
            return False  # 5 分钟内，拒绝重复
        # 超过 5 分钟，视为僵尸，允许重新提交
    meta["gen_status"] = "generating"
    meta["gen_started_at"] = time.time()
    obj.meta = meta
    await db.commit()
    return True


async def _async_generate_image(
    task_id: str,
    resource_type: str,   # character / scene_bg / prop
    resource_id: UUID,
    project_id: UUID,
    opts: dict,
    user_id: UUID = None,
):
    """后台异步执行生图，完成后更新资源和 task 状态。

    同时创建 GenerationTask DB 记录（写入 generation_tasks 表），
    让所有 AI 调用（图片/视频）都有统一的审计日志。
    """
    from app.core.database import AsyncSessionLocal
    from app.adapters.factory import get_adapter_for_task_type
    from app.adapters.base import GenInput
    from datetime import datetime, timezone

    TYPE_LABEL = {"character": "角色", "scene_bg": "场景", "prop": "道具"}
    charge_info = None  # 扣费信息（失败时退款用）
    adapter = None
    inp = None
    db_task_id = None

    # ---- 阶段1：建任务 + 扣费并立即提交（后台任务队列马上能看到「进行中」，不用等生成完）----
    try:
        async with AsyncSessionLocal() as db:
            # 查资源
            Model = {"character": Character, "scene_bg": SceneBackground, "prop": Prop}.get(resource_type)
            if Model is None:
                gen_task_tracker.fail_task(task_id, f"未知资源类型: {resource_type}")
                return
            result = await db.execute(select(Model).where(Model.id == resource_id))
            obj = result.scalar_one_or_none()
            if obj is None:
                gen_task_tracker.fail_task(task_id, "资源不存在")
                return

            # 查 project_id（资源表有 project_id 列）
            res_project_id = getattr(obj, "project_id", None) or project_id
            resource_name = getattr(obj, "name", str(resource_id))
            prompt = getattr(obj, "appearance_prompt", None) or getattr(obj, "prompt", None) or obj.name

            # 自动关联来源剧本：解析入库时资源 meta 记了 script_id（老数据可能没有 → 留空）
            task_meta = {"gen_task_id": task_id, "resource_type": resource_type}
            _res_meta = getattr(obj, "meta", None) or {}
            _src_script_id = _res_meta.get("script_id") if isinstance(_res_meta, dict) else None
            if _src_script_id:
                from app.models import Script as _ScriptModel
                _scr = (await db.execute(
                    select(_ScriptModel).where(_ScriptModel.id == _src_script_id)
                )).scalar_one_or_none()
                if _scr is not None:
                    task_meta["script_id"] = str(_scr.id)
                    task_meta["script_title"] = _scr.title

            # 创建 GenerationTask DB 记录（统一审计日志）
            db_task = GenerationTask(
                project_id=res_project_id,
                user_id=user_id,
                type="image",
                model=opts.get("model", "auto"),
                input_data={
                    "prompt": prompt[:500],
                    "resource_type": resource_type,
                    "resource_id": str(resource_id),
                    "resource_name": resource_name,
                    "size": opts.get("size", "3:4"),
                    "quality": opts.get("quality", "hd"),
                    "task_type": "resource_image",
                },
                status="processing",
                progress=10,
                started_at=datetime.now(timezone.utc),
                meta=task_meta,
            )
            db.add(db_task)
            await db.flush()
            db_task_id = db_task.id

            # 解析适配器：用户选了具体模型（AIModel.id）则用其完整配置，否则按优先级自动选
            from app.adapters.factory import get_adapter
            model_config = None
            if opts.get("model"):
                ml_result = await db.execute(select(AIModel).where(AIModel.id == opts["model"]))
                ml = ml_result.scalar_one_or_none()
                if ml and ml.is_enabled:
                    model_config = {
                        "id": ml.id, "name": ml.name,
                        "provider": ml.provider, "type": ml.type,
                        "endpoint": ml.endpoint, "api_key": ml.api_key,
                        "config": ml.config or {},
                    }
            if model_config:
                adapter = get_adapter(model_config)
            else:
                adapter = await get_adapter_for_task_type("image", db=db)

            # 记录真实模型 id + 按计价规则扣积分（素材生图 → credit_pricing 的 image 规则）
            from app.adapters.factory import resolve_model_info
            from app.services import pricing_service
            mi = await resolve_model_info("image", model_config, db)
            _actual_model = mi["model"]
            if _actual_model:
                db_task.model = _actual_model

            try:
                charge_info = await pricing_service.charge_for_task(
                    db, "image", mi["id"], {"size": opts.get("size")},
                    org_id=await pricing_service.get_project_org_id(db, res_project_id),
                    user_id=user_id, project_id=res_project_id,
                    task=db_task, model=_actual_model,
                    remark=f"素材生图: {TYPE_LABEL.get(resource_type, resource_type)}",
                )
            except Exception as ce:
                # 余额不足/扣费失败 → 任务失败，不调模型（不白花接口钱）
                db_task.status = "failed"
                db_task.error_message = f"积分扣费失败: {str(ce)[:200]}"
                db_task.completed_at = datetime.now(timezone.utc)
                # 重置资源的 generating 状态（否则 5 分钟内无法重新提交）
                if hasattr(obj, "meta"):
                    obj.meta = {**(obj.meta or {}), "gen_status": "failed", "gen_error": str(ce)[:200]}
                await db.commit()
                gen_task_tracker.fail_task(task_id, f"积分不足或扣费失败: {str(ce)[:200]}")
                return

            inp = GenInput(
                prompt=prompt, count=1,
                size=opts.get("size", "3:4"),
                extra={"quality": opts.get("quality", "hd"), "watermark_enabled": opts.get("watermark_enabled", False)},
            )
            # 任务 + 扣费先落库：进行中状态对外立即可见
            await db.commit()
    except Exception as e:
        # 阶段1失败：重置资源 generating 状态，避免 5 分钟内被防重复卡住
        try:
            async with AsyncSessionLocal() as rdb:
                _Model = {"character": Character, "scene_bg": SceneBackground, "prop": Prop}.get(resource_type)
                if _Model is not None:
                    _o = (await rdb.execute(select(_Model).where(_Model.id == resource_id))).scalar_one_or_none()
                    if _o is not None and hasattr(_o, "meta"):
                        _o.meta = {**(_o.meta or {}), "gen_status": "failed", "gen_error": str(e)[:200]}
                        await rdb.commit()
        except Exception:
            pass
        gen_task_tracker.fail_task(task_id, f"创建生图任务失败: {str(e)[:200]}")
        return

    # ---- 阶段2：调模型生图（不占数据库会话）----
    try:
        gen_result = await adapter.text_to_image(inp)

        # ---- 阶段3：回写资源 + 任务状态/接口日志/退款 ----
        async with AsyncSessionLocal() as db:
            Model = {"character": Character, "scene_bg": SceneBackground, "prop": Prop}.get(resource_type)
            obj = None
            if Model is not None:
                obj = (await db.execute(select(Model).where(Model.id == resource_id))).scalar_one_or_none()
            db_task = await db.get(GenerationTask, db_task_id)
            if db_task is None:
                gen_task_tracker.fail_task(task_id, "任务记录丢失")
                return

            if gen_result.success and gen_result.urls:
                if obj is not None:
                    obj.image_url = gen_result.urls[0]
                    if hasattr(obj, "meta"):
                        obj.meta = {**(obj.meta or {}), "gen_status": "completed"}
                db_task.status = "completed"
                db_task.progress = 100
                db_task.output_urls = gen_result.urls
                db_task.completed_at = datetime.now(timezone.utc)
                db_task.meta = {
                    **(db_task.meta or {}),
                    "adapter": gen_result.meta.get("adapter", "unknown"),
                    "logs": [*((db_task.meta or {}).get("logs") or []), *((gen_result.meta or {}).get("logs") or [])],
                }
                await db.commit()
                gen_task_tracker.complete_task(task_id, {"image_url": gen_result.urls[0]})
            else:
                if obj is not None and hasattr(obj, "meta"):
                    obj.meta = {**(obj.meta or {}), "gen_status": "failed", "gen_error": (gen_result.error or "")[:200]}
                db_task.status = "failed"
                db_task.error_message = (gen_result.error or "生图失败")[:500]
                db_task.completed_at = datetime.now(timezone.utc)
                db_task.meta = {
                    **(db_task.meta or {}),
                    "logs": [*((db_task.meta or {}).get("logs") or []), *((gen_result.meta or {}).get("logs") or [])],
                }
                # 已扣积分退还
                from app.services import pricing_service
                await pricing_service.refund_charge(
                    db, charge_info, user_id=user_id, task_id=db_task.id,
                    remark="素材生图失败退还",
                )
                await db.commit()
                gen_task_tracker.fail_task(task_id, gen_result.error or "生图失败")
    except Exception as e:
        # 异常时也更新资源状态 + DB 任务记录
        try:
            # 已扣积分退还（按 gen_task_id 找回任务，把流水挂上）
            if charge_info is not None:
                try:
                    async with AsyncSessionLocal() as rdb:
                        from app.services import pricing_service
                        _t = (await rdb.execute(
                            select(GenerationTask).where(
                                GenerationTask.meta.op("->>")("gen_task_id") == task_id
                            )
                        )).scalar_one_or_none()
                        await pricing_service.refund_charge(
                            rdb, charge_info, user_id=user_id,
                            task_id=_t.id if _t is not None else None,
                            remark=f"素材生图异常退还: {str(e)[:80]}",
                        )
                except Exception:
                    pass
            async with AsyncSessionLocal() as err_db:
                Model = {"character": Character, "scene_bg": SceneBackground, "prop": Prop}.get(resource_type)
                if Model:
                    r = await err_db.execute(select(Model).where(Model.id == resource_id))
                    o = r.scalar_one_or_none()
                    if o and hasattr(o, "meta"):
                        o.meta = {**(o.meta or {}), "gen_status": "failed", "gen_error": str(e)[:200]}
                        await err_db.commit()
                # 标记 DB 任务失败（通过 gen_task_id 关联）
                from sqlalchemy import update as sa_update
                await err_db.execute(
                    sa_update(GenerationTask)
                    .where(GenerationTask.meta.op("->>")("gen_task_id") == task_id)
                    .values(status="failed", error_message=str(e)[:500],
                            completed_at=datetime.now(timezone.utc))
                )
                await err_db.commit()
        except Exception:
            pass
        gen_task_tracker.fail_task(task_id, str(e)[:300])


@router.get("/generate-status/{task_id}")
async def get_generate_status(
    task_id: str,
    current_user: User = Depends(get_current_user),
):
    """查询生图任务状态（前端轮询）。"""
    task = gen_task_tracker.get_task(task_id)
    if task is None:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("Task not found", resource="gen_task")
    return task

# ==================== 角色管理 ====================

@router.get("/project/{project_id}/characters", response_model=List[CharacterResponse])
async def get_characters(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取项目的角色列表"""
    result = await db.execute(
        select(Character)
        .where(Character.project_id == project_id)
        .order_by(Character.created_at.desc())
    )
    return result.scalars().all()


@router.post("/project/{project_id}/characters", response_model=CharacterResponse, status_code=201)
async def create_character(
    project_id: UUID,
    body: CharacterCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """创建角色"""
    await _check_name_unique(db, Character, project_id, body.name)
    character = Character(
        project_id=project_id,
        name=body.name,
        description=body.description,
        appearance_prompt=body.appearance_prompt,
        voice_id=body.voice_id,
        image_url=body.image_url,
        meta=body.meta or {},
    )
    db.add(character)
    await db.flush()
    await db.refresh(character)
    await db.commit()
    return character


@router.put("/character/{character_id}", response_model=CharacterResponse)
async def update_character(
    character_id: UUID,
    body: CharacterUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新角色信息"""
    result = await db.execute(select(Character).where(Character.id == character_id))
    character = result.scalar_one_or_none()

    if not character:
        raise NotFoundException("Character not found")

    if body.name is not None:
        await _check_name_unique(db, Character, character.project_id, body.name, exclude_id=character.id)
        character.name = body.name
    if body.description is not None:
        character.description = body.description
    if body.appearance_prompt is not None:
        character.appearance_prompt = body.appearance_prompt
    if body.voice_id is not None:
        character.voice_id = body.voice_id
    if body.image_url is not None:
        character.image_url = body.image_url
    if body.meta is not None:
        character.meta = body.meta

    await db.flush()
    await db.refresh(character)
    await db.commit()
    return character


@router.delete("/character/{character_id}")
async def delete_character(
    character_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除角色"""
    result = await db.execute(select(Character).where(Character.id == character_id))
    character = result.scalar_one_or_none()

    if not character:
        raise NotFoundException("Character not found")

    await db.delete(character)
    await db.commit()
    return {"message": "deleted"}


@router.post("/character/{character_id}/generate-image")
async def generate_character_image(
    character_id: UUID,
    body: GenerateImageOptions = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """AI生成角色图片（异步模式：返回 task_id，前端轮询状态）"""
    # 防重复：检查是否已在生成中
    can_proceed = await _check_and_set_generating(db, Character, character_id)
    if not can_proceed:
        from app.core.exceptions import BadRequestException
        raise BadRequestException("该角色图片正在生成中，请等待完成")

    opts = (body or GenerateImageOptions()).model_dump()
    task_id = gen_task_tracker.create_task("character", str(character_id))
    from app.core.background import spawn_background
    spawn_background(_async_generate_image(
        task_id, "character", character_id, None, opts, current_user.id
    ))
    return {"task_id": task_id, "status": "processing", "message": "生成已提交，请轮询状态"}


# ==================== 场景背景管理 ====================

@router.get("/project/{project_id}/scenes-bg", response_model=List[SceneBackgroundResponse])
async def get_scene_backgrounds(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取项目的场景列表"""
    result = await db.execute(
        select(SceneBackground)
        .where(SceneBackground.project_id == project_id)
        .order_by(SceneBackground.created_at.desc())
    )
    return result.scalars().all()


@router.post("/project/{project_id}/scenes-bg", response_model=SceneBackgroundResponse, status_code=201)
async def create_scene_background(
    project_id: UUID,
    body: SceneBackgroundCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """创建场景"""
    await _check_name_unique(db, SceneBackground, project_id, body.name)
    scene_bg = SceneBackground(
        project_id=project_id,
        name=body.name,
        description=body.description,
        prompt=body.prompt,
        image_url=body.image_url,
    )
    db.add(scene_bg)
    await db.flush()
    await db.refresh(scene_bg)
    await db.commit()
    return scene_bg


@router.put("/scene-bg/{bg_id}", response_model=SceneBackgroundResponse)
async def update_scene_background(
    bg_id: UUID,
    body: SceneBackgroundUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新场景"""
    result = await db.execute(select(SceneBackground).where(SceneBackground.id == bg_id))
    scene_bg = result.scalar_one_or_none()

    if not scene_bg:
        raise NotFoundException("Scene background not found")

    if body.name is not None:
        await _check_name_unique(db, SceneBackground, scene_bg.project_id, body.name, exclude_id=scene_bg.id)
        scene_bg.name = body.name
    if body.description is not None:
        scene_bg.description = body.description
    if body.prompt is not None:
        scene_bg.prompt = body.prompt
    if body.image_url is not None:
        scene_bg.image_url = body.image_url

    await db.flush()
    await db.refresh(scene_bg)
    await db.commit()
    return scene_bg


@router.delete("/scene-bg/{bg_id}")
async def delete_scene_background(
    bg_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除场景"""
    result = await db.execute(select(SceneBackground).where(SceneBackground.id == bg_id))
    scene_bg = result.scalar_one_or_none()

    if not scene_bg:
        raise NotFoundException("Scene background not found")

    await db.delete(scene_bg)
    await db.commit()
    return {"message": "deleted"}


@router.post("/scene-bg/{bg_id}/generate-image")
async def generate_scene_background_image(
    bg_id: UUID,
    body: GenerateImageOptions = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """AI生成场景图片（异步模式：返回 task_id，前端轮询状态）"""
    can_proceed = await _check_and_set_generating(db, SceneBackground, bg_id)
    if not can_proceed:
        from app.core.exceptions import BadRequestException
        raise BadRequestException("该场景图片正在生成中，请等待完成")

    opts = (body or GenerateImageOptions()).model_dump()
    opts.setdefault("size", "16:9")
    task_id = gen_task_tracker.create_task("scene_bg", str(bg_id))
    from app.core.background import spawn_background
    spawn_background(_async_generate_image(task_id, "scene_bg", bg_id, None, opts, current_user.id))
    return {"task_id": task_id, "status": "processing", "message": "生成已提交，请轮询状态"}
    await db.commit()
    await db.refresh(bg)
    return bg

@router.get("/project/{project_id}/props", response_model=List[PropResponse])
async def get_props(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取项目的道具列表"""
    result = await db.execute(
        select(Prop)
        .where(Prop.project_id == project_id)
        .order_by(Prop.created_at.desc())
    )
    return result.scalars().all()


@router.post("/project/{project_id}/props", response_model=PropResponse, status_code=201)
async def create_prop(
    project_id: UUID,
    body: PropCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """创建道具"""
    await _check_name_unique(db, Prop, project_id, body.name)
    prop = Prop(
        project_id=project_id,
        name=body.name,
        description=body.description,
        prompt=body.prompt,
        image_url=body.image_url,
    )
    db.add(prop)
    await db.flush()
    await db.refresh(prop)
    await db.commit()
    return prop


@router.put("/prop/{prop_id}", response_model=PropResponse)
async def update_prop(
    prop_id: UUID,
    body: PropUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新道具"""
    result = await db.execute(select(Prop).where(Prop.id == prop_id))
    prop = result.scalar_one_or_none()

    if not prop:
        raise NotFoundException("Prop not found")

    if body.name is not None:
        await _check_name_unique(db, Prop, prop.project_id, body.name, exclude_id=prop.id)
        prop.name = body.name
    if body.description is not None:
        prop.description = body.description
    if body.prompt is not None:
        prop.prompt = body.prompt
    if body.image_url is not None:
        prop.image_url = body.image_url

    await db.flush()
    await db.refresh(prop)
    await db.commit()
    return prop


@router.delete("/prop/{prop_id}")
async def delete_prop(
    prop_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除道具"""
    result = await db.execute(select(Prop).where(Prop.id == prop_id))
    prop = result.scalar_one_or_none()

    if not prop:
        raise NotFoundException("Prop not found")

    await db.delete(prop)
    await db.commit()
    return {"message": "deleted"}


@router.post("/prop/{prop_id}/generate-image")
async def generate_prop_image(
    prop_id: UUID,
    body: GenerateImageOptions = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """AI生成道具图片（异步模式：返回 task_id，前端轮询状态）"""
    can_proceed = await _check_and_set_generating(db, Prop, prop_id)
    if not can_proceed:
        from app.core.exceptions import BadRequestException
        raise BadRequestException("该物品图片正在生成中，请等待完成")

    opts = (body or GenerateImageOptions()).model_dump()
    opts.setdefault("size", "1:1")
    task_id = gen_task_tracker.create_task("prop", str(prop_id))
    from app.core.background import spawn_background
    spawn_background(_async_generate_image(task_id, "prop", prop_id, None, opts, current_user.id))
    return {"task_id": task_id, "status": "processing", "message": "生成已提交，请轮询状态"}

@router.get("/project/{project_id}/audio", response_model=List[AudioAssetResponse])
async def get_audio_assets(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取项目的音频列表"""
    result = await db.execute(
        select(AudioAsset)
        .options(selectinload(AudioAsset.character))
        .where(AudioAsset.project_id == project_id)
        .order_by(AudioAsset.created_at.desc())
    )
    audio_assets = result.scalars().all()

    # 关联 character_name
    for audio in audio_assets:
        audio.character_name = audio.character.name if audio.character else None

    return audio_assets


@router.post("/project/{project_id}/audio", response_model=AudioAssetResponse, status_code=201)
async def create_audio_asset(
    project_id: UUID,
    body: AudioAssetCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """上传/创建音频资产"""
    audio = AudioAsset(
        project_id=project_id,
        name=body.name,
        type=body.type,
        content=body.content,
        url=body.url,
        duration=body.duration,
        character_id=body.character_id,
        meta=body.meta or {},
    )
    db.add(audio)
    await db.flush()
    await db.refresh(audio)
    await db.commit()
    return audio


@router.put("/audio/{audio_id}", response_model=AudioAssetResponse)
async def update_audio_asset(
    audio_id: UUID,
    body: AudioAssetUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新音频资产"""
    result = await db.execute(select(AudioAsset).where(AudioAsset.id == audio_id))
    audio = result.scalar_one_or_none()

    if not audio:
        raise NotFoundException("Audio asset not found")

    if body.name is not None:
        audio.name = body.name
    if body.content is not None:
        audio.content = body.content
    if body.meta is not None:
        audio.meta = body.meta

    await db.flush()
    await db.refresh(audio)
    await db.commit()
    return audio


@router.delete("/audio/{audio_id}")
async def delete_audio_asset(
    audio_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除音频资产"""
    result = await db.execute(select(AudioAsset).where(AudioAsset.id == audio_id))
    audio = result.scalar_one_or_none()

    if not audio:
        raise NotFoundException("Audio asset not found")

    await db.delete(audio)
    await db.commit()
    return {"message": "deleted"}


# ==================== 视频资产（参考视频） ====================

@router.get("/project/{project_id}/videos", response_model=List[VideoAssetResponse])
async def get_video_assets(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取项目的视频列表"""
    result = await db.execute(
        select(VideoAsset)
        .where(VideoAsset.project_id == project_id)
        .order_by(VideoAsset.created_at.desc())
    )
    return result.scalars().all()


@router.post("/project/{project_id}/videos", response_model=VideoAssetResponse, status_code=201)
async def create_video_asset(
    project_id: UUID,
    body: VideoAssetCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """上传/创建视频资产（url 为先经 /upload/video 上传后的地址）"""
    video = VideoAsset(
        project_id=project_id,
        name=body.name,
        type=body.type,
        content=body.content,
        url=body.url,
        thumbnail_url=body.thumbnail_url,
        duration=body.duration,
        meta=body.meta or {},
    )
    db.add(video)
    await db.flush()
    await db.refresh(video)
    await db.commit()
    return video


@router.put("/video/{video_id}", response_model=VideoAssetResponse)
async def update_video_asset(
    video_id: UUID,
    body: VideoAssetUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新视频资产"""
    result = await db.execute(select(VideoAsset).where(VideoAsset.id == video_id))
    video = result.scalar_one_or_none()

    if not video:
        raise NotFoundException("Video asset not found")

    if body.name is not None:
        video.name = body.name
    if body.type is not None:
        video.type = body.type
    if body.content is not None:
        video.content = body.content
    if body.thumbnail_url is not None:
        video.thumbnail_url = body.thumbnail_url
    if body.duration is not None:
        video.duration = body.duration
    if body.meta is not None:
        video.meta = body.meta

    await db.flush()
    await db.refresh(video)
    await db.commit()
    return video


@router.delete("/video/{video_id}")
async def delete_video_asset(
    video_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除视频资产"""
    result = await db.execute(select(VideoAsset).where(VideoAsset.id == video_id))
    video = result.scalar_one_or_none()

    if not video:
        raise NotFoundException("Video asset not found")

    await db.delete(video)
    await db.commit()
    return {"message": "deleted"}


@router.post("/project/{project_id}/audio/generate", response_model=AudioAssetResponse, status_code=201)
async def generate_audio_asset(
    project_id: UUID,
    body: AudioGenerateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """AI 生成音频（TTS）：文本 → 语音，直接落库为项目音效资产。

    需要后台「配置模型」先启用一个 tts 类型模型（如硅基流动 CosyVoice）。
    """
    from app.adapters.factory import get_adapter_for_task_type
    from app.adapters.base import GenInput
    from app.adapters.placeholder import PlaceholderAdapter

    adapter = await get_adapter_for_task_type("tts", db=db)
    if isinstance(adapter, PlaceholderAdapter):
        from app.core.exceptions import BadRequestException
        raise BadRequestException(
            "尚未配置语音合成模型：请在后台「配置模型」添加类型为「语音合成」的模型"
            "（推荐 provider=OpenAI TTS，硅基流动 CosyVoice）")

    result = await adapter.tts(GenInput(prompt=body.text, text=body.text, voice_id=body.voice))
    if not result.success or not result.urls:
        from app.core.exceptions import BadRequestException
        raise BadRequestException(f"语音合成失败: {result.error}")

    audio = AudioAsset(
        project_id=project_id,
        name=body.name,
        type=body.type,
        content=body.text,
        url=result.urls[0],
        meta={"adapter": (result.meta or {}).get("adapter"), "model": (result.meta or {}).get("model"),
              "voice": body.voice, "generated": True},
    )
    db.add(audio)
    await db.flush()
    await db.refresh(audio)
    await db.commit()
    return audio


@router.post("/audio/{audio_id}/tts", response_model=AudioAssetResponse)
async def text_to_speech(
    audio_id: UUID,
    body: TTSRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    文字转语音 (TTS)

    流程:
    1. 获取文本内容和音色设置
    2. 调用TTS模型生成语音
    3. 保存音频文件并返回URL
    """
    # TODO: 实现TTS逻辑
    pass
