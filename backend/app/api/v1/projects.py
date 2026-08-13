"""
Projects API - 项目管理接口
"""
import secrets
from fastapi import APIRouter, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from typing import List, Optional
from uuid import UUID

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import NotFoundException, BadRequestException, ForbiddenException
from app.models import (
    Project,
    User,
    Organization,
    Script,
    Character,
    SceneBackground,
    Prop,
    AudioAsset,
    Scene,
    ProjectMember,
)
from app.schemas import (
    ProjectCreate,
    ProjectUpdate,
    ProjectResponse,
    ProjectDetail,
    ProjectStats,
)
from app.api.deps import CommonQueryParams, verify_project_ownership, get_current_org
from app.services import project_member_service

router = APIRouter()


async def _fill_counts(db: AsyncSession, project: Project) -> dict:
    """查项目的剧本数/分镜数/角色数/成员数，拼到响应 dict 里。"""
    pid = project.id
    # 剧本数
    r1 = await db.execute(select(func.count(Script.id)).where(Script.project_id == pid))
    script_count = r1.scalar() or 0
    # 分镜数（通过 script 关联）
    r2 = await db.execute(
        select(func.count(Scene.id))
        .join(Script, Scene.script_id == Script.id)
        .where(Script.project_id == pid)
    )
    scene_count = r2.scalar() or 0
    # 角色数
    r3 = await db.execute(select(func.count(Character.id)).where(Character.project_id == pid))
    character_count = r3.scalar() or 0
    # 成员数
    r4 = await db.execute(select(func.count(ProjectMember.id)).where(ProjectMember.project_id == pid))
    member_count = r4.scalar() or 0
    return {
        "script_count": script_count, "scene_count": scene_count,
        "character_count": character_count, "member_count": member_count,
    }


@router.get("", response_model=List[ProjectResponse])
async def get_projects(
    org_id: Optional[UUID] = None,
    params: CommonQueryParams = Depends(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取我的项目列表（自己创建的 + 作为成员加入的）。

    可传 org_id 按团队筛选（切换团队时只看该团队的项目）。
    """
    # 查用户参与的所有 project_id（创建的 + 加入的）
    member_project_ids_stmt = select(ProjectMember.project_id).where(
        ProjectMember.user_id == current_user.id
    )
    member_result = await db.execute(member_project_ids_stmt)
    member_pids = [row[0] for row in member_result.all()]

    from sqlalchemy import or_
    stmt = select(Project).where(
        or_(
            Project.user_id == current_user.id,
            Project.id.in_(member_pids) if member_pids else False,
        )
    )

    # 按团队筛选（前端切换团队后传入）。
    # 关键：团队筛选只作用于「自己创建的项目」；「作为成员加入的项目」无论归属哪个
    # 团队都必须可见——否则加入别人的项目（org 归属对方）会被滤掉，出现"必须刷新才显示"。
    if org_id is not None:
        stmt = stmt.where(
            or_(
                Project.org_id == org_id,
                Project.id.in_(member_pids) if member_pids else False,
            )
        )

    # 排序
    sort_field = params.sort_by or "created_at"
    sort_column = getattr(Project, sort_field, Project.created_at)
    if params.sort_order == "asc":
        stmt = stmt.order_by(sort_column.asc())
    else:
        stmt = stmt.order_by(sort_column.desc())

    stmt = stmt.offset(params.offset).limit(params.page_size)
    result = await db.execute(stmt)
    projects = result.scalars().all()
    # 填充统计数
    out = []
    for p in projects:
        d = {
            "id": str(p.id), "name": p.name, "description": p.description,
            "status": p.status, "cover_image_url": p.cover_image_url,
            "user_id": str(p.user_id), "settings": p.settings or {},
            "created_at": p.created_at, "updated_at": p.updated_at,
        }
        d.update(await _fill_counts(db, p))
        out.append(d)
    return out


@router.post("", response_model=ProjectResponse, status_code=201)
async def create_project(
    body: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    current_org: Organization = Depends(get_current_org),
):
    """创建项目"""
    # 检查用户项目数上限（后台「系统设置」控制）
    from app.services.settings_service import get_setting
    from sqlalchemy import func as sa_func
    max_projects = await get_setting(db, "max_project_per_user", 0)
    if max_projects and max_projects > 0:
        count_result = await db.execute(
            select(sa_func.count(Project.id)).where(Project.user_id == current_user.id)
        )
        current_count = count_result.scalar() or 0
        if current_count >= max_projects:
            from app.core.exceptions import BadRequestException
            raise BadRequestException(f"已达项目数量上限（{max_projects} 个），请删除旧项目或联系管理员")

    project = Project(
        user_id=current_user.id,
        org_id=current_org.id,
        name=body.name,
        description=body.description,
        cover_image_url=body.cover_image_url,
        settings=body.settings or {},
    )
    db.add(project)
    await db.flush()
    await db.refresh(project)
    # 自动把创建者加为项目 owner
    from app.services.project_member_service import ensure_owner_on_create
    await ensure_owner_on_create(db, project.id, current_user.id)
    await db.commit()
    return project


# ==================== 邀请链接 / 访问密码 ====================
# 注意：/join 必须在 /{project_id} 之前注册，否则 "join" 会被当 project_id

@router.get("/join")
async def get_join_info(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    """凭邀请 token 查询要加入的项目信息（无需登录，供加入页面展示）。"""
    if not token:
        raise BadRequestException("token is required")
    result = await db.execute(
        select(Project).where(Project.settings["invite_token"].astext == token)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise NotFoundException("邀请链接无效或已失效")
    settings = project.settings or {}
    return {
        "project_id": str(project.id),
        "project_name": project.name,
        "description": project.description,
        "has_password": bool(settings.get("access_password")),
    }


@router.post("/join")
async def join_project_by_invite(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """凭邀请 token（+访问密码）加入项目。"""
    token = (body or {}).get("token", "").strip()
    password = (body or {}).get("password", "") or ""
    role = (body or {}).get("role", "editor") or "editor"
    if not token:
        raise BadRequestException("token is required")

    result = await db.execute(
        select(Project).where(Project.settings["invite_token"].astext == token)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise NotFoundException("邀请链接无效或已失效")

    settings = project.settings or {}
    if settings.get("access_password"):
        if password != settings["access_password"]:
            raise ForbiddenException("访问密码错误")

    existing = await db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == current_user.id,
        )
    )
    if existing.scalar_one_or_none():
        raise BadRequestException("你已是该项目成员")

    member = ProjectMember(
        project_id=project.id, user_id=current_user.id,
        role=role if role in ("manager", "editor", "viewer") else "editor",
    )
    db.add(member)
    await db.commit()
    return {"project_id": str(project.id), "project_name": project.name, "role": member.role}


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取项目详情"""
    stmt = (
        select(Project)
        .options(
            selectinload(Project.scripts),
            selectinload(Project.characters),
            selectinload(Project.scene_backgrounds),
            selectinload(Project.props),
            selectinload(Project.audio_assets),
        )
        .where(Project.id == project_id)
    )
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()

    if not project:
        raise NotFoundException("Project not found")

    # 返回 dict 并填充统计数
    d = {
        "id": str(project.id), "name": project.name, "description": project.description,
        "status": project.status, "cover_image_url": project.cover_image_url,
        "user_id": str(project.user_id), "settings": project.settings or {},
        "created_at": project.created_at, "updated_at": project.updated_at,
    }
    d.update(await _fill_counts(db, project))
    return d


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: UUID,
    body: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新项目"""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        raise NotFoundException("Project not found")

    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        project.description = body.description
    if body.cover_image_url is not None:
        project.cover_image_url = body.cover_image_url
    if body.status is not None:
        project.status = body.status
    if body.settings is not None:
        project.settings = body.settings

    await db.flush()
    await db.refresh(project)
    await db.commit()
    return project


@router.delete("/{project_id}")
async def delete_project(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除项目

    删除完全交给数据库原生级联（见迁移 b8e1f4d02a7c）：
      - 归属型子表(*.project_id / scenes.script_id / scenes.episode_id) ON DELETE CASCADE，
        随 DELETE FROM projects 一并删；
      - 保留型表(credit_transactions / works) ON DELETE SET NULL，记录保留、引用置空。
    关系上配了 passive_deletes=True，所以 ORM 不会逐行加载子表，只发一条 DELETE。
    ⚠️ 依赖该迁移已执行；未执行前删除会因外键违约失败。
    """
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        raise NotFoundException("Project not found")

    # 仅项目所有者或平台管理员可删除；被邀请加入的成员无权删除，应改用「退出项目」
    if project.user_id != current_user.id and current_user.role != "admin":
        raise ForbiddenException("无权删除该项目：仅项目所有者或管理员可删除")

    await db.delete(project)
    await db.commit()
    return {"message": "deleted"}


@router.post("/{project_id}/leave")
async def leave_project(
    project_id: UUID,
    project: Project = Depends(verify_project_ownership),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """退出项目（成员把自己从项目中移除，项目本身保留给所有者）。

    - 仅成员可退出；项目所有者（创建者）不能退出，需先转让所有权或删除项目。
    - verify_project_ownership 已确保当前用户是 成员/创建者/admin 之一。
    """
    if project.user_id == current_user.id:
        raise BadRequestException("项目所有者不能退出，请先转让所有权或删除项目")
    await project_member_service.leave_project(db, project_id, current_user.id)
    await db.commit()
    return {"message": "left"}


@router.get("/{project_id}/stats", response_model=ProjectStats)
async def get_project_stats(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取项目统计信息"""
    # 验证项目存在
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise NotFoundException("Project not found")

    # 查询该项目下所有分镜（通过 script 关联）
    stmt = (
        select(Scene)
        .join(Script, Scene.script_id == Script.id)
        .where(Script.project_id == project_id)
    )
    result = await db.execute(stmt)
    scenes = result.scalars().all()

    total_scenes = len(scenes)
    completed_scenes = sum(1 for s in scenes if s.status == "completed")
    pending_scenes = sum(1 for s in scenes if s.status == "pending")
    failed_scenes = sum(1 for s in scenes if s.status == "failed")
    total_duration = sum(s.duration or 0 for s in scenes)

    return ProjectStats(
        total_scenes=total_scenes,
        completed_scenes=completed_scenes,
        pending_scenes=pending_scenes,
        failed_scenes=failed_scenes,
        total_duration=total_duration,
        estimated_cost=0.0,
    )


# ==================== 邀请链接 / 访问密码 ====================

@router.post("/{project_id}/invite-link")
async def generate_invite_link(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """生成/重置项目邀请链接 token（返回完整链接）。"""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise NotFoundException("Project not found")
    if project.user_id != current_user.id and current_user.role != "admin":
        raise ForbiddenException("只有项目创建者能生成邀请链接")

    token = secrets.token_urlsafe(16)
    settings = dict(project.settings or {})
    settings["invite_token"] = token
    project.settings = settings
    await db.commit()

    return {"invite_token": token, "invite_url": f"/projects/join?token={token}"}


@router.put("/{project_id}/access-password")
async def set_access_password(
    project_id: UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """设置/清除项目访问密码（body: {password: "xxx"}，空字符串清除）。"""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise NotFoundException("Project not found")
    if project.user_id != current_user.id and current_user.role != "admin":
        raise ForbiddenException("只有项目创建者能设置访问密码")

    pwd = (body or {}).get("password", "") or ""
    settings = dict(project.settings or {})
    settings["access_password"] = pwd if pwd else None
    project.settings = settings
    await db.commit()

    return {"has_password": bool(pwd)}

