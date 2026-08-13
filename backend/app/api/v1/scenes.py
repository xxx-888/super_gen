"""
Scenes API - 分镜管理接口 (核心)
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from uuid import UUID
from typing import List

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import NotFoundException
from app.models import User, Scene, SceneAsset
from app.schemas import (
    SceneCreate,
    SceneUpdate,
    SceneResponse,
    SceneBatchUpdateItem,
    SceneReorderRequest,
    ScenePromptPreview,
    SceneAssetResponse,
    AddSceneAssetRequest,
)

router = APIRouter()


@router.get("/script/{script_id}", response_model=List[SceneResponse])
async def get_scenes(
    script_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取剧本的分镜列表(按序号排序)"""
    result = await db.execute(
        select(Scene)
        .options(selectinload(Scene.assets))
        .where(Scene.script_id == script_id)
        .order_by(Scene.sequence.asc())
    )
    return result.scalars().all()


@router.post("/script/{script_id}", response_model=SceneResponse, status_code=201)
async def create_scene(
    script_id: UUID,
    body: SceneCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """创建分镜"""
    scene = Scene(
        script_id=script_id,
        sequence=body.sequence,
        prompt=body.prompt,
        duration=body.duration,
        scene_type=body.scene_type,
        camera_angle=body.camera_angle,
        camera_movement=body.camera_movement,
        mood=body.mood,
    )
    db.add(scene)
    await db.flush()
    await db.refresh(scene)
    await db.commit()
    return scene


@router.get("/{scene_id}", response_model=SceneResponse)
async def get_scene(
    scene_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取分镜详情"""
    stmt = (
        select(Scene)
        .options(selectinload(Scene.assets))
        .where(Scene.id == scene_id)
    )
    result = await db.execute(stmt)
    scene = result.scalar_one_or_none()

    if not scene:
        raise NotFoundException("Scene not found")

    return scene


@router.put("/{scene_id}", response_model=SceneResponse)
async def update_scene(
    scene_id: UUID,
    body: SceneUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新分镜"""
    result = await db.execute(
        select(Scene).options(selectinload(Scene.assets)).where(Scene.id == scene_id)
    )
    scene = result.scalar_one_or_none()

    if not scene:
        raise NotFoundException("Scene not found")

    if body.prompt is not None:
        scene.prompt = body.prompt
    if body.duration is not None:
        scene.duration = body.duration
    if body.scene_type is not None:
        scene.scene_type = body.scene_type
    if body.camera_angle is not None:
        scene.camera_angle = body.camera_angle
    if body.camera_movement is not None:
        scene.camera_movement = body.camera_movement
    if body.mood is not None:
        scene.mood = body.mood
    if body.status is not None:
        scene.status = body.status

    await db.flush()
    await db.refresh(scene)
    await db.commit()
    return scene


@router.delete("/{scene_id}")
async def delete_scene(
    scene_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除分镜"""
    result = await db.execute(select(Scene).where(Scene.id == scene_id))
    scene = result.scalar_one_or_none()

    if not scene:
        raise NotFoundException("Scene not found")

    await db.delete(scene)
    await db.commit()
    return {"message": "deleted"}


@router.put("/{scene_id}/prompt", response_model=ScenePromptPreview)
async def update_scene_prompt(
    scene_id: UUID,
    body: dict,  # {"prompt": "..."}
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    更新分镜提示词并返回预览

    这是核心接口:
    1. 接收包含@引用的原始提示词
    2. 解析@引用并展开为完整提示词
    3. 返回预览结果供前端确认
    """
    from app.services.prompt_builder import PromptBuilderService

    raw_prompt = body.get("prompt", "")
    builder = PromptBuilderService(db)

    preview = await builder.build_preview(scene_id, raw_prompt)

    # 更新数据库中的提示词
    result = await db.execute(select(Scene).where(Scene.id == scene_id))
    scene = result.scalar_one_or_none()

    if scene:
        scene.prompt = raw_prompt
        if hasattr(preview, 'model_dump'):
            scene.parsed_prompt = preview.model_dump()
        await db.commit()

    return preview


@router.post("/{scene_id}/preview", response_model=ScenePromptPreview)
async def preview_scene_prompt(
    scene_id: UUID,
    body: dict,  # {"prompt": "..."}
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """预览提示词展开效果(不保存)"""
    from app.services.prompt_builder import PromptBuilderService

    raw_prompt = body.get("prompt", "")
    builder = PromptBuilderService(db)

    preview = await builder.build_preview(scene_id, raw_prompt)
    return preview


# ==================== 分镜-资源关联 ====================

@router.get("/{scene_id}/assets", response_model=List[SceneAssetResponse])
async def get_scene_assets(
    scene_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取分镜关联的资源列表"""
    result = await db.execute(
        select(SceneAsset)
        .where(SceneAsset.scene_id == scene_id)
        .order_by(SceneAsset.position.asc())
    )
    return result.scalars().all()


@router.post("/{scene_id}/assets", response_model=SceneAssetResponse, status_code=201)
async def add_scene_asset(
    scene_id: UUID,
    body: AddSceneAssetRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """添加资源到分镜"""
    asset = SceneAsset(
        scene_id=scene_id,
        resource_type=body.resource_type,
        resource_id=body.resource_id,
        position=body.position or 0,
        usage_context=body.usage_context,
    )
    db.add(asset)
    await db.flush()
    await db.refresh(asset)
    await db.commit()
    return asset


@router.delete("/{scene_id}/assets/{asset_id}")
async def remove_scene_asset(
    scene_id: UUID,
    asset_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """移除分镜的资源关联"""
    result = await db.execute(
        select(SceneAsset).where(
            SceneAsset.id == asset_id,
            SceneAsset.scene_id == scene_id,
        )
    )
    asset = result.scalar_one_or_none()

    if not asset:
        raise NotFoundException("Scene asset not found")

    await db.delete(asset)
    await db.commit()
    return {"message": "deleted"}


@router.put("/batch-update")
async def batch_update_scenes(
    body: List[SceneBatchUpdateItem],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批量更新分镜"""
    for item in body:
        result = await db.execute(select(Scene).where(Scene.id == item.id))
        scene = result.scalar_one_or_none()
        if not scene:
            continue

        if item.prompt is not None:
            scene.prompt = item.prompt
        if item.duration is not None:
            scene.duration = item.duration
        if item.status is not None:
            scene.status = item.status

    await db.commit()
    return {"message": f"Updated {len(body)} scenes"}


@router.put("/script/{script_id}/reorder")
async def reorder_scenes(
    script_id: UUID,
    body: SceneReorderRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """重新排序分镜"""
    for index, scene_id in enumerate(body.scene_ids):
        result = await db.execute(
            select(Scene).where(
                Scene.id == scene_id,
                Scene.script_id == script_id,
            )
        )
        scene = result.scalar_one_or_none()
        if scene:
            scene.sequence = index

    await db.commit()
    return {"message": f"Reordered {len(body.scene_ids)} scenes"}


@router.post("/script/{script_id}/generate-scenes")
async def generate_scenes_from_script(
    script_id: UUID,
    options: dict = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """AI批量生成分镜(基于剧本内容)"""
    from app.services.scene_generator import SceneGeneratorService

    generator = SceneGeneratorService(db)
    scenes = await generator.generate_from_script(script_id, options or {})

    return {
        "message": f"Generated {len(scenes)} scenes",
        "scenes": [s.id for s in scenes],
    }
