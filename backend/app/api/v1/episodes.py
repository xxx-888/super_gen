"""
Episode API - 集(片段)管理接口 (M4)

路由前缀: /projects/{project_id}/episodes
端点:
- GET    /              集列表(含统计)
- POST   /              新建集
- GET    /{ep_id}       集详情
- PUT    /{ep_id}       编辑集
- DELETE /{ep_id}       删除集
- POST   /reorder       重排序
- PUT    /{ep_id}/status        状态流转
- PUT    /{ep_id}/stop-after    切换"此步后停止"
- PUT    /{ep_id}/smart-review  切换"智能审片"
- POST   /{ep_id}/one-click-render  一键成片
"""
from uuid import UUID
from typing import Optional, List, Dict, Any
import asyncio
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import NotFoundException
from app.api.deps import verify_project_ownership, get_current_org, require_project_role
from app.models import User, Organization, Project, Scene, GenerationTask, Script, Episode
from sqlalchemy import select, func
from app.schemas import (
    EpisodeCreate, EpisodeUpdate, EpisodeStatusUpdate,
    ReorderRequest, ToggleRequest,
)
from app.services import episode_service

router = APIRouter()


@router.get("", response_model=List[Dict[str, Any]])
async def list_episodes(
    project_id: UUID,
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """集列表"""
    return await episode_service.list_episodes(db, project_id, status, search)


@router.post("", status_code=201)
async def create_episode(
    project_id: UUID,
    body: EpisodeCreate,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """新建集"""
    ep = await episode_service.create_episode(db, project_id, body.number, body.title, body.script_id)
    return episode_service._to_dict(ep)


@router.get("/{episode_id}")
async def get_episode(
    project_id: UUID,
    episode_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """集详情"""
    ep = await episode_service.get_episode(db, project_id, episode_id)
    return episode_service._to_dict(ep)


@router.put("/{episode_id}")
async def update_episode(
    project_id: UUID,
    episode_id: UUID,
    body: EpisodeUpdate,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """编辑集"""
    ep = await episode_service.update_episode(db, project_id, episode_id, body.title, body.cover_image_url)
    return episode_service._to_dict(ep)


@router.delete("/{episode_id}")
async def delete_episode(
    project_id: UUID,
    episode_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """删除集"""
    await episode_service.delete_episode(db, project_id, episode_id)
    return {"message": "Deleted"}


@router.post("/reorder")
async def reorder_episodes(
    project_id: UUID,
    body: ReorderRequest,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """重排集顺序"""
    await episode_service.reorder_episodes(db, project_id, body.episode_ids)
    return {"message": "Reordered"}


@router.put("/{episode_id}/status")
async def update_status(
    project_id: UUID,
    episode_id: UUID,
    body: EpisodeStatusUpdate,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """状态流转(校验合法性)"""
    ep = await episode_service.transition_status(db, project_id, episode_id, body.status)
    return episode_service._to_dict(ep)


@router.put("/{episode_id}/stop-after")
async def toggle_stop_after(
    project_id: UUID,
    episode_id: UUID,
    body: ToggleRequest,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """切换"此步后停止\" """
    ep = await episode_service.set_stop_after_step(db, project_id, episode_id, body.value)
    return episode_service._to_dict(ep)


@router.put("/{episode_id}/smart-review")
async def toggle_smart_review(
    project_id: UUID,
    episode_id: UUID,
    body: ToggleRequest,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """切换"智能审片\" """
    ep = await episode_service.set_smart_review(db, project_id, episode_id, body.value)
    return episode_service._to_dict(ep)


@router.post("/{episode_id}/one-click-render")
async def one_click_render(
    project_id: UUID,
    episode_id: UUID,
    project: Project = Depends(verify_project_ownership),
    org: Organization = Depends(get_current_org),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """一键成片(编排生成流水线, 扣积分)"""
    return await episode_service.one_click_render(
        db, project_id, episode_id, org.id, current_user.id
    )


# ==================== 集内分镜(片段)管理 ====================

@router.get("/{episode_id}/clips")
async def list_episode_clips(
    project_id: UUID,
    episode_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """获取集内分镜(片段)列表"""
    result = await db.execute(
        select(Scene).where(Scene.episode_id == episode_id)
        .order_by(Scene.sequence.asc())
    )
    scenes = result.scalars().all()
    return [{
        "id": str(s.id), "sequence": s.sequence, "prompt": s.prompt,
        "shot_type": s.shot_type, "creation_mode": s.creation_mode,
        "status": s.status, "duration": s.duration,
        "thumbnail_url": s.thumbnail_url, "generated_video_url": s.generated_video_url,
        "camera_angle": s.camera_angle, "camera_movement": s.camera_movement,
        "mood": s.mood, "size": (s.meta or {}).get("size", "16:9"),
        "resolution": (s.meta or {}).get("resolution", "720p"),
        "quality": (s.meta or {}).get("quality", "hd"),
        "watermark_enabled": (s.meta or {}).get("watermark_enabled", False),
        "parsed_prompt": s.parsed_prompt,
    } for s in scenes]


@router.post("/{episode_id}/clips", status_code=201)
async def create_episode_clip(
    project_id: UUID,
    episode_id: UUID,
    body: dict,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """在集内新建分镜(片段)"""
    # 获取最大序号
    max_seq = await db.execute(
        select(func.max(Scene.sequence)).where(Scene.episode_id == episode_id)
    )
    seq = (max_seq.scalar() or 0) + 1
    # 需要关联 script(集的 script_id); 若无则用项目第一个script
    from app.models import Script
    ep = await episode_service.get_episode(db, project_id, episode_id)
    script_id = ep.script_id
    if script_id is None:
        sr = await db.execute(select(Script).where(Script.project_id == project_id).limit(1))
        sc = sr.scalar_one_or_none()
        script_id = sc.id if sc else None
    scene = Scene(
        script_id=script_id, episode_id=episode_id,
        sequence=seq, prompt=body.get("prompt", f"分镜{seq}"),
        shot_type=body.get("shot_type", "对话场景"),
        creation_mode=body.get("creation_mode", "image_to_video"),
        duration=body.get("duration", 5.0),
        meta={
            "size": body.get("size", "16:9"),
            "resolution": body.get("resolution", "720p"),
            "quality": body.get("quality", "hd"),
            "watermark_enabled": body.get("watermark_enabled", False),
        },
    )
    db.add(scene)
    await db.flush()
    await db.refresh(scene)
    return {
        "id": str(scene.id), "sequence": scene.sequence,
        "prompt": scene.prompt, "shot_type": scene.shot_type,
        "creation_mode": scene.creation_mode, "status": scene.status,
        "duration": scene.duration,
        "size": (scene.meta or {}).get("size", "16:9"),
        "resolution": (scene.meta or {}).get("resolution", "720p"),
    }


@router.put("/{episode_id}/clips/{clip_id}")
async def update_episode_clip(
    project_id: UUID,
    episode_id: UUID,
    clip_id: UUID,
    body: dict,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """编辑集内分镜(片段)：提示词/镜头类型/时长/分辨率/创作模式等。"""
    result = await db.execute(
        select(Scene).where(Scene.id == clip_id, Scene.episode_id == episode_id)
    )
    scene = result.scalar_one_or_none()
    if scene is None:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("Clip not found", resource="Scene")

    if "prompt" in body:
        scene.prompt = body["prompt"]
    if "shot_type" in body:
        scene.shot_type = body["shot_type"]
    if "creation_mode" in body:
        scene.creation_mode = body["creation_mode"]
    if "duration" in body:
        scene.duration = float(body["duration"])
    if "camera_angle" in body:
        scene.camera_angle = body["camera_angle"]
    if "camera_movement" in body:
        scene.camera_movement = body["camera_movement"]
    if "mood" in body:
        scene.mood = body["mood"]
    # size / resolution 存到 meta
    meta = dict(scene.meta or {})
    if "size" in body:
        meta["size"] = body["size"]
    if "resolution" in body:
        meta["resolution"] = body["resolution"]
    if "quality" in body:
        meta["quality"] = body["quality"]
    if "watermark_enabled" in body:
        meta["watermark_enabled"] = body["watermark_enabled"]
    if meta:
        scene.meta = meta

    await db.flush()
    await db.commit()
    return {
        "id": str(scene.id), "sequence": scene.sequence,
        "prompt": scene.prompt, "shot_type": scene.shot_type,
        "creation_mode": scene.creation_mode, "status": scene.status,
        "duration": scene.duration,
        "size": meta.get("size", "16:9"),
        "resolution": meta.get("resolution", "720p"),
    }


@router.delete("/{episode_id}/clips/{clip_id}")
async def delete_episode_clip(
    project_id: UUID,
    episode_id: UUID,
    clip_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """删除集内分镜(片段)，并重新连续编号。

    注意：scenes 表有 (script_id, sequence) 唯一约束。逐条 sequence -= 1 会触发
    临时唯一冲突（比如 7→6 时 6 还在）。所以删除后把该集剩余分镜全部重新从 1 编号，
    用临时大数偏移避免批量 UPDATE 中的冲突。
    """
    result = await db.execute(
        select(Scene).where(Scene.id == clip_id, Scene.episode_id == episode_id)
    )
    scene = result.scalar_one_or_none()
    if scene is None:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("Clip not found", resource="Scene")
    script_id = scene.script_id
    await db.delete(scene)
    await db.flush()

    # 重新连续编号：先把该集剩余分镜按原序号升序查出
    remaining = await db.execute(
        select(Scene).where(Scene.episode_id == episode_id)
        .order_by(Scene.sequence.asc())
    )
    clips = remaining.scalars().all()
    if clips:
        # 第一步：全部偏移到一个临时大值区间（避免唯一约束冲突）
        offset = 100000
        for i, s in enumerate(clips):
            s.sequence = offset + i
        await db.flush()
        # 第二步：从 1 重新连续编号
        for i, s in enumerate(clips, start=1):
            s.sequence = i
    await db.commit()
    return {"message": "Clip deleted", "clip_id": str(clip_id)}


# ==================== 集内素材成果(任务产出) ====================

@router.get("/{episode_id}/materials")
async def list_episode_materials(
    project_id: UUID,
    episode_id: UUID,
    category: Optional[str] = Query(None, description="image/video/lip_sync/agent/edit/favorite"),
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """获取集内素材成果(对标巨日禄: 全部/看图片/看视频/对口型/Agent/改视频/看收藏)"""
    stmt = select(GenerationTask).where(
        GenerationTask.episode_id == episode_id,
        GenerationTask.status == "completed",
    )
    # category 映射到 task type
    cat_map = {
        "image": ["image", "fusion", "image_edit"],
        "video": ["video", "image_to_video", "first_last_frame"],
        "lip_sync": ["lip_sync"],
        "agent": [],  # agent 类型暂无独立任务
        "edit": ["image_edit"],
    }
    if category and category in cat_map and cat_map[category]:
        stmt = stmt.where(GenerationTask.type.in_(cat_map[category]))
    stmt = stmt.order_by(GenerationTask.created_at.desc()).limit(100)
    result = await db.execute(stmt)
    tasks = result.scalars().all()

    # 预查该集所有分镜，建 id→sequence 映射（避免逐任务查 DB）
    scene_seq_map: Dict[str, int] = {}
    scene_prompt_map: Dict[str, str] = {}
    sc_result = await db.execute(
        select(Scene).where(Scene.episode_id == episode_id)
    )
    for sc in sc_result.scalars().all():
        scene_seq_map[str(sc.id)] = sc.sequence
        scene_prompt_map[str(sc.id)] = (sc.prompt or "")[:60]

    out = []
    for t in tasks:
        if not t.output_urls:
            continue
        # 从 input_data 提取 scene_id，关联分镜序号
        in_data = t.input_data or {}
        scene_id = in_data.get("scene_id") if isinstance(in_data, dict) else None
        scene_seq = scene_seq_map.get(scene_id) if scene_id else None
        scene_prompt = scene_prompt_map.get(scene_id) if scene_id else None
        out.append({
            "task_id": str(t.id),
            "type": t.type,
            "model": t.model,
            "urls": t.output_urls,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "meta": t.meta,
            "scene_sequence": scene_seq,
            "scene_prompt": scene_prompt,
        })
    return out


# ==================== Agent 模式 (对标巨日禄 Agent) ====================

@router.post("/{episode_id}/agent")
async def run_agent(
    project_id: UUID,
    episode_id: UUID,
    body: Dict[str, Any],
    project: Project = Depends(verify_project_ownership),
    org: Organization = Depends(get_current_org),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Agent 模式：用户给自然语言目标，Agent 自动编排资源查找/新建/生图/生视频/建分镜。

    body:
        goal: str         - 自然语言目标（必填）
        options?: dict    - 可选 shot_type/size/refine 等
    返回:
        agent_run_id, status, steps, artifacts
    """
    from app.services.agent_service import AgentService
    from app.services.llm_client import LLMClient

    goal = (body or {}).get("goal", "").strip()
    if not goal:
        from app.core.exceptions import BadRequestException
        raise BadRequestException("goal is required")
    options = body.get("options") or {}

    llm = await LLMClient.from_config(db)
    agent = AgentService(db, llm)
    result = await agent.run(
        project_id=project_id,
        episode_id=episode_id,
        org_id=org.id,
        user_id=current_user.id,
        goal=goal,
        options=options,
    )
    await db.commit()
    return result


@router.get("/{episode_id}/agent/{agent_run_id}")
async def get_agent_status(
    project_id: UUID,
    episode_id: UUID,
    agent_run_id: str,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """查询某次 agent 运行的状态（前端轮询用，聚合 meta.agent_run_id 相同的任务）"""
    from app.services.agent_service import get_agent_run_status
    return await get_agent_run_status(db, episode_id, agent_run_id)


# ==================== Agent 向导模式（剧本驱动 4 阶段，对标巨日禄） ====================

@router.post("/{episode_id}/wizard/start")
async def wizard_start(
    project_id: UUID,
    episode_id: UUID,
    body: Dict[str, Any],
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """
    启动向导：提交整集剧本 + 选择模式 → 异步解析资产。
    body: { script_content: str, mode: "fusion"|"image_to_video"|"composite"|"ppt", script_id?: str }

    异步模式：立即返回 task_id，LLM 解析在后台进行。
    前端用 GET /{episode_id}/wizard/start/status/{task_id} 轮询结果。

    script_id 可选：
    - 传入：从该 Script 读 content，并关联 Episode.script_id
    - 不传：用手动粘贴的 script_content，自动创建一个 Script 并关联到 Episode
    """
    from app.core.exceptions import BadRequestException
    from app.services import gen_task_tracker

    mode = (body or {}).get("mode", "fusion")
    script_id_raw = (body or {}).get("script_id")

    # 确定剧本内容 + script_id（同步快操作，不涉及 LLM）
    script_id = None
    if script_id_raw:
        # 从已有剧本加载内容
        try:
            sid = UUID(str(script_id_raw))
        except (ValueError, TypeError):
            raise BadRequestException("无效的 script_id")
        sc_result = await db.execute(
            select(Script).where(Script.id == sid, Script.project_id == project_id)
        )
        sc = sc_result.scalar_one_or_none()
        if sc is None:
            raise BadRequestException("剧本不存在或不属于当前项目")
        script_content = sc.content or ""
        script_id = sid
    else:
        # 手动粘贴
        script_content = (body or {}).get("script_content", "").strip()
        if not script_content:
            raise BadRequestException("script_content is required（或传入 script_id）")
        # 自动创建 Script 并关联
        ep = await db.execute(select(Episode).where(Episode.id == episode_id))
        ep_obj = ep.scalar_one_or_none()
        ep_title = f"第{ep_obj.number}集" if ep_obj else "剧本"
        new_sc = Script(project_id=project_id, title=f"{ep_title}剧本", content=script_content, format="plain")
        db.add(new_sc)
        await db.flush()
        script_id = new_sc.id

    # 提交 Script 创建（确保后台任务能看到）
    await db.commit()

    # 创建异步任务（LLM 解析在后台进行，不阻塞响应）
    task_id = gen_task_tracker.create_task("wizard_parse", str(episode_id))
    from app.core.background import spawn_background
    spawn_background(_async_wizard_parse(task_id, episode_id, script_content, mode, script_id))

    return {"task_id": task_id, "status": "processing"}


async def _async_wizard_parse(task_id: str, episode_id: UUID, script_content: str, mode: str, script_id: Optional[UUID]):
    """后台异步执行 Agent 向导的剧本解析。"""
    from app.services import gen_task_tracker
    from app.core.database import AsyncSessionLocal
    try:
        async with AsyncSessionLocal() as db:
            from app.services.agent_service import WizardAgentService
            from app.services.llm_client import LLMClient
            llm = await LLMClient.from_config(db=db)
            wizard = WizardAgentService(db, llm)
            result = await wizard.stage_parse_script(episode_id, script_content, mode, script_id=script_id)
            await db.commit()
        gen_task_tracker.complete_task(task_id, result)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"Wizard parse failed: {e}")
        gen_task_tracker.fail_task(task_id, str(e)[:500])


@router.get("/{episode_id}/wizard/start/status/{task_id}")
async def wizard_start_status(
    project_id: UUID,
    episode_id: UUID,
    task_id: str,
    project: Project = Depends(verify_project_ownership),
):
    """轮询 Agent 向导剧本解析的异步任务状态。
    返回 {status: processing/completed/failed, result?, error?}
    """
    from app.services import gen_task_tracker
    task = gen_task_tracker.get_task(task_id)
    if task is None:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("Task not found")
    return {
        "status": task["status"],
        "result": task.get("result"),
        "error": task.get("error"),
    }


@router.get("/{episode_id}/wizard")
async def wizard_get(
    project_id: UUID,
    episode_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """查询向导当前阶段和数据（前端打开时恢复用）"""
    from app.services.agent_service import WizardAgentService
    wizard = WizardAgentService(db, None)
    return await wizard.get_wizard_state(episode_id)


@router.put("/{episode_id}/wizard/stage")
async def wizard_set_stage(
    project_id: UUID,
    episode_id: UUID,
    body: Dict[str, Any],
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """手动设置向导阶段（body: {stage: "script_input"|"assets"|"scenes"|"edit"|"completed"}）"""
    from app.services.agent_service import WizardAgentService
    stage = (body or {}).get("stage", "script_input")
    wizard = WizardAgentService(db, None)
    result = await wizard.set_wizard_stage(episode_id, stage)
    await db.commit()
    return result


@router.post("/{episode_id}/wizard/parse")
async def wizard_reparse(
    project_id: UUID,
    episode_id: UUID,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """重新解析剧本（用已存的 wizard_script，可换模式重解析）"""
    from app.services.agent_service import WizardAgentService
    from app.services.llm_client import LLMClient
    llm = await LLMClient.from_config(db)
    wizard = WizardAgentService(db, llm)
    state = await wizard.get_wizard_state(episode_id)
    if not state.get("has_script"):
        from app.core.exceptions import BadRequestException
        raise BadRequestException("no script to reparse, call /wizard/start first")
    # 重新解析用已存的脚本和模式
    ep_result = await db.execute(select(Episode).where(Episode.id == episode_id))
    ep = ep_result.scalar_one()
    script_content = (ep.meta or {}).get("wizard_script", "")
    mode = (ep.meta or {}).get("wizard_mode", "fusion")
    result = await wizard.stage_parse_script(episode_id, script_content, mode)
    await db.commit()
    return result


@router.put("/{episode_id}/wizard/assets")
async def wizard_save_assets(
    project_id: UUID,
    episode_id: UUID,
    body: Dict[str, Any],
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """保存资产分配（body: {assignments: {"character:沈知意": "resource_uuid", ...}}）"""
    from app.services.agent_service import WizardAgentService
    assignments = (body or {}).get("assignments") or {}
    wizard = WizardAgentService(db, None)
    result = await wizard.stage_save_assets(episode_id, assignments)
    await db.commit()
    return result


@router.post("/{episode_id}/wizard/split-scenes")
async def wizard_split_scenes(
    project_id: UUID,
    episode_id: UUID,
    body: Dict[str, Any] = None,
    project: Project = Depends(verify_project_ownership),
    db: AsyncSession = Depends(get_db),
):
    """生成/重拆分镜（把 wizard_data.shots 写入 Scene 表）。
    body: { force?: bool } — 已有已生成分镜时，force=True 才允许重拆（避免覆盖）。
    """
    from app.services.agent_service import WizardAgentService
    force = bool((body or {}).get("force", False))
    wizard = WizardAgentService(db, None)
    result = await wizard.stage_split_scenes(episode_id, force=force)
    await db.commit()
    return result


@router.post("/{episode_id}/wizard/generate")
async def wizard_generate(
    project_id: UUID,
    episode_id: UUID,
    body: Dict[str, Any],
    project: Project = Depends(verify_project_ownership),
    org: Organization = Depends(get_current_org),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    触发视频生成。
    body: {
        scene_ids?: [uuid],
        mode?: "fusion"|"image_to_video"|"composite"|"ppt",
        gen_params?: { model, size, duration, resolution, quality, watermark_enabled }
    }
    scene_ids 为空则生成该集全部分镜。
    gen_params 由前端阶段4的参数面板提供（模型/尺寸/时长/分辨率/质量/水印）。
    """
    from app.services.agent_service import WizardAgentService
    scene_ids = (body or {}).get("scene_ids") or None
    mode = (body or {}).get("mode")
    gen_params = (body or {}).get("gen_params") or None
    # 转 UUID
    uuid_scene_ids = None
    if scene_ids:
        uuid_scene_ids = [UUID(s) for s in scene_ids]

    wizard = WizardAgentService(db, None)
    result = await wizard.stage_generate_videos(
        episode_id, org.id, current_user.id, uuid_scene_ids, mode, gen_params=gen_params,
    )
    await db.commit()
    return result


