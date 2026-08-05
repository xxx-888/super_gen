"""
Scene Generator Service - AI分镜生成服务
"""
from typing import List, Dict, Any, Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select


class SceneGeneratorService:
    """
    分镜生成器 - 基于剧本内容AI生成分镜

    功能:
    1. 将剧本拆分为合理的分镜
    2. 为每个分镜生成初始提示词
    3. 自动识别需要的角色、场景、道具
    4. 支持手动调整和重新生成
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def generate_from_script(
        self,
        script_id: UUID,
        options: Dict[str, Any],
    ) -> List[Scene]:
        """
        基于剧本生成分镜

        Args:
            script_id: 剧本ID
            options: 生成选项

        Returns:
            生成的Scene对象列表
        """
        from app.models import Script, Scene

        # 获取剧本
        result = await self.db.execute(select(Script).where(Script.id == script_id))
        script = result.scalar_one_or_none()

        if not script:
            raise NotFoundException("Script not found")

        # 必须先在剧本编辑页执行 AI 解析（parsed_data 已存在）；这里不再隐式用正则补
        parsed_data = script.parsed_data
        if not parsed_data:
            raise BadRequestException(
                "该剧本尚未解析，请先在剧本编辑页执行「AI 解析」后再生成场景。"
            )

        scenes_data = parsed_data.get("scenes", [])
        generated_scenes = []

        for scene_data in scenes_data:
            # 构建初始提示词
            prompt = self._build_initial_prompt(scene_data)

            scene = Scene(
                script_id=script_id,
                sequence=scene_data.get("sequence", len(generated_scenes) + 1),
                prompt=prompt,
                duration=scene_data.get("duration_estimate", 5.0),
                mood=scene_data.get("mood"),
                status="pending",
            )
            self.db.add(scene)
            generated_scenes.append(scene)

        await self.db.flush()

        return generated_scenes

    def _build_initial_prompt(self, scene_data: Dict[str, Any]) -> str:
        """根据场景数据构建初始提示词"""
        parts = []

        # 场景标题/位置
        if scene_data.get("scene_heading"):
            parts.append(f"【场景】{scene_data['scene_heading']}")

        # 动作描述
        if scene_data.get("action"):
            parts.append(f"\n{scene_data['action']}")

        # 对白
        dialogues = scene_data.get("dialogue", [])
        for dialogue in dialogues:
            char_name = dialogue.get("character", "未知角色")
            text = dialogue.get("text", "")
            parenthetical = dialogue.get("parenthetical")

            dialogue_str = f"@{char_name}"
            if parenthetical:
                dialogue_str += f" ({parenthetical})"
            dialogue_str += f": {text}"

            parts.append(dialogue_str)

        # 转场
        if scene_data.get("transition"):
            parts.append(f"\n【转场】{scene_data['transition']}")

        return "\n".join(parts)


# 导入依赖
from app.core.exceptions import BadRequestException, NotFoundException
from app.models import Scene
