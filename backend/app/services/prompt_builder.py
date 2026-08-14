"""
Prompt Builder Service - 提示词构建与解析服务 (核心)
"""
from typing import List, Dict, Any, Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import re

from app.models import (
    Scene,
    Character,
    SceneBackground,
    Prop,
    AudioAsset,
    Script,
)
from app.schemas import (
    ParsedPrompt,
    PromptReference,
    ScenePromptPreview,
)
from app.core.exceptions import NotFoundException


class PromptBuilderService:
    """
    提示词构建器 - 处理@引用系统

    核心功能:
    1. 解析提示词中的@引用 (@角色名, @场景名, @道具名, @音频名)
    2. 将@引用展开为完整的描述文本
    3. 验证提示词质量和长度
    4. 提供预览功能
    """

    # @引用的正则模式，支持三种格式：
    #   1. @名称               (如: @沈如姬)               - 通过名称查找资源
    #   2. @{类型:UUID}        (如: @{character:uuid})     - 直接指定资源ID
    #   3. @{类型:UUID:名称}   (如: @{character:uuid:沈如姬}) - 指定ID，内联携带名称（前端芯片格式）
    # 注意：@名称格式只匹配紧随@的连续中英文/数字/下划线，遇到空格或标点即停止，
    # 避免贪婪匹配导致连续多个@引用被吞并为一个（如 @角色A @场景B）。
    MENTION_PATTERN = re.compile(
        r"@([\w\u4e00-\u9fff]+)"
        r"|@\{(\w+):([a-f0-9-]{36})(?::([^}]+))?\}"
    )

    def __init__(self, db: AsyncSession):
        self.db = db

    async def build_preview(
        self,
        scene_id: Optional[UUID],
        raw_prompt: str,
    ) -> ScenePromptPreview:
        """
        构建提示词预览

        Args:
            scene_id: 分镜ID(可选，用于获取项目上下文)
            raw_prompt: 原始提示词(包含@引用)

        Returns:
            预览结果，包含展开后的完整提示词和引用的资源列表
        """
        # 解析@引用
        references = await self._parse_mentions(scene_id, raw_prompt)

        # 展开提示词
        expanded_prompt = self._expand_mentions(raw_prompt, references)

        # 估算Token数(粗略估算: 英文约4字符/token，中文约1.5字符/token)
        token_count = self._estimate_tokens(expanded_prompt)

        # 质量评估
        quality = self._assess_quality(token_count, len(references))

        return ScenePromptPreview(
            original_prompt=raw_prompt,
            expanded_prompt=expanded_prompt,
            referenced_resources=[
                {
                    "type": ref.type,
                    "id": str(ref.resource_id),
                    "name": ref.name,
                    "preview_url": self._get_preview_url(ref),
                }
                for ref in references
            ],
            token_count=token_count,
            estimated_quality=quality,
        )

    async def _parse_mentions(
        self,
        scene_id: Optional[UUID],
        prompt: str,
    ) -> List[PromptReference]:
        """
        解析提示词中的所有@引用

        支持三种格式:
        1. @名称 (如: @沈如姬) - 通过名称查找资源
        2. @{类型:UUID} (如: @{character:uuid}) - 直接指定资源ID
        3. @{类型:UUID:名称} (如: @{character:uuid:沈如姬}) - 指定ID，内联携带名称
        """
        references = []
        project_id = None

        # 如果有scene_id，获取project_id用于查询资源
        if scene_id:
            result = await self.db.execute(select(Scene).where(Scene.id == scene_id))
            scene = result.scalar_one_or_none()
            if scene:
                script_result = await self.db.execute(
                    select(Script).where(Script.id == scene.script_id)
                )
                script = script_result.scalar_one_or_none()
                if script:
                    project_id = script.project_id

        for match in self.MENTION_PATTERN.finditer(prompt):
            start, end = match.span()
            name_match = match.group(1)   # @名称格式
            type_match = match.group(2)   # @{type:uuid[:name]} 格式
            id_match = match.group(3)
            inline_name = match.group(4)  # 可选的内联名称（仅 @{type:uuid:name} 格式）

            resource = None
            ref_type = None
            resource_id = None
            display_name = ""
            raw_text = match.group(0)

            if type_match and id_match:
                # @{type:uuid[:name]} 格式
                ref_type = type_match
                resource_id = UUID(id_match)
                resource = await self._get_resource_by_id(ref_type, resource_id)
                # 优先用资源实际名称；资源不存在时回退到内联名称
                if resource:
                    display_name = getattr(resource, 'name', str(resource_id))
                elif inline_name:
                    display_name = inline_name
                else:
                    display_name = str(resource_id)
            elif name_match:
                # @名称格式 - 需要推断类型并查找
                name = name_match.strip()
                display_name = name
                resource, ref_type, resource_id = await self._find_resource_by_name(
                    project_id, name
                )

            if resource and ref_type and resource_id:
                # 构建展开文本
                expanded_text = self._build_resource_description(resource, ref_type)

                references.append(PromptReference(
                    type=ref_type,
                    resource_id=resource_id,
                    name=display_name,
                    position={"start": start, "end": end},
                    expanded_text=expanded_text,
                    raw_text=raw_text,
                ))

        return references

    async def _find_resource_by_name(
        self,
        project_id: Optional[UUID],
        name: str,
    ) -> tuple:
        """
        通过名称查找资源(在角色、场景、道具中搜索)

        Returns:
            (resource, type, id) 或 (None, None, None)
        """
        if not project_id:
            return None, None, None

        # 按优先级搜索: 角色 > 场景 > 道具 > 音频
        search_order = [
            ("character", Character, "name"),
            ("scene_bg", SceneBackground, "name"),
            ("prop", Prop, "name"),
            ("audio", AudioAsset, "name"),
        ]

        for ref_type, Model, field in search_order:
            result = await self.db.execute(
                select(Model).where(
                    getattr(Model, field) == name,
                    Model.project_id == project_id,
                )
            )
            resource = result.scalar_one_or_none()
            if resource:
                return resource, ref_type, resource.id

        return None, None, None

    async def _get_resource_by_id(
        self,
        resource_type: str,
        resource_id: UUID,
    ):
        """通过ID和类型获取资源"""
        model_map = {
            "character": Character,
            "scene_bg": SceneBackground,
            "prop": Prop,
            "audio": AudioAsset,
        }

        Model = model_map.get(resource_type)
        if not Model:
            return None

        result = await self.db.execute(select(Model).where(Model.id == resource_id))
        return result.scalar_one_or_none()

    def _expand_mentions(
        self,
        raw_prompt: str,
        references: List[PromptReference],
    ) -> str:
        """
        将@引用展开为完整描述

        策略: 从后向前替换，避免位置偏移问题
        """
        expanded = raw_prompt

        # 按位置倒序排列
        sorted_refs = sorted(references, key=lambda r: r.position["start"], reverse=True)

        for ref in sorted_refs:
            start = ref.position["start"]
            end = ref.position["end"]
            expanded = expanded[:start] + ref.expanded_text + expanded[end:]

        return expanded

    def _build_resource_description(self, resource, resource_type: str) -> str:
        """根据资源类型构建展开的引用文本

        仅保留紧凑的资源标签（如 [角色:宋月]）：
        - 外观/描述细节由资源本身的参考图承载（ref2va 多图参考模式），
          展开成文字反而会和参考图冲突，导致生成结果错乱；
        - 纯文本模型如需详细描述，应在分镜提示词里自行描述画面。
        """
        if resource_type == "character":
            return f"[角色:{resource.name}]"
        elif resource_type == "scene_bg":
            return f"[场景:{resource.name}]"
        elif resource_type == "prop":
            return f"[道具:{resource.name}]"
        elif resource_type == "audio":
            return f"[音频:{resource.name}]"
        else:
            return f"[未知资源:{getattr(resource, 'name', '')}]"

    def _get_preview_url(self, ref: PromptReference) -> Optional[str]:
        """获取资源的预览图URL"""
        # 这里需要根据实际资源对象获取图片URL
        # 由于references只存储了基本信息，可能需要额外查询
        return None

    def _estimate_tokens(self, text: str) -> int:
        """估算Token数量"""
        # 中英混合文本的粗略估算
        chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
        other_chars = len(text) - chinese_chars

        # 中文约1.5字符/token，英文约4字符/token
        tokens = int(chinese_chars / 1.5 + other_chars / 4)
        return max(tokens, len(text.split()))  # 至少等于单词/字数

    def _assess_quality(self, token_count: int, mention_count: int) -> str:
        """
        评估提示词质量

        标准:
        - good: 50-500 tokens，包含适量引用
        - acceptable: 20-1000 tokens
        - too_short: <20 tokens
        - too_long: >1000 tokens
        """
        if token_count < 20:
            return "too_short"
        elif token_count > 1000:
            return "too_long"
        elif 50 <= token_count <= 500 and mention_count >= 1:
            return "good"
        else:
            return "acceptable"

    async def validate_prompt_for_generation(
        self,
        scene_id: UUID,
    ) -> Dict[str, Any]:
        """
        验证分镜提示词是否可以用于视频生成

        检查项:
        1. 提示词不为空
        2. Token数量在合理范围
        3. 引用的资源都存在且有效
        4. 必要的参数已设置(时长等)
        """
        result = await self.db.execute(select(Scene).where(Scene.id == scene_id))
        scene = result.scalar_one_or_none()

        if not scene:
            raise NotFoundException("Scene not found")

        errors = []
        warnings = []

        # 检查提示词
        if not scene.prompt or not scene.prompt.strip():
            errors.append("Prompt is empty")

        # 解析并检查引用
        preview = await self.build_preview(scene_id, scene.prompt)

        if preview.estimated_quality == "too_long":
            warnings.append("Prompt is very long, may affect generation quality")
        elif preview.estimated_quality == "too_short":
            errors.append("Prompt is too short for quality generation")

        # 检查引用的资源是否存在
        for ref_info in preview.referenced_resources:
            resource = await self._get_resource_by_id(ref_info["type"], UUID(ref_info["id"]))
            if not resource:
                errors.append(f"Referenced {ref_info['type']} '{ref_info['name']}' not found")

        # 检查时长
        if scene.duration < 2:
            warnings.append("Duration is very short (< 2s)")
        elif scene.duration > 15:
            warnings.append("Duration is long (> 15s), may take more time/cost")

        return {
            "is_valid": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
            "preview": preview,
        }
