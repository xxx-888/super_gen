"""
Scripts API - 剧本管理接口
"""
import asyncio
from fastapi import APIRouter, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import BadRequestException, NotFoundException
from app.models import User, Script, Character, SceneBackground, Prop, Scene, SceneAsset
from app.schemas import ScriptCreate, ScriptUpdate, ScriptResponse, ScriptParseResult, ParseScriptOptions

router = APIRouter()


@router.get("/project/{project_id}", response_model=list[ScriptResponse])
async def get_scripts(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取项目的剧本列表"""
    result = await db.execute(
        select(Script).where(Script.project_id == project_id).order_by(Script.created_at.desc())
    )
    return result.scalars().all()


@router.post("/project/{project_id}", response_model=ScriptResponse, status_code=201)
async def create_script(
    project_id: UUID,
    body: ScriptCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """创建剧本"""
    script = Script(
        project_id=project_id,
        title=body.title,
        content=body.content,
        format=body.format,
    )
    db.add(script)
    await db.flush()
    await db.refresh(script)
    await db.commit()
    return script


@router.get("/{script_id}", response_model=ScriptResponse)
async def get_script(
    script_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取剧本详情"""
    result = await db.execute(select(Script).where(Script.id == script_id))
    script = result.scalar_one_or_none()

    if not script:
        raise NotFoundException("Script not found")

    return script


@router.put("/{script_id}", response_model=ScriptResponse)
async def update_script(
    script_id: UUID,
    body: ScriptUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新剧本"""
    result = await db.execute(select(Script).where(Script.id == script_id))
    script = result.scalar_one_or_none()

    if not script:
        raise NotFoundException("Script not found")

    if body.title is not None:
        script.title = body.title
    if body.content is not None:
        script.content = body.content

    await db.flush()
    await db.refresh(script)
    await db.commit()
    return script


@router.delete("/{script_id}")
async def delete_script(
    script_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除剧本，并级联删除关联的片段(episode)和分镜(scene)。

    用原生 DELETE 语句按确定顺序执行（先子后父），不依赖 ORM flush 顺序。
    否则 SQLAlchemy 的 unit-of-work 可能先 flush script 的 DELETE，
    此时 episode 仍引用它 → 外键约束报错。
    """
    from app.models import Episode
    from sqlalchemy import func as sa_func, delete as sa_delete
    result = await db.execute(select(Script).where(Script.id == script_id))
    script = result.scalar_one_or_none()

    if not script:
        raise NotFoundException("Script not found")

    # 统计将删除的关联数据（用于返回给前端提示用户）
    ep_count_r = await db.execute(
        select(Episode).where(Episode.script_id == script_id)
    )
    episodes = ep_count_r.scalars().all()
    ep_ids = [ep.id for ep in episodes]
    scene_count = 0
    if ep_ids:
        sc_in_ep = await db.execute(
            select(sa_func.count()).select_from(Scene).where(Scene.episode_id.in_(ep_ids))
        )
        scene_count += sc_in_ep.scalar() or 0
    sc_direct_r = await db.execute(
        select(sa_func.count()).select_from(Scene).where(
            Scene.script_id == script_id,
            Scene.episode_id.is_(None) if not ep_ids else Scene.episode_id.notin_(ep_ids),
        )
    )
    scene_count += sc_direct_r.scalar() or 0

    # 级联删除（原生 DELETE，按确定顺序：先子后父，每步立即 flush）
    # 1. 删除 scene_assets（引用 scenes 的子表）
    if ep_ids:
        await db.execute(
            sa_delete(SceneAsset).where(SceneAsset.scene_id.in_(
                select(Scene.id).where(Scene.episode_id.in_(ep_ids))
            ))
        )
    await db.execute(
        sa_delete(SceneAsset).where(SceneAsset.scene_id.in_(
            select(Scene.id).where(Scene.script_id == script_id)
        ))
    )
    # 2. 删除 scenes（属于这些 episode 的 + 直接引用 script 的）
    if ep_ids:
        await db.execute(sa_delete(Scene).where(Scene.episode_id.in_(ep_ids)))
    await db.execute(sa_delete(Scene).where(Scene.script_id == script_id))
    # 3. 删除 episodes（引用 script 的片段）
    if ep_ids:
        await db.execute(sa_delete(Episode).where(Episode.id.in_(ep_ids)))
    # 4. 最后删除剧本本身
    await db.execute(sa_delete(Script).where(Script.id == script_id))

    await db.commit()
    return {
        "message": "deleted",
        "deleted_episodes": len(episodes),
        "deleted_scenes": scene_count,
    }


@router.get("/{script_id}/episode")
async def get_script_episode(
    script_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取剧本对应的集（episode）。

    用于从剧本页跳转到片段管理：一个剧本解析入库后会创建/关联一个 episode，
    前端用这个接口拿到 episode_id 后跳转到 episodes 详情页（统一的分镜编辑入口）。
    """
    from app.models import Episode
    result = await db.execute(
        select(Episode).where(Episode.script_id == script_id).limit(1)
    )
    ep = result.scalar_one_or_none()
    if ep is None:
        raise NotFoundException("该剧本尚未解析入库，暂无对应的集")
    return {"episode_id": str(ep.id), "episode_title": ep.title, "episode_number": ep.number}


@router.post("/{script_id}/parse")
async def parse_script(
    script_id: UUID,
    options: ParseScriptOptions = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """用 LLM 解析剧本为分镜（仅 LLM，无正则引擎）。

    异步：立即返回 task_id，前端轮询 GET /{script_id}/parse/status/{task_id}。
    """
    result = await db.execute(select(Script).where(Script.id == script_id))
    script = result.scalar_one_or_none()

    if not script:
        raise NotFoundException("Script not found")

    # 重复解析拦截：该剧本已有进行中的解析任务时不允许重复提交
    from app.models import GenerationTask
    running_r = await db.execute(
        select(GenerationTask).where(
            GenerationTask.type == "script_parse",
            GenerationTask.status == "processing",
        )
    )
    for gt in running_r.scalars().all():
        gt_script_id = (gt.input_data or {}).get("script_id") if isinstance(gt.input_data, dict) else None
        if gt_script_id and str(gt_script_id) == str(script_id):
            from app.core.exceptions import ConflictException
            raise ConflictException("该剧本正在解析中，请勿重复提交，稍候可在任务队列查看进度")

    opts_dict = options.model_dump() if options else {}
    opts_inner = opts_dict.get("options") if isinstance(opts_dict.get("options"), dict) else opts_dict
    model_id = opts_inner.get("model_id")
    mode = opts_inner.get("mode", "fusion")
    template_id = opts_inner.get("template_id", "")

    # LLM 可用性预检：若配置不可用，立即同步报错，避免提交注定失败的异步任务
    from app.services.llm_client import LLMClient
    pre_llm: LLMClient
    if model_id:
        from app.models import AIModel
        ml_result = await db.execute(select(AIModel).where(AIModel.id == model_id))
        ml = ml_result.scalar_one_or_none()
        if not ml or not ml.is_enabled:
            raise BadRequestException(
                "所选 LLM 模型不存在或已禁用，请到「后台管理 → 配置模型」启用。"
            )
        pre_llm = LLMClient(
            api_key=ml.api_key, base_url=ml.endpoint,
            model=(ml.config or {}).get("model", ml.name),
            timeout=(ml.config or {}).get("timeout", 300),
        )
    else:
        pre_llm = await LLMClient.from_config(db)

    if not pre_llm.available:
        raise BadRequestException(
            "未配置可用的 LLM 模型，无法解析。请在「后台管理 → 配置模型」添加 "
            "type=大语言模型 的记录，或在 .env 设置 LLM_API_KEY/LLM_BASE_URL。"
        )

    # 提交后台异步任务
    from app.services import gen_task_tracker
    task_id = gen_task_tracker.create_task("script_parse", str(script_id))
    asyncio.create_task(_async_llm_parse(task_id, script_id, script.content or "", model_id, mode, template_id))

    return {"task_id": task_id, "status": "processing", "engine": "llm", "message": "LLM 解析已提交，请轮询状态"}


async def _async_llm_parse(task_id: str, script_id: UUID, content: str, model_id: str = "", mode: str = "fusion", template_id: str = ""):
    """后台异步执行 LLM 剧本解析。

    同时创建 GenerationTask 记录，让后台任务队列能统计 AI 解析的模型调用。
    """
    from app.services.llm_client import LLMClient
    from app.services.script_analyzer import analyze_script
    from app.core.database import AsyncSessionLocal
    from app.services import gen_task_tracker
    from app.models import GenerationTask
    from datetime import datetime, timezone

    # 先解析 script → project_id + org_id（用于创建 GenerationTask）
    gt_task = None
    try:
        async with AsyncSessionLocal() as db:
            # 初始化 LLM
            model_name_for_log = "auto"
            if model_id:
                from app.models import AIModel
                ml_result = await db.execute(select(AIModel).where(AIModel.id == model_id))
                ml = ml_result.scalar_one_or_none()
                if ml and ml.is_enabled:
                    ml_cfg = ml.config or {}
                    model_name_for_log = ml_cfg.get("model", ml.name)
                    # 提取厂商专属透传参数（DeepSeek thinking/reasoning_effort 等）
                    extra: dict = {}
                    for k in ("thinking", "reasoning_effort", "top_p", "frequency_penalty", "presence_penalty"):
                        if k in ml_cfg:
                            extra[k] = ml_cfg[k]
                    llm = LLMClient(api_key=ml.api_key, base_url=ml.endpoint,
                                    model=ml_cfg.get("model", ml.name),
                                    timeout=ml_cfg.get("timeout", 300),
                                    extra_body=extra if extra else None)
                else:
                    llm = await LLMClient.from_config(db)
                    model_name_for_log = llm.model or "auto"
            else:
                llm = await LLMClient.from_config(db)
                model_name_for_log = llm.model or "auto"

            # 查 script → project_id（GenerationTask 需要）
            sc_result = await db.execute(select(Script).where(Script.id == script_id))
            script_obj = sc_result.scalar_one_or_none()
            project_id = script_obj.project_id if script_obj else None

            # 创建 GenerationTask 记录（type=script_parse，后台任务队列可见）
            gt_task = GenerationTask(
                project_id=project_id,
                type="script_parse",
                model=model_name_for_log,
                input_data={"script_id": str(script_id), "mode": mode, "template_id": template_id or None, "content_preview": (content or "")[:200]},
                status="processing", progress=10,
                credits_consumed=0,
                started_at=datetime.now(timezone.utc),
                meta={"parse_task_id": task_id},
            )
            db.add(gt_task)
            await db.commit()
            await db.refresh(gt_task)
            gt_id = gt_task.id

            # 调 LLM 解析（传入 db 以加载后台配置的提示词模板）
            analysis = await analyze_script(llm, content, mode, db=db, template_id=template_id or None)

            # 解析失败（LLM 不可用 / 无有效内容）：标记任务失败，前端拿到 failed + 错误信息
            if analysis.get("source") == "error":
                err_msg = analysis.get("error", "解析失败")
                gen_task_tracker.fail_task(task_id, str(err_msg)[:300])
                # 同步更新 GenerationTask
                gt_fail = await db.get(GenerationTask, gt_id)
                if gt_fail:
                    gt_fail.status = "failed"
                    gt_fail.error_message = str(err_msg)[:500]
                    gt_fail.completed_at = datetime.now(timezone.utc)
                    await db.commit()
                return

            # 查已有资源（标记新增）
            result = await db.execute(select(Script).where(Script.id == script_id))
            script = result.scalar_one_or_none()
            existing_chars = set()
            existing_scenes = set()
            existing_props = set()
            if project_id:
                for ch in (await db.execute(select(Character.name).where(Character.project_id == project_id))).scalars():
                    existing_chars.add(ch)
                for sc in (await db.execute(select(SceneBackground.name).where(SceneBackground.project_id == project_id))).scalars():
                    existing_scenes.add(sc)
                for pr in (await db.execute(select(Prop.name).where(Prop.project_id == project_id))).scalars():
                    existing_props.add(pr)

            characters_preview = [{**c, "exists": c.get("name", "") in existing_chars} for c in analysis.get("characters", [])]
            scenes_preview = [{**s, "exists": s.get("name", "") in existing_scenes} for s in analysis.get("scenes", [])]
            props_preview = [{**p, "exists": p.get("name", "") in existing_props} for p in analysis.get("props", [])]

            parsed_result = {
                "characters": characters_preview,
                "scenes": scenes_preview,
                "props": props_preview,
                "shots": analysis.get("shots", []),
                "warnings": [],
                "source": analysis.get("source"),
                "preview": True,
            }

            # 存到 script.parsed_data
            if script:
                script.parsed_data = parsed_result
                await db.commit()

            # 标记 GenerationTask 完成
            gt_done = await db.get(GenerationTask, gt_id)
            if gt_done:
                gt_done.status = "completed"
                gt_done.progress = 100
                gt_done.completed_at = datetime.now(timezone.utc)
                gt_done.meta = {**(gt_done.meta or {}), "characters": len(characters_preview), "scenes": len(scenes_preview), "shots": len(analysis.get("shots", []))}
                await db.commit()

            gen_task_tracker.complete_task(task_id, parsed_result)
    except Exception as e:
        import logging
        import traceback
        lg = logging.getLogger(__name__)
        lg.error(f"LLM parse failed: {e}\n{traceback.format_exc()}")
        gen_task_tracker.fail_task(task_id, str(e)[:300])
        # 同步标记 GenerationTask 失败
        try:
            async with AsyncSessionLocal() as db:
                if gt_task and gt_task.id:
                    gt_err = await db.get(GenerationTask, gt_task.id)
                    if gt_err:
                        gt_err.status = "failed"
                        gt_err.error_message = str(e)[:500]
                        gt_err.completed_at = datetime.now(timezone.utc)
                        await db.commit()
        except Exception:
            pass


@router.get("/{script_id}/parse/status/{task_id}")
async def get_parse_status(
    script_id: UUID,
    task_id: str,
    current_user: User = Depends(get_current_user),
):
    """查询 LLM 解析任务状态（前端轮询）。"""
    from app.services import gen_task_tracker
    task = gen_task_tracker.get_task(task_id)
    if task is None:
        raise NotFoundException("Task not found", resource="parse_task")
    return task



@router.post("/{script_id}/parse/confirm")
async def confirm_parse(
    script_id: UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """用户确认解析结果后，正式入库：创建资源 + 分镜 + Episode。

    body: {
        characters: [{name, description, appearance_prompt, selected: true}],
        scenes: [{name, description, prompt, selected: true}],
        props: [{name, description, selected: true}],
        shots: [{sequence, duration, location, characters, prompt, ...}]
    }
    """
    result = await db.execute(select(Script).where(Script.id == script_id))
    script = result.scalar_one_or_none()
    if not script:
        raise NotFoundException("Script not found")

    project_id = script.project_id
    auto_created = {"characters": 0, "scenes": 0, "props": 0, "shots": 0}

    # ========== 入库角色 ==========
    for ch in (body.get("characters") or []):
        if not ch.get("selected", True) or not ch.get("name"):
            continue
        name = ch["name"].strip()
        existing = await db.execute(
            select(Character).where(Character.project_id == project_id, Character.name == name)
        )
        if not existing.scalar_one_or_none():
            db.add(Character(
                project_id=project_id, name=name,
                appearance_prompt=ch.get("appearance_prompt") or ch.get("description", ""),
                description=ch.get("description", ""),
            ))
            auto_created["characters"] += 1

    # ========== 入库场景 ==========
    for sc in (body.get("scenes") or []):
        if not sc.get("selected", True) or not sc.get("name"):
            continue
        name = sc["name"].strip()
        existing = await db.execute(
            select(SceneBackground).where(SceneBackground.project_id == project_id, SceneBackground.name == name)
        )
        if not existing.scalar_one_or_none():
            db.add(SceneBackground(
                project_id=project_id, name=name,
                prompt=sc.get("prompt") or sc.get("description", ""),
                description=sc.get("description", ""),
            ))
            auto_created["scenes"] += 1

    # ========== 入库物品 ==========
    for pr in (body.get("props") or []):
        if not pr.get("selected", True) or not pr.get("name"):
            continue
        name = pr["name"].strip()
        existing = await db.execute(
            select(Prop).where(Prop.project_id == project_id, Prop.name == name)
        )
        if not existing.scalar_one_or_none():
            db.add(Prop(
                project_id=project_id, name=name,
                prompt=pr.get("description", ""),
                description=pr.get("description", ""),
            ))
            auto_created["props"] += 1

    await db.flush()

    # ========== 创建/关联 Episode ==========
    from app.models import Episode
    ep_result = await db.execute(select(Episode).where(Episode.script_id == script_id).limit(1))
    episode = ep_result.scalar_one_or_none()
    if episode is None:
        max_num_result = await db.execute(
            select(func.max(Episode.number)).where(Episode.project_id == project_id)
        )
        ep_num = (max_num_result.scalar() or 0) + 1
        episode = Episode(
            project_id=project_id, script_id=script_id,
            number=ep_num, title=f"第{ep_num}集", status="asset",
        )
        db.add(episode)
        await db.flush()

    # ========== 创建分镜 ==========
    old_scenes = await db.execute(select(Scene).where(Scene.episode_id == episode.id))
    for old in old_scenes.scalars().all():
        await db.delete(old)
    await db.flush()

    for i, shot in enumerate((body.get("shots") or [])):
        # 分镜也支持选择性入库：未选中的跳过（默认选中，兼容旧前端不传 selected 的情况）
        if not shot.get("selected", True):
            continue
        char_names = [c.get("name", "") for c in shot.get("characters", []) if c.get("name")]
        prompt_parts = []
        if shot.get("location"):
            prompt_parts.append(f"@{shot['location']}")
        for cn in char_names:
            prompt_parts.append(f"@{cn}")
        if shot.get("prompt"):
            prompt_parts.append(shot["prompt"])
        elif shot.get("narration"):
            prompt_parts.append(shot["narration"])
        full_prompt = " ".join(prompt_parts) if prompt_parts else f"分镜{shot.get('sequence', i+1)}"

        scene = Scene(
            script_id=script_id,
            episode_id=episode.id,
            sequence=shot.get("sequence", i + 1),
            prompt=full_prompt,
            duration=float(shot.get("duration", 5)),
            scene_type="normal",
            mood=shot.get("mood", ""),
            status="ready",
        )
        db.add(scene)
        auto_created["shots"] += 1

    # 更新 parsed_data 标记为已确认
    script.parsed_data = {**(script.parsed_data or {}), "confirmed": True}
    await db.commit()

    return {
        "message": "确认入库完成",
        "auto_created": auto_created,
        "episode_id": str(episode.id),
        "episode_title": episode.title,
    }
