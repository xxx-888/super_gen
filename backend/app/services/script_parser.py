"""
Script Parser Service - 剧本解析服务
"""
from typing import List, Dict, Any, Optional
from sqlalchemy.ext.asyncio import AsyncSession
import re


class ScriptParserService:
    """剧本解析器 - 将原始剧本文本转换为结构化分镜数据"""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def parse(
        self,
        content: str,
        options: Dict[str, Any] = None,
    ) -> Dict[str, Any]:
        """
        解析剧本内容

        支持格式:
        1. 纯文本 (自动识别场景和对白)
        2. Fountain 格式 (专业编剧格式)
        3. FinalDraft XML (导入)

        Args:
            content: 原始剧本文本
            options: 解析选项

        Returns:
            解析结果，包含分镜列表、提取的角色和场景
        """
        opts = options or {}

        # 根据内容特征判断格式
        script_format = self._detect_format(content)

        if script_format == "fountain":
            return await self._parse_fountain(content, opts)
        else:
            return await self._parse_plain_text(content, opts)

    def _detect_format(self, content: str) -> str:
        """检测剧本格式"""
        # Fountain格式特征
        fountain_patterns = [
            r"^(INT\.|EXT\.)",           # 场景标题
            r"^[A-Z\s]+$",               # 角色名(全大写)
            r"^\(.*\)$",                 # 括号说明
        ]

        for pattern in fountain_patterns:
            if re.search(pattern, content, re.MULTILINE):
                return "fountain"

        return "plain"

    async def _parse_plain_text(
        self,
        content: str,
        options: Dict[str, Any],
    ) -> Dict[str, Any]:
        """解析纯文本格式"""
        scenes = []
        characters = {}  # name -> descriptions list
        locations = {}   # name -> descriptions list

        # 按段落分割
        paragraphs = self._split_paragraphs(content)

        current_scene = None
        scene_sequence = 1

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            # 尝试识别各种元素
            scene_data = self._analyze_paragraph(para)

            if scene_data.get("is_scene_heading"):
                # 新场景开始
                if current_scene:
                    scenes.append(current_scene)

                current_scene = {
                    "sequence": scene_sequence,
                    "scene_heading": para,
                    "action": "",
                    "dialogue": [],
                    "transition": None,
                    "duration_estimate": options.get("min_scene_duration", 5),
                    "mood": None,
                    "characters_involved": [],
                    "location": scene_data.get("location"),
                }
                scene_sequence += 1

                # 记录位置
                loc = scene_data.get("location")
                if loc:
                    locations.setdefault(loc, []).append(para)

            elif current_scene:
                if scene_data.get("is_dialogue"):
                    # 对白
                    current_scene["dialogue"].append({
                        "character": scene_data["character"],
                        "text": scene_data["text"],
                        "parenthetical": scene_data.get("parenthetical"),
                    })

                    # 记录角色
                    char_name = scene_data["character"]
                    characters.setdefault(char_name, []).append(scene_data["text"])

                    # 更新角色参与列表
                    if char_name not in current_scene["characters_involved"]:
                        current_scene["characters_involved"].append(char_name)

                elif scene_data.get("is_action"):
                    # 动作描述
                    current_scene["action"] += ("\n" if current_scene["action"] else "") + para

                elif scene_data.get("is_transition"):
                    # 转场
                    current_scene["transition"] = para

        # 添加最后一个场景
        if current_scene:
            scenes.append(current_scene)

        # 估算时长(基于字数)
        for scene in scenes:
            total_chars = len(scene["action"]) + sum(len(d["text"]) for d in scene["dialogue"])
            estimated_duration = max(
                options.get("min_scene_duration", 3),
                min(
                    options.get("max_scene_duration", 15),
                    total_chars / 20 + 3,  # 大约每秒20字+基础时长
                )
            )
            scene["duration_estimate"] = round(estimated_duration, 1)

        return {
            "scenes": scenes,
            "extracted_characters": [
                {"name": name, "descs": descs}
                for name, descs in characters.items()
            ],
            "extracted_locations": [
                {"name": name, "descs": descs}
                for name, descs in locations.items()
            ],
            "warnings": [],  # 解析警告
        }

    async def _parse_fountain(
        self,
        content: str,
        options: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        解析Fountain格式

        Fountain是一种纯文本的编剧格式，被许多编剧软件支持。
        规范参考: https://fountain.io/syntax
        """
        # TODO: 实现完整的Fountain解析器
        # 这里先使用简化版，后续可引入fountain.py库

        scenes = []
        lines = content.split("\n")
        # ... 实现Fountain解析逻辑

        return {
            "scenes": scenes,
            "extracted_characters": [],
            "extracted_locations": [],
            "warnings": ["Fountain parser not fully implemented"],
        }

    def _split_paragraphs(self, text: str) -> List[str]:
        """分割文本为段落"""
        # 按双换行分割
        paragraphs = re.split(r"\n\s*\n", text)
        return [p.strip() for p in paragraphs if p.strip()]

    def _analyze_paragraph(self, text: str) -> Dict[str, Any]:
        """分析单个段落的内容类型"""
        result = {}

        # 场景标题 (INT./EXT. 开头)
        if re.match(r"^(INT\.|EXT\.|I/E\.)", text, re.IGNORECASE):
            result["is_scene_heading"] = True
            location_match = re.search(r"(?:INT\.|EXT\.|I/E\.)\s*(.+)", text)
            result["location"] = location_match.group(1).strip() if location_match else None
            return result

        # 转场 (CUT TO:, FADE OUT., etc.)
        if re.match(r"^(CUT TO|FADE|DISSOLVE|SMASH CUT|MATCH CUT)", text, re.IGNORECASE):
            result["is_transition"] = True
            return result

        # 对白 (角色名后跟对白)
        dialogue_match = re.match(r"^([A-Z][A-Z\s]+?)\n(.+)", text, re.DOTALL)
        if dialogue_match:
            character = dialogue_match.group(1).strip()

            # 检查括号说明
            text_content = dialogue_match.group(2).strip()
            parenthetical = None
            paren_match = re.match(r"^\((.+)\)\s*\n?(.*)", text_content, re.DOTALL)
            if paren_match:
                parenthetical = paren_match.group(1).strip()
                text_content = paren_match.group(2).strip() if paren_match.group(2) else ""

            result.update({
                "is_dialogue": True,
                "character": character,
                "text": text_content,
                "parenthetical": parenthetical,
            })
            return result

        # 默认作为动作描述
        result["is_action"] = True
        return result
