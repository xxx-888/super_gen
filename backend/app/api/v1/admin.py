"""
Admin API - 后台管理接口
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Dict, Any
from uuid import UUID

from app.core.database import get_db
from app.core.security import get_current_admin_user, get_current_user, get_password_hash
from app.core.exceptions import NotFoundException, ConflictException
from app.adapters.factory import invalidate_adapter_cache
from app.models import (
    User, Project, GenerationTask, AIModel, PromptTemplate,
    Organization, CreditAccount, CreditTransaction,
)
from app.schemas import (
    AdminStats, ModelConfig, SystemSettingsUpdate,
    AIModelCreate, AIModelUpdate, UserCreate,
    PromptTemplateResponse, PromptTemplateCreate, PromptTemplateUpdate,
    CreditAccountResponse, CreditTransactionResponse, CreditRechargeRequest,
)

router = APIRouter()


# ==================== 统计面板 ====================

@router.get("/stats", response_model=AdminStats)
async def get_admin_stats(
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取平台统计数据"""
    # 用户总数
    result = await db.execute(select(func.count(User.id)))
    total_users = result.scalar() or 0

    # 项目总数
    result = await db.execute(select(func.count(Project.id)))
    total_projects = result.scalar() or 0

    # 任务总数
    result = await db.execute(select(func.count(GenerationTask.id)))
    total_tasks = result.scalar() or 0

    # 按状态分组的任务数
    result = await db.execute(
        select(GenerationTask.status, func.count(GenerationTask.id))
        .group_by(GenerationTask.status)
    )
    tasks_by_status = {status: count for status, count in result.all()}

    return AdminStats(
        total_users=total_users,
        active_users_today=0,
        total_projects=total_projects,
        total_tasks=total_tasks,
        tasks_by_status=tasks_by_status,
        storage_used=0.0,
        popular_models=[],
    )


# ==================== 用户管理 ====================

@router.get("/users", response_model=list)
async def admin_get_users(
    page: int = 1,
    page_size: int = 20,
    search: str = None,
    role: str = None,
    status: str = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员查看用户列表(支持搜索和筛选)"""
    stmt = select(User)

    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(
            or_(User.email.ilike(pattern), User.nickname.ilike(pattern))
        )
    if role:
        stmt = stmt.where(User.role == role)
    if status is not None:
        # status: "active" -> is_active=True, "inactive" -> is_active=False
        is_active = status == "active"
        stmt = stmt.where(User.is_active == is_active)

    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size).order_by(User.created_at.desc())
    result = await db.execute(stmt)
    users = result.scalars().all()

    # 构造响应(排除敏感字段)
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "nickname": u.nickname,
            "avatar_url": u.avatar_url,
            "role": u.role,
            "is_active": u.is_active,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in users
    ]


@router.put("/users/{user_id}/role")
async def update_user_role(
    user_id: str,
    body: dict,  # {"role": "admin" | "user"}
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """修改用户角色"""
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user:
        raise NotFoundException("User not found")

    new_role = body.get("role")
    if new_role:
        user.role = new_role

    await db.commit()
    return {"message": "User role updated", "user_id": str(user.id), "role": user.role}


@router.post("/users/{user_id}/toggle-status")
async def toggle_user_status(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """启用/禁用用户账户"""
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user:
        raise NotFoundException("User not found")

    user.is_active = not user.is_active
    await db.commit()
    return {
        "message": "User status toggled",
        "user_id": str(user.id),
        "is_active": user.is_active,
    }


@router.post("/users", response_model=dict)
async def admin_create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员创建新用户"""
    # 邮箱唯一性校验
    existing = await db.execute(select(User).where(User.email == body.email))
    if existing.scalar_one_or_none():
        raise ConflictException("该邮箱已被注册")

    user = User(
        email=body.email,
        hashed_password=get_password_hash(body.password),
        nickname=body.nickname,
        role="user",
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {
        "id": str(user.id),
        "email": user.email,
        "nickname": user.nickname,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.delete("/users/{user_id}")
async def admin_delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员删除用户"""
    # 防止管理员删除自己
    if str(admin.id) == user_id:
        raise ConflictException("不能删除当前登录的管理员账户")

    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user:
        raise NotFoundException("User not found")

    await db.delete(user)
    await db.commit()
    return {"message": "User deleted", "user_id": user_id}


@router.get("/users/{user_id}")
async def admin_get_user_detail(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员查看用户详情"""
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException("User not found")
    return {
        "id": str(user.id),
        "email": user.email,
        "nickname": user.nickname,
        "avatar_url": user.avatar_url,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.put("/users/{user_id}")
async def admin_update_user(
    user_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员编辑用户信息(昵称/邮箱/角色)"""
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException("User not found")
    if "email" in body and body["email"]:
        user.email = body["email"]
    if "nickname" in body:
        user.nickname = body["nickname"]
    if "avatar_url" in body:
        user.avatar_url = body["avatar_url"]
    if "role" in body and body["role"] in ("admin", "user"):
        user.role = body["role"]
    await db.commit()
    return {
        "id": str(user.id), "email": user.email, "nickname": user.nickname,
        "avatar_url": user.avatar_url, "role": user.role,
    }


@router.post("/users/{user_id}/reset-password")
async def admin_reset_user_password(
    user_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员重置用户密码"""
    new_password = body.get("new_password") or body.get("password")
    if not new_password or len(new_password) < 8:
        from app.core.exceptions import BadRequestException
        raise BadRequestException("Password must be at least 8 characters")
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException("User not found")
    user.hashed_password = get_password_hash(new_password)
    await db.commit()
    return {"message": "Password reset", "user_id": user_id}


# ==================== 项目管理 ====================

@router.get("/projects", response_model=list)
async def admin_get_projects(
    page: int = 1,
    page_size: int = 20,
    user_id: str = None,
    status: str = None,
    search: str = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员查看所有项目（含所有者信息 + 统计数据）"""
    from sqlalchemy import func as sa_func
    stmt = select(Project)

    if user_id:
        stmt = stmt.where(Project.user_id == UUID(user_id))
    if status:
        stmt = stmt.where(Project.status == status)
    if search:
        stmt = stmt.where(Project.name.ilike(f"%{search}%"))

    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size).order_by(Project.created_at.desc())
    result = await db.execute(stmt)
    projects = result.scalars().all()

    # 批量查所有者邮箱 + 任务统计
    owner_ids = list(set(str(p.user_id) for p in projects if p.user_id))
    owner_map = {}
    if owner_ids:
        from app.models import User
        u_result = await db.execute(select(User).where(User.id.in_([UUID(uid) for uid in owner_ids])))
        for u in u_result.scalars().all():
            owner_map[str(u.id)] = {"email": u.email, "nickname": u.nickname}

    # 批量查每个项目的任务数 + 积分消耗
    from app.models import GenerationTask
    proj_ids = [p.id for p in projects]
    task_stats = {}
    if proj_ids:
        stat_result = await db.execute(
            select(
                GenerationTask.project_id,
                sa_func.count(GenerationTask.id),
                sa_func.sum(GenerationTask.credits_consumed),
            ).where(GenerationTask.project_id.in_(proj_ids))
            .group_by(GenerationTask.project_id)
        )
        for pid, cnt, credits in stat_result.all():
            task_stats[str(pid)] = {"task_count": cnt or 0, "credits_used": credits or 0}

    # 批量统计每个项目的「内容规模」：剧本数 / 成员数 / 分镜数 / 角色数 / 物品数 / 场景数
    # 统一用「表.group_by(项目外键).count」聚合，避免逐项目 N+1 查询
    from app.models import (
        Script, Scene, Character, Prop, SceneBackground, ProjectMember,
    )
    content_stats: Dict[str, Dict[str, int]] = {str(pid): {} for pid in proj_ids}

    async def _aggregate(fk_col, key):
        """按 ORM 外键列聚合计数（如 Script.project_id），结果并入 content_stats"""
        if not proj_ids:
            return
        rows = await db.execute(
            select(fk_col, sa_func.count())
            .where(fk_col.in_(proj_ids))
            .group_by(fk_col)
        )
        for pid, cnt in rows.all():
            content_stats.setdefault(str(pid), {})[key] = cnt or 0

    # 直接挂在 project 下的资源
    await _aggregate(Script.project_id, "script_count")
    await _aggregate(Character.project_id, "character_count")
    await _aggregate(Prop.project_id, "prop_count")
    await _aggregate(SceneBackground.project_id, "scene_background_count")
    await _aggregate(ProjectMember.project_id, "member_count")

    # 分镜(Scene)挂在 Script 下，需要先聚合到 script 再汇总到 project
    if proj_ids:
        scene_rows = await db.execute(
            select(Scene.script_id, sa_func.count())
            .where(Scene.script_id.in_(
                select(Script.id).where(Script.project_id.in_(proj_ids))
            ))
            .group_by(Scene.script_id)
        )
        scene_per_script = {str(sid): cnt or 0 for sid, cnt in scene_rows.all()}
        # 取项目->剧本 映射后再汇总分镜数
        script_proj_rows = await db.execute(
            select(Script.id, Script.project_id).where(Script.project_id.in_(proj_ids))
        )
        project_scene_count: Dict[str, int] = {}
        for sid, pid in script_proj_rows.all():
            project_scene_count[str(pid)] = project_scene_count.get(str(pid), 0) + scene_per_script.get(str(sid), 0)
        for pid, cnt in project_scene_count.items():
            content_stats.setdefault(pid, {})["scene_count"] = cnt

    def _cs(pid_str: str, key: str) -> int:
        return content_stats.get(pid_str, {}).get(key, 0)

    return [
        {
            "id": str(p.id),
            "user_id": str(p.user_id) if p.user_id else None,
            "owner_email": owner_map.get(str(p.user_id), {}).get("email", "-") if p.user_id else "-",
            "owner_nickname": owner_map.get(str(p.user_id), {}).get("nickname", "-") if p.user_id else "-",
            "name": p.name,
            "description": p.description,
            "status": p.status,
            "cover_image_url": p.cover_image_url,
            "task_count": task_stats.get(str(p.id), {}).get("task_count", 0),
            "credits_used": task_stats.get(str(p.id), {}).get("credits_used", 0),
            # 内容规模统计
            "script_count": _cs(str(p.id), "script_count"),
            "member_count": _cs(str(p.id), "member_count"),
            "scene_count": _cs(str(p.id), "scene_count"),
            "character_count": _cs(str(p.id), "character_count"),
            "prop_count": _cs(str(p.id), "prop_count"),
            "scene_background_count": _cs(str(p.id), "scene_background_count"),
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        }
        for p in projects
    ]


@router.delete("/projects/{project_id}")
async def admin_delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员强制删除项目"""
    result = await db.execute(select(Project).where(Project.id == UUID(project_id)))
    project = result.scalar_one_or_none()

    if not project:
        raise NotFoundException("Project not found")

    await db.delete(project)
    await db.commit()
    return {"message": "Project deleted"}


# ==================== 任务监控 ====================

@router.get("/tasks")
async def admin_get_tasks(
    page: int = 1,
    page_size: int = 20,
    type: str = None,
    status: str = None,
    model: str = None,
    user_id: str = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """管理员监控所有生成任务（含项目名 + 完整参数 + 积分）

    返回分页结构 { items, total, page, page_size }，前端据此渲染分页器。
    """
    # 基础查询（带过滤）
    base = select(GenerationTask)
    if type:
        base = base.where(GenerationTask.type == type)
    if status:
        base = base.where(GenerationTask.status == status)
    if model:
        base = base.where(GenerationTask.model == model)
    if user_id:
        base = base.join(Project, GenerationTask.project_id == Project.id).where(
            Project.user_id == UUID(user_id)
        )

    # 先统计满足条件的总数（分页器需要）
    from sqlalchemy import func as sa_func
    count_result = await db.execute(select(sa_func.count()).select_from(base.subquery()))
    total = count_result.scalar() or 0

    # 再取当前页数据
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    offset = (page - 1) * page_size
    stmt = base.offset(offset).limit(page_size).order_by(GenerationTask.created_at.desc())
    result = await db.execute(stmt)
    tasks = result.scalars().all()

    # 批量查项目名
    proj_ids = list(set(t.project_id for t in tasks if t.project_id))
    proj_map = {}
    if proj_ids:
        p_result = await db.execute(select(Project).where(Project.id.in_(proj_ids)))
        for p in p_result.scalars().all():
            proj_map[str(p.id)] = p.name

    items = [
        {
            "id": str(t.id),
            "project_id": str(t.project_id) if t.project_id else None,
            "project_name": proj_map.get(str(t.project_id), "-") if t.project_id else "-",
            "episode_id": str(t.episode_id) if t.episode_id else None,
            "type": t.type,
            "model": t.model,
            "status": t.status,
            "progress": t.progress,
            "credits_consumed": t.credits_consumed or 0,
            "input_data": t.input_data,
            "output_urls": t.output_urls or [],
            "error_message": t.error_message,
            "meta": t.meta,
            "started_at": t.started_at.isoformat() if t.started_at else None,
            "completed_at": t.completed_at.isoformat() if t.completed_at else None,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        }
        for t in tasks
    ]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.post("/tasks/cancel-all-pending")
async def cancel_all_pending_tasks(
    user_id: str = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """取消所有待处理任务(可按用户过滤)"""
    stmt = select(GenerationTask).where(GenerationTask.status == "pending")

    if user_id:
        stmt = stmt.join(Project, GenerationTask.project_id == Project.id).where(
            Project.user_id == UUID(user_id)
        )

    result = await db.execute(stmt)
    tasks = result.scalars().all()

    count = 0
    for task in tasks:
        task.status = "cancelled"
        count += 1

    await db.commit()
    return {"message": f"Cancelled {count} pending tasks", "cancelled_count": count}


# ==================== 模型配置管理 ====================

@router.get("/models", response_model=list[ModelConfig])
async def get_model_configs(
    type: str = None,
    provider: str = None,
    enabled: bool = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取AI模型配置列表(支持按类型/提供方/启用状态筛选)"""
    stmt = select(AIModel)

    if type:
        stmt = stmt.where(AIModel.type == type)
    if provider:
        stmt = stmt.where(AIModel.provider == provider)
    if enabled is not None:
        stmt = stmt.where(AIModel.is_enabled == enabled)

    stmt = stmt.order_by(AIModel.priority.desc(), AIModel.created_at.desc())
    result = await db.execute(stmt)
    models = result.scalars().all()

    return [
        ModelConfig(
            id=m.id,
            name=m.name,
            type=m.type,
            provider=m.provider,
            endpoint=m.endpoint,
            api_key=m.api_key,
            config=m.config or {},
            is_enabled=m.is_enabled,
            priority=m.priority,
            cost_per_request=m.cost_per_request,
            description=m.description,
        )
        for m in models
    ]


@router.post("/models", response_model=ModelConfig, status_code=201)
async def create_model_config(
    body: AIModelCreate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """创建模型配置"""
    model = AIModel(
        name=body.name,
        type=body.type,
        provider=body.provider,
        endpoint=body.endpoint,
        api_key=body.api_key,
        config=body.config or {},
        is_enabled=body.is_enabled,
        priority=body.priority,
        cost_per_request=body.cost_per_request,
        description=body.description,
    )
    db.add(model)
    await db.commit()
    await db.refresh(model)
    invalidate_adapter_cache()  # 让新配置立即生效

    return ModelConfig(
        id=model.id, name=model.name, type=model.type, provider=model.provider,
        endpoint=model.endpoint, api_key=model.api_key, config=model.config or {},
        is_enabled=model.is_enabled, priority=model.priority,
        cost_per_request=model.cost_per_request, description=model.description,
    )


@router.put("/models/{model_id}", response_model=ModelConfig)
async def update_model_config(
    model_id: str,
    body: AIModelUpdate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新模型配置(API Key、参数等)"""
    result = await db.execute(select(AIModel).where(AIModel.id == model_id))
    model = result.scalar_one_or_none()

    if not model:
        raise NotFoundException("Model not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(model, field, value)

    # JSONB 字段需要显式标记变更（SQLAlchemy 对 JSONB 的变更检测有限）
    if "config" in update_data:
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(model, "config")

    await db.commit()
    await db.refresh(model)
    invalidate_adapter_cache()  # 让更新后的配置立即生效

    return ModelConfig(
        id=model.id, name=model.name, type=model.type, provider=model.provider,
        endpoint=model.endpoint, api_key=model.api_key, config=model.config or {},
        is_enabled=model.is_enabled, priority=model.priority,
        cost_per_request=model.cost_per_request, description=model.description,
    )


@router.delete("/models/{model_id}")
async def delete_model_config(
    model_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """删除模型配置"""
    result = await db.execute(select(AIModel).where(AIModel.id == model_id))
    model = result.scalar_one_or_none()

    if not model:
        raise NotFoundException("Model not found")

    await db.delete(model)
    await db.commit()
    invalidate_adapter_cache()  # 让删除后的配置立即生效
    return {"message": "Model deleted", "model_id": model_id}


@router.post("/models/{model_id}/test")
async def test_model_connection(
    model_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """测试模型连接是否正常。智谱模型会发起真实最小请求验证 API Key 有效性。"""
    result = await db.execute(select(AIModel).where(AIModel.id == model_id))
    model = result.scalar_one_or_none()

    if not model:
        raise NotFoundException("Model not found")

    # 智谱：发起真实连通测试（用最快方式：cogview-3-flash + standard，约 8 秒）
    if model.provider in ("zhipu", "glm"):
        try:
            from app.adapters.zhipu_adapter import ZhipuAdapter
            adapter = ZhipuAdapter({
                "provider": model.provider,
                "type": model.type,
                "endpoint": model.endpoint,
                "api_key": model.api_key,
                "config": model.config or {},
            })
            if not adapter.api_key:
                return {"status": "failed", "message": "API Key 未配置"}
            # test_connection 内部会用最快方式（cogview-3-flash + standard）验证 API Key
            ok = await adapter.test_connection()
            if ok:
                return {"status": "success",
                        "message": f"智谱 {model.name} 连接正常（API Key 有效，测试用时约 8 秒）"}
            return {"status": "failed",
                    "message": f"连接失败，请检查 API Key 和端点（base={adapter.base_url}）"}
        except Exception as e:
            return {"status": "failed", "message": f"智谱测试异常: {str(e)[:200]}"}

    # LLM（非智谱）：走 LLMClient 测试
    if model.type == "llm":
        return {"status": "success", "message": f"LLM {model.name} 配置已保存，将在 Agent 调用时验证"}

    # 基础联通性判断：配置了端点或本地模型即视为可连通
    if model.provider == "local" or (model.endpoint and model.endpoint.startswith("http")):
        return {"status": "success", "message": f"模型 {model.name} 配置有效"}

    return {
        "status": "failed",
        "message": "模型未配置有效的端点 URL，请检查端点设置",
    }


# ==================== 提示词模板管理 ====================

def _pt_to_response(pt: PromptTemplate) -> PromptTemplateResponse:
    return PromptTemplateResponse(
        id=pt.id, name=pt.name, category=pt.category, mode=pt.mode,
        content=pt.content, description=pt.description,
        variables=pt.variables or {}, is_enabled=pt.is_enabled,
        is_default=pt.is_default, priority=pt.priority,
    )


@router.get("/prompt-templates", response_model=list[PromptTemplateResponse])
async def list_prompt_templates(
    category: str = None,
    mode: str = None,
    enabled: bool = None,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取提示词模板列表（支持按分类/模式/启用状态筛选）"""
    stmt = select(PromptTemplate)
    if category:
        stmt = stmt.where(PromptTemplate.category == category)
    if mode:
        stmt = stmt.where(PromptTemplate.mode == mode)
    if enabled is not None:
        stmt = stmt.where(PromptTemplate.is_enabled == enabled)
    stmt = stmt.order_by(PromptTemplate.priority.desc(), PromptTemplate.created_at.desc())
    result = await db.execute(stmt)
    return [_pt_to_response(pt) for pt in result.scalars().all()]


@router.post("/prompt-templates", response_model=PromptTemplateResponse, status_code=201)
async def create_prompt_template(
    body: PromptTemplateCreate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """创建提示词模板。若 is_default=True，自动取消同 category+mode 下其它模板的默认标记。"""
    if body.is_default:
        await _clear_default_flag(db, body.category, body.mode)
    pt = PromptTemplate(
        name=body.name, category=body.category, mode=body.mode,
        content=body.content, description=body.description,
        variables=body.variables or {}, is_enabled=body.is_enabled,
        is_default=body.is_default, priority=body.priority,
    )
    db.add(pt)
    await db.commit()
    await db.refresh(pt)
    return _pt_to_response(pt)


@router.put("/prompt-templates/{template_id}", response_model=PromptTemplateResponse)
async def update_prompt_template(
    template_id: str,
    body: PromptTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新提示词模板"""
    result = await db.execute(select(PromptTemplate).where(PromptTemplate.id == template_id))
    pt = result.scalar_one_or_none()
    if not pt:
        raise NotFoundException("Prompt template not found")

    update_data = body.model_dump(exclude_unset=True)
    # 若改为默认，先清除同分类下的其它默认
    if update_data.get("is_default"):
        new_cat = update_data.get("category", pt.category)
        new_mode = update_data.get("mode", pt.mode)
        await _clear_default_flag(db, new_cat, new_mode, exclude_id=template_id)

    for field, value in update_data.items():
        setattr(pt, field, value)
    if "variables" in update_data:
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(pt, "variables")

    await db.commit()
    await db.refresh(pt)
    return _pt_to_response(pt)


@router.delete("/prompt-templates/{template_id}")
async def delete_prompt_template(
    template_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """删除提示词模板"""
    result = await db.execute(select(PromptTemplate).where(PromptTemplate.id == template_id))
    pt = result.scalar_one_or_none()
    if not pt:
        raise NotFoundException("Prompt template not found")
    await db.delete(pt)
    await db.commit()
    return {"message": "Prompt template deleted", "template_id": template_id}


async def _clear_default_flag(db: AsyncSession, category: str, mode: str, exclude_id: str = None):
    """清除指定 category+mode 下其它模板的 is_default 标记（保证唯一默认）。"""
    stmt = select(PromptTemplate).where(
        PromptTemplate.category == category,
        PromptTemplate.mode == mode,
        PromptTemplate.is_default == True,  # noqa: E712
    )
    if exclude_id:
        stmt = stmt.where(PromptTemplate.id != exclude_id)
    result = await db.execute(stmt)
    for other in result.scalars().all():
        other.is_default = False


# ==================== 系统设置 ====================

@router.get("/settings", response_model=dict)
async def get_system_settings(
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取系统设置"""
    from app.models import SystemSettings

    result = await db.execute(select(SystemSettings))
    settings_list = result.scalars().all()

    return {s.key: s.value for s in settings_list}


@router.put("/settings")
async def update_system_settings(
    body: SystemSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """更新系统设置"""
    from app.models import SystemSettings

    for key, value in body.settings.items():
        result = await db.execute(
            select(SystemSettings).where(SystemSettings.key == key)
        )
        setting = result.scalar_one_or_none()

        if setting:
            setting.value = value
        else:
            new_setting = SystemSettings(key=key, value=value)
            db.add(new_setting)

    await db.commit()
    # 清缓存让新设置立即生效
    from app.services.settings_service import invalidate_cache as invalidate_settings_cache
    invalidate_settings_cache()
    return {"message": "Settings updated successfully"}


# ==================== 系统日志 ====================

@router.get("/logs", response_model=list)
async def get_system_logs(
    level: str = None,  # INFO/WARNING/ERROR
    source: str = None,  # api/celery/model
    start_time: str = None,
    end_time: str = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取系统日志"""
    # TODO: 从日志系统(Elasticsearch/数据库表)查询
    return []


# ==================== 存储管理 ====================

@router.get("/storage/stats")
async def get_storage_stats(
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """获取存储使用统计"""
    # TODO: 查询MinIO/S3的bucket使用情况
    return {
        "total_size_gb": 0,
        "used_size_gb": 0,
        "file_count": 0,
        "by_type": {
            "images": {"count": 0, "size_gb": 0},
            "videos": {"count": 0, "size_gb": 0},
            "audio": {"count": 0, "size_gb": 0},
            "other": {"count": 0, "size_gb": 0},
        },
    }


@router.post("/storage/cleanup")
async def cleanup_orphaned_files(
    dry_run: bool = True,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """清理孤立文件(数据库中不存在记录的文件)"""
    # TODO: 实现清理逻辑(dry_run模式只返回将要删除的文件列表)


# ==================== 积分管理 (M1) ====================

@router.get("/credits/accounts")
async def list_credit_accounts(
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """所有团队的积分账户列表（含团队名，供管理后台展示）"""
    # join Organization 拿到团队名，避免前端只能展示 org_id 截断
    stmt = (
        select(CreditAccount, Organization)
        .outerjoin(Organization, CreditAccount.org_id == Organization.id)
        .order_by(CreditAccount.created_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()
    return [
        {
            "id": str(acc.id),
            "org_id": str(acc.org_id),
            "org_name": org.name if org else "-",
            "is_personal": org.is_personal if org else False,
            "balance": acc.balance,
            "allocated": acc.allocated,
            "total_recharged": acc.total_recharged,
            "total_consumed": acc.total_consumed,
        }
        for acc, org in rows
    ]


@router.post("/credits/{org_id}/recharge", response_model=CreditAccountResponse)
async def recharge_credits(
    org_id: UUID,
    body: CreditRechargeRequest,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """手动给团队充值积分"""
    from app.services.credit_service import recharge
    # 校验团队存在
    result = await db.execute(select(Organization).where(Organization.id == org_id))
    org = result.scalar_one_or_none()
    if org is None:
        raise NotFoundException("Organization not found", resource="Organization")

    account = await recharge(db, org_id, body.amount, operator_id=admin.id, remark=body.remark)
    return account


@router.get("/credits/transactions")
async def list_all_transactions(
    org_id: UUID | None = None,
    type: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    admin=Depends(get_current_admin_user),
):
    """全局积分流水(可按团队/类型筛选，含团队名)"""
    # join Organization 拿团队名，前端直接展示中文团队名
    stmt = (
        select(CreditTransaction, Organization)
        .outerjoin(Organization, CreditTransaction.org_id == Organization.id)
    )
    if org_id is not None:
        stmt = stmt.where(CreditTransaction.org_id == org_id)
    if type is not None:
        stmt = stmt.where(CreditTransaction.type == type)
    stmt = stmt.order_by(CreditTransaction.created_at.desc()).limit(min(limit, 500))
    result = await db.execute(stmt)
    rows = result.all()
    return [
        {
            "id": str(tx.id),
            "org_id": str(tx.org_id),
            "org_name": org.name if org else "-",
            "is_personal": org.is_personal if org else False,
            "user_id": str(tx.user_id) if tx.user_id else None,
            "project_id": str(tx.project_id) if tx.project_id else None,
            "task_id": str(tx.task_id) if tx.task_id else None,
            "type": tx.type,
            "amount": tx.amount,
            "balance_after": tx.balance_after,
            "model": tx.model,
            "remark": tx.remark,
            "created_at": tx.created_at.isoformat() if tx.created_at else None,
        }
        for tx, org in rows
    ]


# ==================== 本地存储统计 ====================

@router.get("/storage-stats")
async def get_local_storage_stats(
    admin=Depends(get_current_admin_user),
):
    """获取本地 uploads 目录的存储统计 (仅 admin).

    返回各类别 (image/video/audio) 的文件数与总大小 (MB), 以及合计大小.
    用于监控 AI 生成产物落盘占用. 用 os.scandir 遍历, 不访问数据库.
    """
    from app.services.asset_downloader import get_local_storage_stats as _stats

    return _stats()
