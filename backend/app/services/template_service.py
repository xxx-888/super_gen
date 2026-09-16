"""模板服务（M9）：官方示例项目一键克隆。

把模板项目（Project.is_template=True）的完整创作树复制到当前用户名下：
Script / Character / SceneBackground / Prop / AudioAsset / VideoAsset /
Episode / Scene / SceneAsset 全量复制，引用关系（episode→script、
scene→episode、scene_asset→resource）按新旧 id 映射重建。

刻意不复制的：
- generation_tasks：生成任务属于操作记录，不属于创作资产
- canvases：画布 graph_data 里内嵌的是模板项目的节点 id，跨项目复制
  全部失效，等画布支持节点重映射后再开放
- Scene.generated_video_url / thumbnail_url：成片是模板的演示产物，
  克隆后应回到「待生成」状态让用户自己跑一遍流程
"""
import copy
from typing import Any, Dict, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    Project, User, Organization, Script, Character, SceneBackground, Prop,
    AudioAsset, VideoAsset, Episode, Scene, SceneAsset,
)
from app.core.exceptions import NotFoundException, BadRequestException


def _json(value: Any, default: Any) -> Any:
    """深拷贝 JSON 字段：同一 session 里模板对象与新对象共享可变结构会有串改风险。"""
    return copy.deepcopy(value) if value is not None else copy.deepcopy(default)


async def clone_template_project(
    db: AsyncSession,
    template_id: UUID,
    current_user: User,
    current_org: Organization,
    name: Optional[str] = None,
) -> Project:
    """把模板项目整树克隆为 current_user 名下的新项目。"""
    result = await db.execute(
        select(Project)
        .where(Project.id == template_id, Project.is_template.is_(True))
        .options(
            selectinload(Project.scripts),
            selectinload(Project.characters),
            selectinload(Project.scene_backgrounds),
            selectinload(Project.props),
            selectinload(Project.audio_assets),
            selectinload(Project.video_assets),
            selectinload(Project.episodes).selectinload(Episode.scenes).selectinload(Scene.assets),
        )
    )
    tpl = result.scalar_one_or_none()
    if tpl is None:
        raise NotFoundException("模板项目不存在或已下架", resource="Project")

    # 项目数上限（与普通创建一致的后台配置约束）
    from app.services.settings_service import get_setting
    from sqlalchemy import func as sa_func
    max_projects = await get_setting(db, "max_project_per_user", 0)
    if max_projects and max_projects > 0:
        count = (await db.execute(
            select(sa_func.count(Project.id)).where(
                Project.user_id == current_user.id, Project.is_template.is_(False)
            )
        )).scalar() or 0
        if count >= max_projects:
            raise BadRequestException(f"已达项目数量上限（{max_projects} 个），请删除旧项目或联系管理员")

    new_project = Project(
        user_id=current_user.id,
        org_id=current_org.id,
        name=(name or f"{tpl.name}·我的副本").strip()[:255],
        description=tpl.description,
        cover_image_url=tpl.cover_image_url,
        status="draft",
        settings={"cloned_from_template": str(tpl.id)},
    )
    db.add(new_project)
    await db.flush()

    from app.services.project_member_service import ensure_owner_on_create
    await ensure_owner_on_create(db, new_project.id, current_user.id)

    # ---- 项目级资源：旧 id → 新对象映射（SceneAsset 多态引用要用）----
    char_map: Dict[UUID, Character] = {}
    for c in tpl.characters:
        nc = Character(
            project_id=new_project.id, name=c.name,
            appearance_prompt=c.appearance_prompt, description=c.description,
            image_url=c.image_url, images=_json(c.images, []),
            voice_id=c.voice_id, meta=_json(c.meta, {}),
        )
        db.add(nc)
        char_map[c.id] = nc

    bg_map: Dict[UUID, SceneBackground] = {}
    for b in tpl.scene_backgrounds:
        nb = SceneBackground(
            project_id=new_project.id, name=b.name,
            prompt=b.prompt, description=b.description,
            image_url=b.image_url, meta=_json(b.meta, {}),
        )
        db.add(nb)
        bg_map[b.id] = nb

    prop_map: Dict[UUID, Prop] = {}
    for p in tpl.props:
        np = Prop(
            project_id=new_project.id, name=p.name,
            prompt=p.prompt, description=p.description,
            image_url=p.image_url, meta=_json(p.meta, {}),
        )
        db.add(np)
        prop_map[p.id] = np

    audio_map: Dict[UUID, AudioAsset] = {}
    for a in tpl.audio_assets:
        na = AudioAsset(
            project_id=new_project.id, character_id=char_map.get(a.character_id).id if a.character_id and a.character_id in char_map else None,
            type=a.type, name=a.name, url=a.url,
            duration=a.duration, meta=_json(a.meta, {}),
        )
        db.add(na)
        audio_map[a.id] = na

    for v in tpl.video_assets:
        db.add(VideoAsset(
            project_id=new_project.id, type=v.type, name=v.name,
            url=v.url, thumbnail_url=v.thumbnail_url,
            duration=v.duration, meta=_json(v.meta, {}),
        ))

    await db.flush()

    # ---- 剧本 ----
    script_map: Dict[UUID, Script] = {}
    for s in tpl.scripts:
        ns = Script(
            project_id=new_project.id, title=s.title,
            content=s.content, format=s.format,
            parsed_data=_json(s.parsed_data, None),
        )
        db.add(ns)
        script_map[s.id] = ns
    await db.flush()

    # ---- 集 + 分镜 + 分镜资源引用 ----
    resource_maps = {
        "character": char_map, "scene_bg": bg_map,
        "prop": prop_map, "audio": audio_map,
    }
    for ep in sorted(tpl.episodes, key=lambda e: (e.sort_order or 0, e.number)):
        ne = Episode(
            project_id=new_project.id,
            script_id=script_map[ep.script_id].id if ep.script_id and ep.script_id in script_map else None,
            number=ep.number, title=ep.title,
            status="asset",  # 克隆回到初始状态，走一遍正常制作流程
            stop_after_step=ep.stop_after_step, smart_review=ep.smart_review,
            cover_image_url=ep.cover_image_url, sort_order=ep.sort_order,
        )
        db.add(ne)
        await db.flush()

        cloned_scenes = []
        for sc in sorted(ep.scenes, key=lambda x: x.sequence):
            sid = nsc_script_id(script_map, sc)
            if sid is None:
                continue  # script 非空外键，映射缺失说明模板数据不完整，跳过该分镜
            nsc = Scene(
                script_id=sid,
                episode_id=ne.id,
                sequence=sc.sequence, scene_type=sc.scene_type,
                prompt=sc.prompt, parsed_prompt=_json(sc.parsed_prompt, None),
                duration=sc.duration, camera_angle=sc.camera_angle,
                camera_movement=sc.camera_movement, mood=sc.mood,
                shot_type=sc.shot_type, creation_mode=sc.creation_mode,
                status="ready",  # 与解析确认后的状态一致：可直接发起生成
                meta={},
            )
            db.add(nsc)
            cloned_scenes.append((nsc, sc.assets))
        await db.flush()

        for nsc, old_assets in cloned_scenes:
            for sa in old_assets:
                res_map = resource_maps.get(sa.resource_type or "")
                target = res_map.get(sa.resource_id) if res_map else None
                if target is None:
                    continue  # 模板演进中可能残留失效引用，克隆时静默丢弃
                db.add(SceneAsset(
                    scene_id=nsc.id, resource_type=sa.resource_type,
                    resource_id=target.id,
                    position=sa.position, usage_context=sa.usage_context,
                ))

    # ---- 模板使用计数 ----
    settings = dict(tpl.settings or {})
    settings["template_use_count"] = int(settings.get("template_use_count", 0)) + 1
    tpl.settings = settings

    await db.commit()
    await db.refresh(new_project)
    return new_project


def nsc_script_id(script_map: Dict[UUID, Script], sc: Scene) -> Optional[UUID]:
    ns = script_map.get(sc.script_id) if sc.script_id else None
    return ns.id if ns else None
