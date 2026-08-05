"""
Video Pipeline Service - 视频生成管道服务
"""
from typing import Dict, Any, Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select


class VideoPipelineService:
    """
    视频生成管道 - 协调完整的视频生产流程

    完整流程:
    1. 检查并补充缺失的资源(角色图、场景图等)
    2. 为每个分镜生成视频
    3. 可选: 添加字幕
    4. 合并所有分镜为最终视频
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def run_full_pipeline(
        self,
        project_id: UUID,
        options: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        运行完整的一键生成流程

        Args:
            project_id: 项目ID
            options: 生成选项

        Returns:
            流程执行结果和状态
        """
        from app.models import Project, Scene, Script

        # 获取项目信息
        result = await self.db.execute(select(Project).where(Project.id == project_id))
        project = result.scalar_one_or_none()

        if not project:
            raise NotFoundException("Project not found")

        # 获取所有剧本和分镜
        scripts_result = await self.db.execute(
            select(Script).where(Script.project_id == project_id)
        )
        scripts = scripts_result.scalars().all()

        all_scenes = []
        for script in scripts:
            scenes_result = await self.db.execute(
                select(Scene)
                .where(Scene.script_id == script.id)
                .order_by(Scene.sequence)
            )
            scenes = scenes_result.scalars().all()
            all_scenes.extend(scenes)

        if not all_scenes:
            raise BadRequestException("No scenes found in this project")

        steps = []
        total_steps = 0

        # Step 1: 检查并生成缺失的图片资源
        if options.get("generate_missing_images", True):
            step1 = await self._ensure_all_images(project_id, all_scenes, options)
            steps.append(step1)
            total_steps += 1

        # Step 2: 批量生成视频
        if options.get("generate_videos", True):
            model_prefs = options.get("model_preferences", {})
            video_model = model_prefs.get("video", "kling-v1")

            step2 = await self._batch_generate_videos(project_id, all_scenes, video_model, options)
            steps.append(step2)
            total_steps += 1

        # Step 3: 字幕处理
        if options.get("add_subtitles", False):
            step3 = await self._process_subtitles(all_scenes, options)
            steps.append(step3)
            total_steps += 1

        return {
            "project_id": str(project_id),
            "status": "processing",
            "total_scenes": len(all_scenes),
            "steps_completed": len([s for s in steps if s["status"] == "completed"]),
            "total_steps": total_steps,
            "steps": steps,
            "message": f"Pipeline started with {len(all_scenes)} scenes",
        }

    async def _ensure_all_images(
        self,
        project_id: UUID,
        scenes: list,
        options: Dict[str, Any],
    ) -> Dict[str, Any]:
        """确保所有需要的图片都已生成"""
        from app.models import Character, SceneBackground, Prop

        missing_resources = []

        # 检查角色图片
        chars_result = await self.db.execute(
            select(Character).where(Character.project_id == project_id)
        )
        characters = chars_result.scalars().all()

        for char in characters:
            if not char.image_url:
                missing_resources.append({
                    "type": "character",
                    "id": str(char.id),
                    "name": char.name,
                    "reason": "missing_image",
                })

        # 检查场景图片
        bgs_result = await self.db.execute(
            select(SceneBackground).where(SceneBackground.project_id == project_id)
        )
        backgrounds = bgs_result.scalars().all()

        for bg in backgrounds:
            if not bg.image_url:
                missing_resources.append({
                    "type": "scene_bg",
                    "id": str(bg.id),
                    "name": bg.name,
                    "reason": "missing_image",
                })

        # TODO: 为缺失资源提交生成任务

        return {
            "step": "generate_images",
            "status": "completed" if not missing_resources else "processing",
            "missing_count": len(missing_resources),
            "missing_resources": missing_resources[:10],  # 只返回前10个
        }

    async def _batch_generate_videos(
        self,
        project_id: UUID,
        scenes: list,
        model: str,
        options: Dict[str, Any],
    ) -> Dict[str, Any]:
        """批量生成视频"""
        pending_count = sum(1 for s in scenes if s.status in ["pending", "failed"])

        # TODO: 提交批量生成任务到Celery

        return {
            "step": "generate_videos",
            "status": "processing",
            "model": model,
            "total": len(scenes),
            "pending": pending_count,
        }

    async def _process_subtitles(
        self,
        scenes: list,
        options: Dict[str, Any],
    ) -> Dict[str, Any]:
        """处理字幕"""
        completed_videos = [s for s in scenes if s.status == "completed" and s.generated_video_url]

        # TODO: 提交字幕任务

        return {
            "step": "subtitles",
            "status": "processing",
            "videos_to_process": len(completed_videos),
        }


# 导入依赖
from app.core.exceptions import NotFoundException, BadRequestException
