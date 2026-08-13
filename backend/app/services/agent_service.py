"""
Agent Service - AI Agent 编排核心

对标巨日禄 Agent 模式：用户给一个目标（自然语言），Agent 自动：
1. 理解目标 → 拆解步骤（plan）
2. 逐步执行工具：查素材库 / 同步素材 / 新建资源 / 文生图 / 图生视频 / 组装提示词 / 建分镜
3. 记录每步状态和产出，聚合到 agent_run_id

设计要点：
- 所有"工具"调用现有 service（submit_creation / material_service / prompt_builder），不重复造轮子
- agent_run_id 写入 GenerationTask.meta，便于按 run 聚合查询
- LLM 不可用时降级为规则化固定 pipeline，保证骨架可演示
- 同步执行骨架版（请求内完成），预留 Celery 异步改造点
"""
import logging
import re
from uuid import UUID, uuid4
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import BadRequestException
from app.models import (
    GenerationTask, Project, Episode, Scene, Script,
    Character, SceneBackground, Prop, SceneAsset,
)
from app.services.llm_client import LLMClient, LLMMessage
from app.services import material_service
from app.services.script_analyzer import analyze_script, build_shot_prompt

logger = logging.getLogger(__name__)


# ==================== 类型定义 ====================
class AgentStep(Dict[str, Any]):
    """单步执行记录: {step, tool, status, input, output, error, task_id?, artifact_url?}"""
    pass


class AgentRunResult(Dict[str, Any]):
    """一次 agent 运行的完整结果"""
    pass


# ==================== 工具定义（给 LLM function calling 用） ====================
AGENT_TOOLS = [
    {
        "name": "search_materials",
        "description": "在企业素材库中按关键词搜索角色/场景/物品素材",
        "parameters": {
            "type": "object",
            "properties": {
                "class_type": {"type": "string", "enum": ["character", "scene", "prop"],
                               "description": "素材类型"},
                "keyword": {"type": "string", "description": "搜索关键词"},
            },
            "required": ["class_type"],
        },
    },
    {
        "name": "create_resource",
        "description": "新建项目资源（角色/场景/物品），当素材库没有合适素材时使用",
        "parameters": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["character", "scene", "prop"]},
                "name": {"type": "string", "description": "资源名称"},
                "prompt": {"type": "string", "description": "外观/画面描述提示词"},
            },
            "required": ["type", "name", "prompt"],
        },
    },
    {
        "name": "generate_image",
        "description": "根据提示词和元素生成图片（融合生图）",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "elements": {"type": "array", "items": {"type": "object"},
                             "description": "元素列表，每项含 type/name/image_url"},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "generate_video",
        "description": "根据图片和提示词生成视频（图生视频）",
        "parameters": {
            "type": "object",
            "properties": {
                "image_url": {"type": "string", "description": "起始图片URL"},
                "prompt": {"type": "string", "description": "动作/运镜描述"},
            },
            "required": ["image_url"],
        },
    },
    {
        "name": "create_scene",
        "description": "为当前集创建一个新的分镜片段",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "分镜提示词"},
            },
            "required": ["prompt"],
        },
    },
]

# 规划阶段的 system prompt（要求 LLM 输出步骤计划 JSON）
PLAN_SYSTEM_PROMPT = """你是一个 AI 视频生成编排助手。用户会用自然语言描述想生成的视频片段目标。
你的任务是把它拆解成一个可执行的步骤计划，每步对应一个工具调用。

可用工具:
- search_materials(class_type, keyword): 在企业素材库搜索素材
- create_resource(type, name, prompt): 新建项目资源
- generate_image(prompt, elements): 融合生图
- generate_video(image_url, prompt): 图生视频
- create_scene(prompt): 创建分镜

请输出 JSON 数组，每个元素是一次工具调用，格式:
[
  {"tool": "search_materials", "args": {"class_type": "character", "keyword": "女主角"}},
  {"tool": "generate_image", "args": {"prompt": "...", "elements": []}},
  {"tool": "create_scene", "args": {"prompt": "..."}}
]

注意:
- 只输出 JSON 数组，不要任何额外解释文字
- 步骤要精简（通常 3-6 步），优先复用素材库已有素材
- 最终目标通常是生成一个分镜(create_scene)或一段视频(generate_video)
"""


# ==================== Agent 主服务 ====================
class AgentService:
    """AI Agent 编排服务（plan-execute 模式）"""

    def __init__(self, db: AsyncSession, llm: Optional[LLMClient] = None):
        self.db = db
        self.llm = llm

    async def run(
        self,
        project_id: UUID,
        episode_id: UUID,
        org_id: UUID,
        user_id: UUID,
        goal: str,
        options: Optional[Dict[str, Any]] = None,
    ) -> AgentRunResult:
        """
        执行一次 agent 运行。

        Args:
            goal: 用户的自然语言目标（如"生成主角走进阳光咖啡厅的5秒镜头"）
            options: 可选参数，如 shot_type、size、refine(是否微调模式)

        Returns:
            AgentRunResult: 含 agent_run_id、steps、artifacts、status
        """
        options = options or {}
        agent_run_id = str(uuid4())
        steps: List[AgentStep] = []
        artifacts: List[Dict[str, Any]] = []

        # 1. 规划：LLM 拆解步骤；不可用则降级规则 pipeline
        plan = await self._plan(goal, options)

        # 2. 执行：逐步调用工具
        for idx, step_plan in enumerate(plan):
            step = await self._execute_step(
                step_idx=idx,
                step_plan=step_plan,
                project_id=project_id,
                episode_id=episode_id,
                org_id=org_id,
                user_id=user_id,
                agent_run_id=agent_run_id,
                context={"goal": goal, "options": options, "prior_artifacts": artifacts},
            )
            steps.append(step)
            # 收集产出
            if step.get("artifact_url"):
                artifacts.append({
                    "step": idx,
                    "tool": step.get("tool"),
                    "url": step["artifact_url"],
                    "task_id": step.get("task_id"),
                })

        # 3. 汇总
        status = "completed" if all(s.get("status") != "failed" for s in steps) else "partial"
        if not steps:
            status = "empty"

        return AgentRunResult(
            agent_run_id=agent_run_id,
            goal=goal,
            status=status,
            steps=steps,
            artifacts=artifacts,
            created_at=datetime.now(timezone.utc).isoformat(),
            llm_used=self.llm.available if self.llm else False,
        )

    # -------------------- 规划 --------------------
    async def _plan(self, goal: str, options: Dict[str, Any]) -> List[Dict[str, Any]]:
        """LLM 规划；不可用降级为规则 pipeline"""
        if self.llm and self.llm.available:
            try:
                messages = [
                    LLMMessage(role="system", content=PLAN_SYSTEM_PROMPT),
                    LLMMessage(role="user", content=f"目标: {goal}\n尺寸: {options.get('size', '16:9')}"),
                ]
                plan = await self.llm.chat_with_json(messages, temperature=0.3, max_tokens=1500)
                if isinstance(plan, list) and plan:
                    return plan
                logger.info("LLM plan invalid, fallback to rule pipeline")
            except Exception as e:
                logger.warning(f"LLM plan failed, fallback: {e}")
        # 降级：规则化固定 pipeline
        return self._rule_based_plan(goal, options)

    def _rule_based_plan(self, goal: str, options: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        无 LLM 时的兜底：根据目标文本里提到的角色/场景关键词，
        生成"搜素材 → 生图 → 建分镜"的固定 pipeline。
        """
        plan: List[Dict[str, Any]] = []
        # 简单关键词检测
        if re.search(r"角色|主角|人物|女主|男主|她|他", goal):
            plan.append({"tool": "search_materials",
                         "args": {"class_type": "character", "keyword": "主角"}})
        if re.search(r"场景|背景|咖啡|街道|室内|室外|房间", goal):
            plan.append({"tool": "search_materials",
                         "args": {"class_type": "scene", "keyword": "场景"}})
        plan.append({"tool": "generate_image",
                     "args": {"prompt": goal, "elements": []}})
        plan.append({"tool": "create_scene",
                     "args": {"prompt": goal}})
        return plan

    # -------------------- 执行单步 --------------------
    async def _execute_step(
        self,
        step_idx: int,
        step_plan: Dict[str, Any],
        project_id: UUID,
        episode_id: UUID,
        org_id: UUID,
        user_id: UUID,
        agent_run_id: str,
        context: Dict[str, Any],
    ) -> AgentStep:
        tool = step_plan.get("tool") or step_plan.get("name")
        args = step_plan.get("args") or step_plan.get("arguments") or {}
        step = AgentStep(
            step=step_idx, tool=tool, args=args,
            status="running", started_at=datetime.now(timezone.utc).isoformat(),
        )
        try:
            if tool == "search_materials":
                out = await self._tool_search_materials(org_id, args)
                step["output"] = out
                step["status"] = "completed"
            elif tool == "create_resource":
                out = await self._tool_create_resource(project_id, args)
                step["output"] = out
                step["status"] = "completed"
            elif tool == "generate_image":
                out = await self._tool_generate_image(
                    project_id, episode_id, org_id, user_id, args, agent_run_id, step_idx,
                )
                step["output"] = out
                step["task_id"] = out.get("task_id")
                if out.get("urls"):
                    step["artifact_url"] = out["urls"][0]
                step["status"] = out.get("status", "completed")
            elif tool == "generate_video":
                out = await self._tool_generate_video(
                    project_id, episode_id, org_id, user_id, args, agent_run_id, step_idx,
                )
                step["output"] = out
                step["task_id"] = out.get("task_id")
                if out.get("urls"):
                    step["artifact_url"] = out["urls"][0]
                step["status"] = out.get("status", "completed")
            elif tool == "create_scene":
                out = await self._tool_create_scene(project_id, episode_id, args, context)
                step["output"] = out
                step["status"] = "completed"
            else:
                step["status"] = "skipped"
                step["error"] = f"unknown tool: {tool}"
        except Exception as e:
            logger.error(f"Agent step {step_idx} ({tool}) failed: {e}")
            step["status"] = "failed"
            step["error"] = str(e)[:300]
        step["completed_at"] = datetime.now(timezone.utc).isoformat()
        return step

    # -------------------- 工具实现 --------------------
    async def _tool_search_materials(self, org_id: UUID, args: Dict[str, Any]) -> Dict[str, Any]:
        """搜索企业素材库"""
        class_type = args.get("class_type", "character")
        keyword = args.get("keyword", "")
        items = await material_service.list_materials(
            self.db, org_id, category="image", class_type=class_type, search=keyword or None, limit=10,
        )
        return {
            "count": len(items),
            "items": [{"id": str(m.id), "name": m.name, "url": m.url} for m in items],
        }

    async def _tool_create_resource(self, project_id: UUID, args: Dict[str, Any]) -> Dict[str, Any]:
        """新建项目资源（角色/场景/物品）"""
        rtype = args.get("type", "character")
        name = args.get("name", "未命名")
        prompt = args.get("prompt", "")
        now = datetime.now(timezone.utc)
        if rtype == "character":
            obj = Character(project_id=project_id, name=name,
                            appearance_prompt=prompt, description=prompt, created_at=now)
        elif rtype == "scene":
            obj = SceneBackground(project_id=project_id, name=name,
                                  prompt=prompt, description=prompt, created_at=now)
        elif rtype == "prop":
            obj = Prop(project_id=project_id, name=name,
                       prompt=prompt, description=prompt, created_at=now)
        else:
            raise BadRequestException(f"Invalid resource type: {rtype}")
        self.db.add(obj)
        await self.db.flush()
        return {"id": str(obj.id), "name": name, "type": rtype}

    async def _tool_generate_image(
        self, project_id: UUID, episode_id: UUID, org_id: UUID, user_id: UUID,
        args: Dict[str, Any], agent_run_id: str, step_idx: int,
    ) -> Dict[str, Any]:
        """融合生图（调用 submit_creation，复用扣费/任务逻辑）。
        带上 model/size/quality/watermark_enabled（从 args 或全局默认），适配器会读 extra。
        """
        from app.services.creation_service import submit_creation
        params = {
            "prompt": args.get("prompt", ""),
            "elements": args.get("elements", []),
            "size": args.get("size", "16:9"),
            "count": 1,
            "quality": args.get("quality", "hd"),
            "watermark_enabled": args.get("watermark_enabled", False),
        }
        model = args.get("model") or "auto"
        result = await submit_creation(
            self.db, org_id, user_id, "fusion", params,
            project_id=project_id, episode_id=episode_id,
            model=model,
        )
        # 打 agent_run 标记，便于前端聚合查询
        await self._tag_task(result["task_id"], agent_run_id, step_idx)
        return result

    async def _tool_generate_video(
        self, project_id: UUID, episode_id: UUID, org_id: UUID, user_id: UUID,
        args: Dict[str, Any], agent_run_id: str, step_idx: int,
    ) -> Dict[str, Any]:
        """图生视频（带上 model/size/duration/resolution/quality/watermark 参数）"""
        from app.services.creation_service import submit_creation
        params = {
            "prompt": args.get("prompt", ""),
            "image_url": args.get("image_url"),
            "count": 1,
            "size": args.get("size", "16:9"),
            "duration": args.get("duration", 5),
            "resolution": args.get("resolution", "720p"),
            "quality": args.get("quality", "hd"),
            "watermark_enabled": args.get("watermark_enabled", False),
        }
        model = args.get("model") or "auto"
        result = await submit_creation(
            self.db, org_id, user_id, "image_to_video", params,
            project_id=project_id, episode_id=episode_id,
            model=model,
        )
        await self._tag_task(result["task_id"], agent_run_id, step_idx)
        return result

    async def _tool_create_scene(
        self, project_id: UUID, episode_id: UUID,
        args: Dict[str, Any], context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """为集创建一个分镜。

        策略：若集有关联 script，则挂到该 script；否则建临时 script。
        优先把前面 generate_image 的产出 url 作为分镜参考。
        """
        # 找集关联的 script（episode 可能有 script_id；若无则取项目第一个）
        ep_result = await self.db.execute(select(Episode).where(Episode.id == episode_id))
        episode = ep_result.scalar_one_or_none()
        script_id = getattr(episode, "script_id", None) if episode else None
        if not script_id:
            # 项目第一个 script
            s_result = await self.db.execute(
                select(Script).where(Script.project_id == project_id).order_by(Script.created_at.desc()).limit(1)
            )
            script = s_result.scalar_one_or_none()
            if script is None:
                # 自动建一个临时 script
                script = Script(project_id=project_id, title="Agent 生成", content="", format="plain")
                self.db.add(script)
                await self.db.flush()
            script_id = script.id

        # 计算序号
        count_result = await self.db.execute(
            select(Scene).where(Scene.script_id == script_id)
        )
        existing = count_result.scalars().all()

        # 前置产出的第一张图作为分镜参考
        prior_img = None
        for a in context.get("prior_artifacts", []):
            if a.get("tool") == "generate_image":
                prior_img = a.get("url")
                break

        prompt = args.get("prompt", context.get("goal", ""))
        scene = Scene(
            script_id=script_id,
            episode_id=episode_id,
            sequence=len(existing) + 1,
            prompt=prompt,
            duration=5,
            scene_type="normal",
            status="ready",
        )
        if prior_img:
            scene.parsed_prompt = {"agent_image": prior_img}
        self.db.add(scene)
        await self.db.flush()
        return {"id": str(scene.id), "sequence": scene.sequence, "script_id": str(script_id)}

    # -------------------- 辅助 --------------------
    async def _tag_task(self, task_id: str, agent_run_id: str, step_idx: int) -> None:
        """给 GenerationTask 打 agent_run 标记，写入 meta"""
        try:
            t = await self.db.execute(select(GenerationTask).where(GenerationTask.id == UUID(task_id)))
            task = t.scalar_one_or_none()
            if task:
                meta = dict(task.meta or {})
                meta["agent_run_id"] = agent_run_id
                meta["agent_step"] = step_idx
                task.meta = meta
                await self.db.flush()
        except Exception as e:
            logger.warning(f"Tag task {task_id} with agent_run failed: {e}")


# ==================== 查询（供 API 端点用） ====================
async def get_agent_run_status(
    db: AsyncSession, episode_id: UUID, agent_run_id: str,
) -> Dict[str, Any]:
    """根据 agent_run_id 聚合查询关联任务的状态（前端轮询用）"""
    # 遍历该 episode 的所有 task，meta 里带 agent_run_id 的
    result = await db.execute(
        select(GenerationTask)
        .where(GenerationTask.episode_id == episode_id)
        .order_by(GenerationTask.created_at.asc())
    )
    tasks = result.scalars().all()
    related = []
    for t in tasks:
        meta = t.meta or {}
        if meta.get("agent_run_id") == agent_run_id:
            related.append({
                "task_id": str(t.id),
                "step": meta.get("agent_step", 0),
                "type": t.type,
                "status": t.status,
                "urls": t.output_urls or [],
                "error": t.error_message,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            })
    related.sort(key=lambda x: x["step"])
    return {
        "agent_run_id": agent_run_id,
        "step_count": len(related),
        "steps": related,
        "completed": sum(1 for r in related if r["status"] == "completed"),
        "failed": sum(1 for r in related if r["status"] == "failed"),
    }


# ============================================================
# WizardAgentService - 剧本驱动 4 阶段向导（对标巨日禄 Agent）
# ============================================================
# 阶段持久化在 Episode.meta：
#   wizard_stage: script_input | assets | scenes | edit | completed
#   wizard_mode: fusion | image_to_video | composite | ppt
#   wizard_data: { characters, scenes, props, shots, asset_map } 解析中间产物
# 复用 Scene 表存分镜，SceneAsset 存分镜↔资源关联。

# 业务类型 ↔ SceneAsset.resource_type 映射
_ASSET_RESOURCE_TYPE = {
    "character": "character",
    "scene": "scene_bg",
    "prop": "prop",
}


class WizardAgentService(AgentService):
    """剧本驱动 4 阶段向导 Agent。继承 AgentService 复用工具层。"""

    # -------------------- 阶段1：解析剧本 --------------------
    async def stage_parse_script(
        self, episode_id: UUID, script_content: str, mode: str = "fusion",
        script_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """
        阶段1：解析整集剧本 → 提取角色/场景/物品/分镜。
        结果存入 Episode.meta.wizard_data，自动把角色/场景建为项目资源。
        script_id 可选：传入则把 Episode.script_id 关联到该剧本。
        """
        ep = await self._get_episode(episode_id)
        project_id = ep.project_id

        # 1. 调 script_analyzer 解析
        analysis = await analyze_script(self.llm, script_content, mode)

        # 2. 自动创建角色/场景资源（若不存在同名）
        asset_map: Dict[str, Dict[str, str]] = {}  # {"character:沈知意": {"resource_id": "..."}}
        for ch in analysis.get("characters", []):
            rid = await self._ensure_character(project_id, ch.get("name", ""), ch.get("appearance_prompt") or ch.get("description", ""))
            asset_map[f"character:{ch.get('name')}"] = {"resource_id": rid, "type": "character"}
        for sc in analysis.get("scenes", []):
            rid = await self._ensure_scene_bg(project_id, sc.get("name", ""), sc.get("prompt") or sc.get("description", ""))
            asset_map[f"scene:{sc.get('name')}"] = {"resource_id": rid, "type": "scene_bg"}
        for pr in analysis.get("props", []):
            rid = await self._ensure_prop(project_id, pr.get("name", ""), pr.get("description", ""))
            asset_map[f"prop:{pr.get('name')}"] = {"resource_id": rid, "type": "prop"}

        # 3. 持久化到 Episode.meta
        meta = dict(ep.meta or {})
        meta["wizard_stage"] = "assets"
        meta["wizard_mode"] = mode
        meta["wizard_script"] = script_content[:6000]
        meta["wizard_data"] = {
            "characters": analysis.get("characters", []),
            "scenes": analysis.get("scenes", []),
            "props": analysis.get("props", []),
            "shots": analysis.get("shots", []),
            "asset_map": asset_map,
            "source": analysis.get("source", "llm"),
        }
        ep.meta = meta
        # 关联剧本到集（如果传了 script_id）
        if script_id is not None:
            ep.script_id = script_id
        await self.db.flush()

        return {
            "stage": "assets",
            "mode": mode,
            "source": analysis.get("source"),
            "characters": analysis.get("characters", []),
            "scenes": analysis.get("scenes", []),
            "props": analysis.get("props", []),
            "shots_count": len(analysis.get("shots", [])),
        }

    # -------------------- 阶段2：资产管理 --------------------
    async def stage_save_assets(
        self, episode_id: UUID, asset_assignments: Dict[str, str],
    ) -> Dict[str, Any]:
        """
        阶段2：保存用户为每个解析项指定的资源。
        asset_assignments: {"character:沈知意": "resource_uuid", "scene:客厅": "resource_uuid", ...}
        若值为空字符串则表示用户选择"新建/不关联"。
        """
        ep = await self._get_episode(episode_id)
        meta = dict(ep.meta or {})
        wizard_data = dict(meta.get("wizard_data") or {})
        asset_map: Dict[str, Dict[str, str]] = dict(wizard_data.get("asset_map") or {})

        for key, resource_id in asset_assignments.items():
            if resource_id:
                # 解析 key 格式 "character:沈知意"
                parts = key.split(":", 1)
                rtype = _ASSET_RESOURCE_TYPE.get(parts[0], parts[0]) if len(parts) > 1 else "character"
                asset_map[key] = {"resource_id": resource_id, "type": rtype}

        wizard_data["asset_map"] = asset_map
        meta["wizard_data"] = wizard_data
        meta["wizard_stage"] = "scenes"
        ep.meta = meta
        await self.db.flush()

        return {"stage": "scenes", "asset_map": asset_map}

    # -------------------- 阶段3：拆分镜 --------------------
    async def stage_split_scenes(self, episode_id: UUID, force: bool = False) -> Dict[str, Any]:
        """
        阶段3：把 wizard_data.shots 写入 Scene 表，关联 SceneAsset。
        先清除该 episode 旧分镜（重拆），再创建新的。

        保护：如果已有分镜且其中部分已生成视频（status=completed 或有 generated_video_url），
        默认拒绝重建（避免覆盖已生成结果）。传 force=True 可强制重建。
        """
        ep = await self._get_episode(episode_id)
        project_id = ep.project_id
        meta = dict(ep.meta or {})
        wizard_data = meta.get("wizard_data") or {}
        mode = meta.get("wizard_mode", "fusion")

        characters = wizard_data.get("characters", [])
        scenes = wizard_data.get("scenes", [])
        shots = wizard_data.get("shots", [])
        asset_map = wizard_data.get("asset_map") or {}

        # 确保 episode 关联一个 script（Scene.script_id 非空）
        script_id = ep.script_id
        if not script_id:
            script_id = await self._ensure_script(project_id, episode_id, meta.get("wizard_script", ""))

        # 检查已有分镜：有已生成的视频时拒绝重建（除非 force）
        existing = await self.db.execute(
            select(Scene).where(Scene.episode_id == episode_id)
        )
        existing_scenes = existing.scalars().all()
        if existing_scenes and not force:
            # 检查是否有已生成分镜
            has_generated = any(
                s.status == "completed" or s.generated_video_url
                for s in existing_scenes
            )
            if has_generated:
                from app.core.exceptions import BadRequestException
                raise BadRequestException(
                    f"该集已有 {len(existing_scenes)} 个分镜，其中部分已生成视频。"
                    f"重新拆分会清除已生成的结果，如需继续请确认强制重拆。"
                )

        # 清除旧分镜（仅在 force=True 或无已生成分镜时到达这里）
        for old in existing_scenes:
            await self.db.delete(old)
        await self.db.flush()

        # 创建新分镜
        created: List[Dict[str, Any]] = []
        for shot in shots:
            prompt = build_shot_prompt(shot, characters, scenes, mode)
            scene = Scene(
                script_id=script_id,
                episode_id=episode_id,
                sequence=shot.get("sequence", len(created) + 1),
                prompt=prompt,
                parsed_prompt={
                    "narration": shot.get("narration", ""),
                    "shot_type": shot.get("shot_type", ""),
                    "camera_angle": shot.get("camera_angle", ""),
                    "camera_movement": shot.get("camera_movement", ""),
                    "lens": shot.get("lens", ""),
                    "depth_of_field": shot.get("depth_of_field", ""),
                    "lighting": shot.get("lighting", ""),
                    "characters": shot.get("characters", []),
                    "location": shot.get("location", ""),
                    "wizard_mode": mode,
                },
                duration=float(shot.get("duration", 5)),
                shot_type=shot.get("shot_type", ""),
                camera_angle=shot.get("camera_angle", ""),
                camera_movement=shot.get("camera_movement", ""),
                scene_type="normal",
                status="ready",
            )
            self.db.add(scene)
            await self.db.flush()

            # 关联角色/场景资源到分镜（SceneAsset）
            for ch in shot.get("characters", []):
                key = f"character:{ch.get('name')}"
                am = asset_map.get(key)
                if am:
                    await self._add_scene_asset(scene.id, "character", am["resource_id"])
            loc = shot.get("location")
            if loc:
                am = asset_map.get(f"scene:{loc}")
                if am:
                    await self._add_scene_asset(scene.id, "scene_bg", am["resource_id"])

            created.append({
                "id": str(scene.id),
                "sequence": scene.sequence,
                "duration": scene.duration,
                "prompt": scene.prompt[:100],
                "narration": shot.get("narration", "")[:80],
            })

        meta["wizard_stage"] = "edit"
        ep.meta = meta
        await self.db.flush()

        return {"stage": "edit", "scenes": created, "count": len(created)}

    # -------------------- 阶段4：生成视频 --------------------
    async def stage_generate_videos(
        self, episode_id: UUID, org_id: UUID, user_id: UUID,
        scene_ids: Optional[List[UUID]] = None, mode: Optional[str] = None,
        gen_params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        阶段4：按模式逐分镜生成视频。
        - fusion: 每分镜直接 image_to_video（从提示词生视频）
        - image_to_video: 两步——先 fusion 生图，再 image_to_video 生视频
        - composite: 同 image_to_video 但提示词更完整
        - ppt: 以生图为主 + 旁白

        gen_params: 生成参数（model/size/duration/resolution/quality/watermark_enabled），
                    由前端用户在阶段4设置，不传则用默认值。
        """
        ep = await self._get_episode(episode_id)
        project_id = ep.project_id
        meta = dict(ep.meta or {})
        if mode is None:
            mode = meta.get("wizard_mode", "fusion")
        gen_params = gen_params or {}
        agent_run_id = str(uuid4())

        # 查分镜
        stmt = select(Scene).where(Scene.episode_id == episode_id)
        if scene_ids:
            stmt = stmt.where(Scene.id.in_(scene_ids))
        stmt = stmt.order_by(Scene.sequence.asc())
        result = await self.db.execute(stmt)
        scenes = result.scalars().all()

        results: List[Dict[str, Any]] = []
        for idx, scene in enumerate(scenes):
            step_result: Dict[str, Any] = {
                "scene_id": str(scene.id),
                "sequence": scene.sequence,
                "status": "processing",
            }
            try:
                # 公共生成参数（从 gen_params 取，缺省用合理默认）
                # 注意：duration 不从 gen_params 取，自动用分镜自身的 scene.duration
                common_args = {
                    "model": gen_params.get("model"),
                    "size": gen_params.get("size", "16:9"),
                    "quality": gen_params.get("quality", "hd"),
                    "watermark_enabled": gen_params.get("watermark_enabled", False),
                }
                # 该分镜的时长（自动用分镜自身的 duration）
                scene_duration = float(scene.duration or 5)
                if mode in ("image_to_video", "composite"):
                    # 两步：先生图再生视频
                    img = await self._tool_generate_image(
                        project_id, episode_id, org_id, user_id,
                        {"prompt": scene.prompt, **common_args},
                        agent_run_id, idx,
                    )
                    step_result["image_task"] = img
                    if img.get("urls"):
                        vid = await self._tool_generate_video(
                            project_id, episode_id, org_id, user_id,
                            {"image_url": img["urls"][0], "prompt": scene.prompt,
                             "duration": scene_duration,
                             "resolution": gen_params.get("resolution", "720p"),
                             **common_args},
                            agent_run_id, idx,
                        )
                        step_result["video_task"] = vid
                        if vid.get("urls"):
                            scene.generated_video_url = vid["urls"][0]
                            scene.status = "completed"
                            step_result["status"] = "completed"
                            step_result["video_url"] = vid["urls"][0]
                elif mode == "ppt":
                    # PPT：以生图为主
                    img = await self._tool_generate_image(
                        project_id, episode_id, org_id, user_id,
                        {"prompt": scene.prompt, **common_args},
                        agent_run_id, idx,
                    )
                    step_result["image_task"] = img
                    if img.get("urls"):
                        scene.thumbnail_url = img["urls"][0]
                        scene.status = "completed"
                        step_result["status"] = "completed"
                        step_result["image_url"] = img["urls"][0]
                else:
                    # fusion：直接生视频
                    vid = await self._tool_generate_video(
                        project_id, episode_id, org_id, user_id,
                        {"image_url": "", "prompt": scene.prompt,
                         "duration": scene_duration,
                         "resolution": gen_params.get("resolution", "720p"),
                         **common_args},
                        agent_run_id, idx,
                    )
                    step_result["video_task"] = vid
                    if vid.get("urls"):
                        scene.generated_video_url = vid["urls"][0]
                        scene.status = "completed"
                        step_result["status"] = "completed"
                        step_result["video_url"] = vid["urls"][0]
                if step_result["status"] != "completed":
                    step_result["status"] = "failed"
                    scene.status = "failed"
            except Exception as e:
                logger.error(f"Wizard generate scene {scene.id} failed: {e}")
                step_result["status"] = "failed"
                step_result["error"] = str(e)[:200]
                scene.status = "failed"
            results.append(step_result)
            await self.db.flush()

        # 标记完成
        meta["wizard_stage"] = "completed"
        ep.meta = meta
        await self.db.flush()

        return {
            "agent_run_id": agent_run_id,
            "mode": mode,
            "results": results,
            "completed": sum(1 for r in results if r["status"] == "completed"),
            "failed": sum(1 for r in results if r["status"] == "failed"),
        }

    # -------------------- 向导状态查询 --------------------
    async def get_wizard_state(self, episode_id: UUID) -> Dict[str, Any]:
        """查询向导当前阶段和数据（前端打开时恢复用）"""
        ep = await self._get_episode(episode_id)
        meta = ep.meta or {}
        wizard_data = meta.get("wizard_data") or {}
        return {
            "episode_id": str(episode_id),
            "stage": meta.get("wizard_stage", "script_input"),
            "mode": meta.get("wizard_mode", "fusion"),
            "has_script": bool(meta.get("wizard_script")),
            "characters": wizard_data.get("characters", []),
            "scenes": wizard_data.get("scenes", []),
            "props": wizard_data.get("props", []),
            "shots": wizard_data.get("shots", []),
            "asset_map": wizard_data.get("asset_map", {}),
            "source": wizard_data.get("source"),
        }

    async def set_wizard_stage(self, episode_id: UUID, stage: str) -> Dict[str, Any]:
        """手动设置向导阶段（前进/回退）"""
        ep = await self._get_episode(episode_id)
        meta = dict(ep.meta or {})
        meta["wizard_stage"] = stage
        ep.meta = meta
        await self.db.flush()
        return {"stage": stage}

    # -------------------- 内部辅助 --------------------
    async def _get_episode(self, episode_id: UUID) -> Episode:
        result = await self.db.execute(select(Episode).where(Episode.id == episode_id))
        ep = result.scalar_one_or_none()
        if ep is None:
            from app.core.exceptions import NotFoundException
            raise NotFoundException("Episode not found", resource="Episode")
        return ep

    async def _ensure_character(self, project_id: UUID, name: str, prompt: str) -> str:
        """确保角色资源存在（同名复用），返回 id"""
        if not name:
            return ""
        result = await self.db.execute(
            select(Character).where(Character.project_id == project_id, Character.name == name)
        )
        existing = result.scalar_one_or_none()
        if existing:
            return str(existing.id)
        obj = Character(project_id=project_id, name=name, appearance_prompt=prompt, description=prompt)
        self.db.add(obj)
        await self.db.flush()
        return str(obj.id)

    async def _ensure_scene_bg(self, project_id: UUID, name: str, prompt: str) -> str:
        if not name:
            return ""
        result = await self.db.execute(
            select(SceneBackground).where(SceneBackground.project_id == project_id, SceneBackground.name == name)
        )
        existing = result.scalar_one_or_none()
        if existing:
            return str(existing.id)
        obj = SceneBackground(project_id=project_id, name=name, prompt=prompt, description=prompt)
        self.db.add(obj)
        await self.db.flush()
        return str(obj.id)

    async def _ensure_prop(self, project_id: UUID, name: str, prompt: str) -> str:
        if not name:
            return ""
        result = await self.db.execute(
            select(Prop).where(Prop.project_id == project_id, Prop.name == name)
        )
        existing = result.scalar_one_or_none()
        if existing:
            return str(existing.id)
        obj = Prop(project_id=project_id, name=name, prompt=prompt, description=prompt)
        self.db.add(obj)
        await self.db.flush()
        return str(obj.id)

    async def _ensure_script(self, project_id: UUID, episode_id: UUID, content: str) -> UUID:
        """确保 episode 关联一个 script（Scene.script_id 非空）"""
        ep = await self._get_episode(episode_id)
        if ep.script_id:
            return ep.script_id
        script = Script(project_id=project_id, title=f"Agent向导-集{ep.number or ''}",
                        content=content, format="plain")
        self.db.add(script)
        await self.db.flush()
        ep.script_id = script.id
        await self.db.flush()
        return script.id

    async def _add_scene_asset(self, scene_id: UUID, resource_type: str, resource_id: str) -> None:
        """关联分镜与资源（幂等：已存在则跳过）"""
        if not resource_id:
            return
        try:
            existing = await self.db.execute(
                select(SceneAsset).where(
                    SceneAsset.scene_id == scene_id,
                    SceneAsset.resource_type == resource_type,
                    SceneAsset.resource_id == UUID(resource_id),
                )
            )
            if existing.scalar_one_or_none():
                return
            sa = SceneAsset(
                scene_id=scene_id,
                resource_type=resource_type,
                resource_id=UUID(resource_id),
            )
            self.db.add(sa)
            await self.db.flush()
        except Exception as e:
            logger.warning(f"Add scene asset failed: {e}")

