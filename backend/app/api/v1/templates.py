"""Templates API（M9）—— 模板库 + 新手引导。

三块能力，共一个文件（同属「新用户第一支片子」闭环）：
1. 官方示例项目：GET /project-templates 列表、POST .../clone 一键克隆整树
2. 剧本模板：GET /script-templates 按题材列出、GET 详情、POST .../use
   一键「用模板创建项目」（建项目 + 预填剧本正文，之后走正常 AI 解析流程）
3. 新手引导：GET /onboarding/status（新手任务进度，从真实数据推导）、
   POST /onboarding/dismiss（关闭引导）
"""
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import BadRequestException, NotFoundException
from app.core.security import get_current_user
from app.models import (
    Project, User, Organization, Script, Character, SceneBackground,
    Scene, GenerationTask, ScriptTemplate,
)
from app.api.deps import get_current_org
from app.api.v1.projects import _fill_counts
from app.services import template_service

router = APIRouter()


# ==================== 官方示例项目 ====================

@router.get("/project-templates")
async def list_project_templates(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """官方示例项目列表（模板库首页卡片数据）。"""
    result = await db.execute(
        select(Project)
        .where(Project.is_template.is_(True))
        .order_by(Project.template_sort.asc(), Project.created_at.asc())
    )
    templates = result.scalars().all()
    items = []
    for p in templates:
        counts = await _fill_counts(db, p)
        settings = p.settings or {}
        items.append({
            "id": str(p.id), "name": p.name,
            "genre": p.template_genre, "description": p.template_desc or p.description,
            "cover_image_url": p.cover_image_url,
            "status": p.status,
            "use_count": int(settings.get("template_use_count", 0)),
            **counts,
        })
    return {"items": items, "total": len(items)}


class CloneRequest(BaseModel):
    name: Optional[str] = Field(None, max_length=255)


@router.post("/project-templates/{template_id}/clone")
async def clone_project_template(
    template_id: UUID,
    body: CloneRequest = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    current_org: Organization = Depends(get_current_org),
):
    """一键克隆官方示例项目（剧本/角色/场景/道具/集/分镜全套）。"""
    name = (body.name if body else None) or None
    project = await template_service.clone_template_project(
        db, template_id, current_user, current_org, name=name)
    counts = await _fill_counts(db, project)
    return {
        "message": "克隆完成，已复制完整示例内容",
        "project": {
            "id": str(project.id), "name": project.name,
            "description": project.description,
            "cover_image_url": project.cover_image_url,
            "status": project.status,
            **counts,
        },
    }


# ==================== 剧本模板（按题材分类） ====================

@router.get("/script-templates")
async def list_script_templates(
    genre: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """剧本模板列表（可按题材筛选），按题材分组返回。"""
    stmt = select(ScriptTemplate).where(ScriptTemplate.is_active.is_(True))
    if genre:
        stmt = stmt.where(ScriptTemplate.genre == genre)
    stmt = stmt.order_by(ScriptTemplate.sort_order.asc(), ScriptTemplate.created_at.asc())
    rows = (await db.execute(stmt)).scalars().all()
    items: List[Dict[str, Any]] = []
    genres: List[str] = []
    for t in rows:
        if t.genre not in genres:
            genres.append(t.genre)
        items.append({
            "id": t.id, "genre": t.genre, "title": t.title,
            "logline": t.logline, "description": t.description,
            "tags": t.tags or [], "episode_count": t.episode_count,
            "character_count": len(t.characters or []),
            "content_length": len(t.content or ""),
            "use_count": t.use_count,
        })
    return {"items": items, "genres": genres, "total": len(items)}


@router.get("/script-templates/{template_id}")
async def get_script_template(
    template_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """剧本模板详情（含完整正文与推荐角色设定）。"""
    t = (await db.execute(
        select(ScriptTemplate).where(
            ScriptTemplate.id == template_id, ScriptTemplate.is_active.is_(True))
    )).scalar_one_or_none()
    if t is None:
        raise NotFoundException("剧本模板不存在或已下架")
    return {
        "id": t.id, "genre": t.genre, "title": t.title,
        "logline": t.logline, "description": t.description,
        "tags": t.tags or [], "content": t.content,
        "characters": t.characters or [],
        "episode_count": t.episode_count, "use_count": t.use_count,
    }


class UseScriptTemplateRequest(BaseModel):
    project_name: Optional[str] = Field(None, max_length=255)
    project_description: Optional[str] = None


@router.post("/script-templates/{template_id}/use")
async def use_script_template(
    template_id: str,
    body: UseScriptTemplateRequest = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    current_org: Organization = Depends(get_current_org),
):
    """用剧本模板创建项目：建项目 + 预填剧本正文（未解析状态），
    用户进入剧本编辑器后点「AI 解析」继续。"""
    t = (await db.execute(
        select(ScriptTemplate).where(
            ScriptTemplate.id == template_id, ScriptTemplate.is_active.is_(True))
    )).scalar_one_or_none()
    if t is None:
        raise NotFoundException("剧本模板不存在或已下架")

    # 项目数上限与普通创建共用同一约束
    from app.services.settings_service import get_setting
    from sqlalchemy import func as sa_func
    max_projects = await get_setting(db, "max_project_per_user", 0)
    if max_projects and max_projects > 0:
        count = (await db.execute(
            select(sa_func.count(Project.id)).where(
                Project.user_id == current_user.id, Project.is_template.is_(False))
        )).scalar() or 0
        if count >= max_projects:
            raise BadRequestException(f"已达项目数量上限（{max_projects} 个），请删除旧项目或联系管理员")

    project = Project(
        user_id=current_user.id,
        org_id=current_org.id,
        name=(body.project_name if body and body.project_name else t.title)[:255],
        description=(body.project_description if body and body.project_description
                     else t.logline),
        status="draft",
        settings={"from_script_template": t.id},
    )
    db.add(project)
    await db.flush()

    from app.services.project_member_service import ensure_owner_on_create
    await ensure_owner_on_create(db, project.id, current_user.id)

    script = Script(
        project_id=project.id,
        title=t.title,
        content=t.content,
        parsed_data=None,  # 未解析：用户确认后走正常 AI 解析入库
    )
    db.add(script)
    t.use_count = (t.use_count or 0) + 1
    await db.commit()

    return {
        "message": "已用模板创建项目",
        "project_id": str(project.id),
        "script_id": str(script.id),
    }


# ==================== 新手引导 ====================

@router.get("/onboarding/status")
async def onboarding_status(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """新手任务进度。任务完成与否从真实创作数据推导（不存冗余状态，
    数据不会和引导进度脱节）：创建项目 / 完成剧本解析 / 发起一次生成。"""
    uid = current_user.id
    own_projects = select(Project.id).where(
        Project.user_id == uid, Project.is_template.is_(False))
    parsed_scripts = select(Script.id).where(
        Script.project_id.in_(own_projects), Script.parsed_data.isnot(None))
    generation_tasks = select(GenerationTask.id).where(
        GenerationTask.user_id == uid, GenerationTask.deleted_at.is_(None))
    has_project = bool((await db.execute(select(own_projects.exists()))).scalar())
    has_parsed = bool((await db.execute(select(parsed_scripts.exists()))).scalar())
    has_generation = bool((await db.execute(select(generation_tasks.exists()))).scalar())

    onboarding = current_user.onboarding or {}
    return {
        "checklist": {
            "created_project": has_project,
            "parsed_script": has_parsed,
            "first_generation": has_generation,
        },
        "is_new_user": not (has_project or has_parsed or has_generation),
        "tour_done": bool(onboarding.get("tour_done")),
        "checklist_dismissed": bool(onboarding.get("checklist_dismissed")),
    }


class DismissRequest(BaseModel):
    what: str = Field("all", pattern="^(tour|checklist|all)$")


@router.post("/onboarding/dismiss")
async def dismiss_onboarding(
    body: DismissRequest = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """关闭新手引导（tour / 任务清单 / 全部）。"""
    what = body.what if body else "all"
    state = dict(current_user.onboarding or {})
    if what in ("tour", "all"):
        state["tour_done"] = True
    if what in ("checklist", "all"):
        state["checklist_dismissed"] = True
    current_user.onboarding = state
    await db.commit()
    return {"ok": True, "onboarding": state}
