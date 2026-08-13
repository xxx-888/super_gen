"""
Script Analyzer - LLM 驱动的剧本解析（仅 LLM，无正则兜底）

把一整集剧本喂给 LLM，输出结构化数据：
- characters: 角色清单（含外貌描述，便于后续生图）
- scenes: 场景清单（含画面描述）
- props: 物品清单
- shots: 分镜清单（含时长/空间/角色姿态/运镜/旁白/完整提示词）

设计要点：
- 只用 LLM 解析。LLM 不可用时直接报错（source="error"），由调用方转成失败任务。
- 用 _normalize_llm_result 对 LLM 返回做深度兜底规范化，保证下游永远拿到合法结构，
  即使 LLM 返回的 JSON 字段残缺/类型错/键名变体也能修复。

4 种生成模式（mode）对应不同解析侧重：
- fusion（融生视频）: 画面描述为主，每分镜直接生视频
- image_to_video（图生视频）: 画面 + 起始帧描述，两步生成
- composite（综合生视频）: 完整（画面+角色+运镜）
- ppt（真人解说PPT）: 旁白 + 分页画面，弱化运动
"""
import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from app.services.llm_client import LLMClient, LLMMessage

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


# ==================== 公共字段说明（4 种模式共享） ====================
_COMMON_SCHEMA = """## 提取内容与字段

### 角色 characters[]
- name: 角色名（必填。无论剧本是对话体还是第一人称叙事体，都要把出场人物的名字提取出来）
- description: 身份简介（10-20字，如「豪门少奶奶，外表柔弱内心清醒」）
- appearance_prompt: 外貌描述（必填，用于后续生成「正/侧/背三视图」标准人设，必须写全并保证全身可辨、风格统一）：性别、年龄段、身高体型、发型发色、脸型与五官特征、肤色、典型服饰（上装/下装/鞋/配饰，颜色款式要具体）、气质与常态表情。如「女性，25岁，纤瘦高挑，黑色长直发中分，鹅蛋脸丹凤眼，冷白皮，米色高领针织衫+黑色西裤+黑色高跟鞋，锁骨细金链，气质清冷，眉眼微垂」。要求：中性光、全身特征可辨、各分镜服饰气质保持一致，便于直接套用三视图出图。

### 场景 scenes[]
- name: 场景名（如「顾家老宅客厅」「医院走廊」）
- description: 简介
- prompt: 画面描述（必填，用于AI生图：空间布局、时间段（白天/夜晚）、主光源、色调氛围、陈设细节、风格。如「中式豪宅客厅，红木沙发与博古架，暖黄吊灯为主光，落地窗外是黄昏花园，写实电影质感」）

### 道具 props[]
- name: 名称（如「离婚协议」「安胎汤」「旧照片」）
- description: 外观描述

### 分镜 shots[]
- sequence: 序号（整数，从1递增）
- duration: 时长秒数（3-15）。短句对话 3-5 秒；情绪/动作段落可到 8-15 秒，单个分镜内允许「多个机位/景别的快速切换组合」
- location: 场景名（与上面 scenes.name 对应）
- characters: 出场角色，格式 [{"name":"角色名","pose":"动作姿态+表情+朝向描述"}]
- shot_type: 景别（大远景/远景/全景/中景/中近景/近景/特写/极特写）
- camera_movement: 运镜（推轨/缓慢推进/拉远/缓慢平移/摇移/跟拍/手持/稳定器运动/环绕/升降/快速甩镜/静止）。静止要少用，优先有运动的镜头
- camera_angle: 镜头角度（平视/仰拍/俯拍/顶拍/倾斜荷兰角）。同一场景内尽量变化，避免全程平视
- lens: 焦距（广角24mm以下/标准35-50mm/中长焦70-105mm/长焦135mm以上/微距）。特写用中长焦，空间压迫感用广角
- depth_of_field: 景深（大景深/中景深/浅景深）。对话特写多用浅景深虚化背景
- lighting: 光影描述（一句话，含主光源+光线质感+光线方向+辅光）。如「窗外日光为主，柔光，侧逆光，反光板补面部阴影」。暗调写「无主光，暗调，轮廓光勾勒」
- narration: 这一镜的台词或旁白（一字不差引用剧本原文，不改写不翻译）
- prompt: 画面提示词（必填，完整画面描述。把场景空间、人物外貌+姿态+表情、光影、色调、景别、镜头角度、焦距与景深、运镜、氛围整合成一段流畅画面，结尾固定加风格词如「电影感，写实风格」。不含台词）"""


_COMMON_RULES = """## 分镜拆分规则
- 每个对话轮次或重要动作单独成一个分镜
- 场景切换必须新开分镜
- 情绪/剧情转折单独分镜
- 同一场景的连续微小动作可合并
- 第一人称叙事剧本：按「一段连续动作或一次对话」切分，不要整段塞进一个分镜
- 长台词处理：任何角色连续说话超过5秒，必须拆成多个分镜——前半句给说话者近景，后半句用画外音切到对方反应特写/环境大景/道具特写；禁止一个分镜里一人长时间说话
- 连贯性：相邻分镜的人物站位、朝向、左右关系必须衔接得上

## 输出要求（极其重要，必须严格遵守）
- 只输出一个 JSON 对象，不要输出任何其他文字、注释、解释
- 不要使用 markdown 代码块标记（不要写 ```json）
- 第一个字符必须是 { ，最后一个字符必须是 }
- 字符串值内不要包含未转义的双引号和换行符（换行用空格代替）
- 所有数组都用 [] 包裹，即使是空数组也写 []
- 每个分镜的 prompt 字段必须填写完整画面描述，不能为空
- narration 必须一字不差引用原文台词，不得改写或翻译

## 输出格式示例
{"characters":[{"name":"林晚意","description":"豪门少奶奶，外表柔弱内心清醒","appearance_prompt":"女性，25岁，纤瘦高挑，黑色长直发中分，鹅蛋脸丹凤眼，冷白皮，米色高领针织衫+黑色西裤+黑色高跟鞋，锁骨细金链，气质清冷，中性光，全身可辨，适合三视图出图"}],"scenes":[{"name":"顾家客厅","description":"中式豪宅客厅","prompt":"红木沙发与博古架，暖黄吊灯为主光，落地窗外黄昏花园，写实电影质感"}],"props":[{"name":"安胎汤","description":"乳白色汤，飘着枸杞，白瓷碗"}],"shots":[{"sequence":1,"duration":5,"location":"顾家客厅","characters":[{"name":"林晚意","pose":"端着白瓷汤碗，微皱眉，低头看碗"}],"shot_type":"近景","camera_movement":"缓慢推进","camera_angle":"微俯拍","lens":"中长焦85mm","depth_of_field":"浅景深","lighting":"暖黄吊灯为主，柔光，顶侧光，背景略暗","narration":"这汤怎么是苦的？","prompt":"写实电影质感，中式豪宅客厅暖黄吊灯下，年轻女性（黑色长直发，米色高领针织衫）端着白瓷汤碗低头皱眉查看，近景，微俯拍，85mm中长焦浅景深背景虚化，缓慢推进，暖黄柔光顶侧照明背景略暗，悬疑压抑氛围，电影感，写实风格"}]}"""


# ==================== 视频模式共享：整体风格与节奏（ppt 模式不用） ====================
_COMMON_STYLE = """## 整体风格与节奏要求（贯穿全部分镜）
- 视觉对标 Netflix 美剧质感：电影感、写实、画面有层次，禁止视觉极其平淡。
- 运镜与角度必须丰富：少用「固定镜头+平视角度」的组合，同一场景内角度不能单调；用仰拍/俯拍/倾斜（荷兰角）/特写/正反打增强视觉张力与情绪。
- 文戏按「情绪节奏」匹配运镜：紧张用快速推进/手持晃动，温情用缓慢推轨/柔光。
- 打戏/冲突用「快速剪辑+冲击力机位」（低角度仰拍、倾斜角、快速甩镜、极特写）组合。
- 节奏要快、符合海外爆款短剧：多切正反打、反应镜头、面部特写、手部/道具特写。
- 连贯性：注意上下镜头的人物位置关系（左右站位、朝向、距离）必须衔接，禁止人物位置穿帮。
- 忠于原文：禁止更改或改写剧本台词与动作，台词一字不差地引用到 narration。"""


# ==================== 模式专属 system prompt ====================
_MODE_PROMPTS = {
    "fusion": f"""你是资深短剧分镜导演，有 Netflix 美剧质感与海外爆款短剧的剪辑节奏经验。分析用户给的剧本，输出 JSON 用于 AI 视频生成（融生模式：每个分镜直接生成视频）。

{_COMMON_STYLE}

{_COMMON_SCHEMA}

{_COMMON_RULES}""",

    "image_to_video": f"""你是资深短剧分镜导演，有 Netflix 美剧质感与海外爆款短剧的剪辑节奏经验。分析剧本，输出 JSON 用于「先生图再生视频」两步生成。

{_COMMON_STYLE}

{_COMMON_SCHEMA}

### 本模式额外字段（shots 每项增加）
- first_frame_prompt: 这一镜起始帧的静态画面描述（用于文生图：人物站位/表情/光线/构图，不含运动）

{_COMMON_RULES}""",

    "composite": f"""你是资深短剧分镜导演，有 Netflix 美剧质感与海外爆款短剧的剪辑节奏经验。做最完整的剧本拆解（综合模式）。

{_COMMON_STYLE}

{_COMMON_SCHEMA}

### 本模式额外字段（shots 每项增加）
- mood: 情绪氛围（如 紧张/温馨/冷峻/压抑/欢快）
- style: 视觉风格（如 写实/电影感/动漫/水彩）

{_COMMON_RULES}""",

    "ppt": f"""你是真人解说 PPT 模式的剧本拆解助手。把剧本拆成「分页画面 + 旁白」结构，弱化视频运动。

{_COMMON_SCHEMA}

### 本模式侧重
- 每个分镜对应一页 PPT：一段旁白 + 一张配图
- shot_type 多用中景/近景，画面稳定
- camera_movement 多为静止或极缓推
- narration 直接引用剧本解说词，可较长
- prompt 是静态构图配图描述，适合 PPT 风格

{_COMMON_RULES}""",
}


# ==================== LLM 结果规范化器（数据兜底） ====================
# 字段别名：LLM 偶尔用近义键名，统一归一到标准名
_TOP_ALIASES = {
    "characters": ["characters", "character", "character_list", "角色", "roles", "role"],
    "scenes": ["scenes", "scene", "scene_list", "场景", "locations", "location"],
    "props": ["props", "prop", "prop_list", "物品", "道具", "items", "item"],
    "shots": ["shots", "shot", "shot_list", "分镜", "scenes_v2", "storyboard"],
}
_CHAR_ALIASES = {
    "name": ["name", "角色名", "姓名", "title"],
    "description": ["description", "desc", "intro", "身份", "简介", "summary"],
    "appearance_prompt": ["appearance_prompt", "appearance", "appearance_desc", "look", "外貌", "外貌描述", "形象"],
}
_SCENE_ALIASES = {
    "name": ["name", "场景名", "title"],
    "description": ["description", "desc", "intro", "简介", "summary"],
    "prompt": ["prompt", "画面描述", "画面", "image_prompt", "visual"],
}
_PROP_ALIASES = {
    "name": ["name", "名称", "title"],
    "description": ["description", "desc", "外观", "外观描述", "summary"],
}
_SHOT_ALIASES = {
    "sequence": ["sequence", "seq", "index", "序号", "no", "number"],
    "duration": ["duration", "时长", "seconds", "time"],
    "location": ["location", "scene", "场景", "place", "场景名"],
    "characters": ["characters", "角色", "people", "persons"],
    "shot_type": ["shot_type", "景别", "framing", "shot"],
    "camera_movement": ["camera_movement", "运镜", "movement", "camera"],
    "camera_angle": ["camera_angle", "镜头角度", "角度", "angle"],
    "lens": ["lens", "焦距", "focal", "focal_length"],
    "depth_of_field": ["depth_of_field", "景深", "dof", "depth"],
    "lighting": ["lighting", "光影", "光线", "light"],
    "narration": ["narration", "台词", "对白", "dialogue", "旁白", "voiceover", "text"],
    "prompt": ["prompt", "画面描述", "画面", "image_prompt", "visual"],
    "first_frame_prompt": ["first_frame_prompt", "起始帧", "first_frame", "start_frame"],
    "mood": ["mood", "情绪", "atmosphere"],
    "style": ["style", "风格", "visual_style"],
}


def _pick(d: Any, aliases: List[str]) -> Any:
    """从一个 dict 里按别名列表取第一个命中的值。"""
    if not isinstance(d, dict):
        return None
    for key in aliases:
        if key in d and d[key] not in (None, ""):
            return d[key]
    return None


def _to_int(val: Any, default: int) -> int:
    """把可能是字符串的数字转成 int，失败返回 default。"""
    if isinstance(val, bool):
        return default
    if isinstance(val, int):
        return val
    if isinstance(val, float):
        return int(val)
    if isinstance(val, str):
        s = val.strip()
        # 形如 "5秒" / "5s" / "约5"
        digits = ""
        for ch in s:
            if ch.isdigit():
                digits += ch
            elif digits:
                break
        if digits:
            try:
                return int(digits)
            except ValueError:
                pass
    return default


def _normalize_characters(raw: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set = set()
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            name = item.strip()
            if name and name not in seen:
                seen.add(name)
                out.append({"name": name, "description": "", "appearance_prompt": ""})
            continue
        if not isinstance(item, dict):
            continue
        name = str(_pick(item, _CHAR_ALIASES["name"]) or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({
            "name": name,
            "description": str(_pick(item, _CHAR_ALIASES["description"]) or ""),
            "appearance_prompt": str(_pick(item, _CHAR_ALIASES["appearance_prompt"]) or ""),
        })
    return out


def _normalize_scenes(raw: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set = set()
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            name = item.strip()
            if name and name not in seen:
                seen.add(name)
                out.append({"name": name, "description": "", "prompt": ""})
            continue
        if not isinstance(item, dict):
            continue
        name = str(_pick(item, _SCENE_ALIASES["name"]) or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({
            "name": name,
            "description": str(_pick(item, _SCENE_ALIASES["description"]) or ""),
            "prompt": str(_pick(item, _SCENE_ALIASES["prompt"]) or ""),
        })
    return out


def _normalize_props(raw: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set = set()
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            name = item.strip()
            if name and name not in seen:
                seen.add(name)
                out.append({"name": name, "description": ""})
            continue
        if not isinstance(item, dict):
            continue
        name = str(_pick(item, _PROP_ALIASES["name"]) or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({
            "name": name,
            "description": str(_pick(item, _PROP_ALIASES["description"]) or ""),
        })
    return out


def _normalize_shots(raw: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        # sequence：缺失则按下标+1，转 int
        seq = _to_int(_pick(item, _SHOT_ALIASES["sequence"]), idx + 1)
        duration = _to_int(_pick(item, _SHOT_ALIASES["duration"]), 5)
        duration = max(2, min(15, duration))  # clamp [2,15]

        # characters 容错：可能是 [{"name":..}] 也可能是 ["张三"]
        shot_chars_raw = _pick(item, _SHOT_ALIASES["characters"])
        shot_chars: List[Dict[str, str]] = []
        if isinstance(shot_chars_raw, list):
            for sc in shot_chars_raw:
                if isinstance(sc, str):
                    shot_chars.append({"name": sc.strip(), "pose": ""})
                elif isinstance(sc, dict):
                    cname = str(sc.get("name") or sc.get("角色名") or "").strip()
                    if cname:
                        shot_chars.append({
                            "name": cname,
                            "pose": str(sc.get("pose") or sc.get("姿态") or ""),
                        })

        shot = {
            "sequence": seq,
            "duration": duration,
            "location": str(_pick(item, _SHOT_ALIASES["location"]) or ""),
            "characters": shot_chars,
            "shot_type": str(_pick(item, _SHOT_ALIASES["shot_type"]) or "中景"),
            "camera_movement": str(_pick(item, _SHOT_ALIASES["camera_movement"]) or "静止"),
            "camera_angle": str(_pick(item, _SHOT_ALIASES["camera_angle"]) or "平视"),
            "lens": str(_pick(item, _SHOT_ALIASES["lens"]) or ""),
            "depth_of_field": str(_pick(item, _SHOT_ALIASES["depth_of_field"]) or ""),
            "lighting": str(_pick(item, _SHOT_ALIASES["lighting"]) or ""),
            "narration": str(_pick(item, _SHOT_ALIASES["narration"]) or ""),
            "prompt": str(_pick(item, _SHOT_ALIASES["prompt"]) or ""),
        }
        # 模式额外字段（存在则保留）
        ffp = _pick(item, _SHOT_ALIASES["first_frame_prompt"])
        if ffp:
            shot["first_frame_prompt"] = str(ffp)
        mood = _pick(item, _SHOT_ALIASES["mood"])
        if mood:
            shot["mood"] = str(mood)
        style = _pick(item, _SHOT_ALIASES["style"])
        if style:
            shot["style"] = str(style)
        out.append(shot)

    # sequence 去重（保留首个），并重新连续编号避免空洞/重复
    if out:
        seen_seq: set = set()
        deduped: List[Dict[str, Any]] = []
        for s in out:
            if s["sequence"] in seen_seq:
                continue
            seen_seq.add(s["sequence"])
            deduped.append(s)
        # 重新从 1 连续编号
        for i, s in enumerate(deduped, start=1):
            s["sequence"] = i
        out = deduped
    return out


def _normalize_llm_result(result: Any) -> Dict[str, Any]:
    """
    对 LLM 返回的 JSON 做深度兜底规范化。
    保证下游永远拿到 {characters, scenes, props, shots} 四个合法数组，
    且 shots 每项字段齐全、prompt 非空（空则用 build_shot_prompt 兜底）。
    """
    if not isinstance(result, dict):
        return {"characters": [], "scenes": [], "props": [], "shots": []}

    # 解包常见包裹层：有些模型/网关会把真正的内容包在 data / result / choices[0].message.content 里。
    # 只在顶层找不到 characters/shots 时才下沉一层，避免误伤。
    if not any(_pick(result, _TOP_ALIASES[k]) is not None for k in ("characters", "shots")):
        for wrap_key in ("data", "result", "response", "output", "choices"):
            inner = result.get(wrap_key)
            # choices[0].message.content 是 OpenAI 风格（content 是 JSON 字符串）
            if wrap_key == "choices" and isinstance(inner, list) and inner:
                msg = inner[0].get("message", {}) if isinstance(inner[0], dict) else {}
                content_str = msg.get("content")
                if isinstance(content_str, str):
                    import json as _json
                    try:
                        inner = _json.loads(content_str)
                    except Exception:
                        inner = None
            if isinstance(inner, dict) and any(
                _pick(inner, _TOP_ALIASES[k]) is not None for k in ("characters", "shots")
            ):
                result = inner
                break

    characters = _normalize_characters(_pick(result, _TOP_ALIASES["characters"]))
    scenes = _normalize_scenes(_pick(result, _TOP_ALIASES["scenes"]))
    props = _normalize_props(_pick(result, _TOP_ALIASES["props"]))
    shots = _normalize_shots(_pick(result, _TOP_ALIASES["shots"]))

    # 每个 shot 的 prompt 兜底：为空时现场拼装
    for shot in shots:
        if not shot.get("prompt"):
            shot["prompt"] = build_shot_prompt(shot, characters, scenes, "fusion")

    return {"characters": characters, "scenes": scenes, "props": props, "shots": shots}


# ==================== 提示词模板加载 ====================
async def get_script_parse_prompt(
    db: Optional["AsyncSession"], mode: str, template_id: Optional[str] = None,
) -> str:
    """
    获取剧本解析用的 system prompt。
    优先级：
      1. 指定 template_id → 从 DB 取该模板（必须是 script_parse 类目且启用）
      2. DB 里 category=script_parse + mode 匹配 + is_default=True 的启用模板
      3. DB 里 category=script_parse + mode 匹配 + 启用中 priority 最高的
      4. 内置 _MODE_PROMPTS 兜底
    """
    if db is not None:
        try:
            from app.models import PromptTemplate
            from sqlalchemy import select
            if template_id:
                r = await db.execute(
                    select(PromptTemplate).where(
                        PromptTemplate.id == template_id,
                        PromptTemplate.is_enabled == True,  # noqa: E712
                    )
                )
                pt = r.scalar_one_or_none()
                if pt and pt.content:
                    return pt.content
            # 默认模板
            r = await db.execute(
                select(PromptTemplate).where(
                    PromptTemplate.category == "script_parse",
                    PromptTemplate.mode == mode,
                    PromptTemplate.is_enabled == True,  # noqa: E712
                    PromptTemplate.is_default == True,  # noqa: E712
                ).limit(1)
            )
            pt = r.scalar_one_or_none()
            if pt and pt.content:
                return pt.content
            # 退而求其次：该 mode 下 priority 最高的启用模板
            r = await db.execute(
                select(PromptTemplate).where(
                    PromptTemplate.category == "script_parse",
                    PromptTemplate.mode == mode,
                    PromptTemplate.is_enabled == True,  # noqa: E712
                ).order_by(PromptTemplate.priority.desc()).limit(1)
            )
            pt = r.scalar_one_or_none()
            if pt and pt.content:
                return pt.content
        except Exception as e:
            logger.warning(f"Load prompt template failed, use builtin: {e}")
    # 内置兜底
    return _MODE_PROMPTS.get(mode, _MODE_PROMPTS["fusion"])


# ==================== 主入口 ====================
async def analyze_script(
    llm: Optional[LLMClient],
    script_content: str,
    mode: str = "fusion",
    db: Optional["AsyncSession"] = None,
    template_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    用 LLM 解析整集剧本为结构化数据（无正则兜底）。

    Args:
        llm: LLM 客户端（可为 None）
        script_content: 剧本文本
        mode: fusion / image_to_video / composite / ppt
        db: 数据库会话（用于加载后台配置的提示词模板，可选）
        template_id: 指定使用的提示词模板 ID（可选，优先级最高）

    Returns:
        成功: {characters, scenes, props, shots, source: "llm"}
        LLM 不可用: {characters:[],..., source: "error", error: "..."}
        解析失败:   {characters:[],..., source: "error", error: "..."}
    """
    if not script_content or not script_content.strip():
        return {"characters": [], "scenes": [], "props": [], "shots": [], "source": "empty"}

    # LLM 不可用：直接报错，不静默返回空壳
    if llm is None or not llm.available:
        return {
            "characters": [], "scenes": [], "props": [], "shots": [],
            "source": "error",
            "error": "未配置 LLM 模型，无法解析。请在「后台管理 → 配置模型」添加 type=大语言模型 的记录，或设置 LLM_API_KEY/LLM_BASE_URL。",
        }

    # 加载提示词模板（后台配置 > 内置）
    system_prompt = await get_script_parse_prompt(db, mode, template_id)
    # 是否用了自定义模板：个别模板会触发模型异常输出（空响应/无法规范化），
    # 失败时自动回退内置提示词再试一轮，保证解析尽量能出结果。
    builtin_prompt = _MODE_PROMPTS.get(mode, _MODE_PROMPTS["fusion"])
    using_custom_template = system_prompt != builtin_prompt

    content = script_content.strip()

    # 超长剧本分块解析：每块 ~15000 字，分别调 LLM，最后合并
    CHUNK_SIZE = 15000

    async def _analyze_with_prompt(prompt: str) -> Optional[Dict[str, Any]]:
        """用指定 system prompt 解析整段剧本（自动处理超长分块）。"""
        if len(content) <= CHUNK_SIZE:
            return await _analyze_with_retry(llm, content, prompt)
        logger.info(f"Script too long ({len(content)} chars), splitting into chunks")
        chunks = _split_into_chunks(content, CHUNK_SIZE)
        logger.info(f"Split into {len(chunks)} chunks: {[len(c) for c in chunks]}")
        partials: List[Dict[str, Any]] = []
        for i, chunk in enumerate(chunks):
            logger.info(f"Analyzing chunk {i + 1}/{len(chunks)} ({len(chunk)} chars)")
            r = await _analyze_with_retry(llm, chunk, prompt)
            if r:
                partials.append(r)
            else:
                logger.warning(f"Chunk {i + 1} failed, skipping")
        if not partials:
            return None
        merged = _merge_chunk_results(partials)
        logger.info(
            f"Merged {len(partials)} chunks: "
            f"{len(merged.get('characters', []))} chars, "
            f"{len(merged.get('shots', []))} shots"
        )
        return merged

    raw_result = await _analyze_with_prompt(system_prompt)

    if not raw_result:
        # 自定义模板解析失败 → 回退内置提示词再试一轮
        if using_custom_template:
            logger.warning("解析失败（自定义模板），回退内置提示词重试一次")
            raw_result = await _analyze_with_prompt(builtin_prompt)
        if not raw_result:
            # 注意：这里拿不到 _analyze_with_retry 内部的异常变量，不要引用未定义的名字
            #（曾因引用 last_err 触发 NameError，把可展示的失败变成崩溃）。
            return {
                "characters": [], "scenes": [], "props": [], "shots": [],
                "source": "error",
                "error": (
                    "LLM 解析失败（已重试 3 次）：模型连续返回空内容。"
                    "常见原因：推理模型把输出额度耗在思考上（后台任务详情的「接口日志」里"
                    "finish_reason/推理长度可确认）、max_tokens 不足或模型不稳定。"
                    "可尝试：换非推理模型（如 deepseek-chat / glm-4-flash）、"
                    "关闭推理参数，或稍后重试。"
                ),
            }

    # 深度规范化
    result = _normalize_llm_result(raw_result)

    # 规范化后仍全空 → LLM 没提取出有效内容
    if not result["characters"] and not result["shots"]:
        # 自定义模板输出无法规范化 → 回退内置提示词再试一轮
        if using_custom_template:
            logger.warning("自定义模板输出规范化为空，回退内置提示词重试一次")
            fb_raw = await _analyze_with_prompt(builtin_prompt)
            if fb_raw:
                result = _normalize_llm_result(fb_raw)
        if not result["characters"] and not result["shots"]:
            raw_keys = (
                list(raw_result.keys())[:10]
                if isinstance(raw_result, dict) else type(raw_result).__name__
            )
            return {
                "characters": [], "scenes": [], "props": [], "shots": [],
                "source": "error",
                "error": (
                    f"LLM 未能从剧本中提取有效内容（模型返回顶层字段: {raw_keys}）。"
                    "可能是自定义提示词模板与输出格式不兼容或模型输出异常，"
                    "已尝试内置模板兜底仍失败。可简化/更换后台模板，或更换模型重试。"
                ),
            }

    result["source"] = "llm"
    logger.info(
        f"LLM analyze OK: {len(result['characters'])} chars, "
        f"{len(result['scenes'])} scenes, {len(result['props'])} props, "
        f"{len(result['shots'])} shots"
    )
    return result


async def _analyze_with_llm(
    llm: LLMClient, content: str, system_prompt: str,
) -> Optional[Dict[str, Any]]:
    """用 LLM 解析剧本，返回原始 dict（未经规范化）。system_prompt 由调用方决定（后台模板或内置）。

    关键：关闭 thinking 模式。剧本解析是结构化提取任务，不需要深度推理。
    thinking 会消耗大量 max_tokens 导致正式输出被截断或超时失败。
    """
    import copy
    simple_llm = copy.copy(llm)
    simple_llm.extra_body = {}  # 清除 thinking/reasoning_effort 等透传参数
    messages = [
        LLMMessage(role="system", content=system_prompt),
        LLMMessage(
            role="user",
            content=(
                "请分析以下剧本并输出 JSON。记住：只输出 JSON 对象，"
                "第一个字符必须是 {，最后一个字符必须是 }，不要输出任何其他内容。\n\n"
                f"剧本：\n{content}"
            ),
        ),
    ]
    # 输出上限 16384（原 12000）：推理模型思考也计入输出额度，太小会导致正文为空；
    # 后台模型配置 config.max_tokens 可再抬高（只会调大不会调小）。
    # json_mode：DeepSeek/OpenAI 的 JSON Output（response_format=json_object），
    # 从源头保证合法 JSON；不支持该参数的厂商会自动去掉重试。提示词已含 JSON
    # 字样与输出示例，满足 JSON 模式的前置要求；空 content 由上层重试+内置兜底覆盖。
    result = await simple_llm.chat_with_json(messages, temperature=0.2, max_tokens=16384, json_mode=True)
    if not isinstance(result, dict):
        return None
    return result


async def _analyze_with_retry(
    llm: LLMClient, content: str, system_prompt: str,
    max_retries: int = 2,
) -> Optional[Dict[str, Any]]:
    """带指数退避的重试包装。瞬时失败等待后重试，不浪费连续 3 次的时间。"""
    last_err: Optional[Exception] = None
    for attempt in range(max_retries + 1):
        try:
            result = await _analyze_with_llm(llm, content, system_prompt)
            if result:
                return result
            logger.info(f"LLM analyze returned None on attempt {attempt + 1}")
        except Exception as e:
            last_err = e
            logger.warning(f"LLM analyze attempt {attempt + 1} failed: {e}")
        if attempt < max_retries:
            backoff = 3 * (attempt + 1)  # 3s, 6s
            logger.info(f"Retrying in {backoff}s...")
            import asyncio
            await asyncio.sleep(backoff)
    if last_err:
        logger.error(f"LLM analyze failed after {max_retries + 1} attempts: {last_err}")
    return None


def _split_into_chunks(text: str, max_size: int) -> List[str]:
    """按自然段落分块，尽量在段落边界切割，每块不超过 max_size 字。"""
    paragraphs = text.split("\n")
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0
    for para in paragraphs:
        para_len = len(para) + 1  # +1 for \n
        if current_len + para_len > max_size and current:
            chunks.append("\n".join(current))
            current = [para]
            current_len = para_len
        else:
            current.append(para)
            current_len += para_len
    if current:
        chunks.append("\n".join(current))
    return chunks


def _merge_chunk_results(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """合并多块解析结果：角色/场景/道具去重，分镜按序拼接。"""
    merged: Dict[str, Any] = {
        "characters": [],
        "scenes": [],
        "props": [],
        "shots": [],
    }
    seen_char_names: set = set()
    seen_scene_names: set = set()
    seen_prop_names: set = set()
    shot_seq = 0

    for r in results:
        # 角色去重（按 name）
        for ch in r.get("characters", []):
            name = ch.get("name", "")
            if name and name not in seen_char_names:
                seen_char_names.add(name)
                merged["characters"].append(ch)
        # 场景去重（按 name）
        for sc in r.get("scenes", []):
            name = sc.get("name", "")
            if name and name not in seen_scene_names:
                seen_scene_names.add(name)
                merged["scenes"].append(sc)
        # 道具去重（按 name）
        for pr in r.get("props", []):
            name = pr.get("name", "")
            if name and name not in seen_prop_names:
                seen_prop_names.add(name)
                merged["props"].append(pr)
        # 分镜按序拼接，重新编号
        for shot in r.get("shots", []):
            shot_seq += 1
            shot["sequence"] = shot_seq
            merged["shots"].append(shot)

    return merged


# ==================== 辅助：从解析结果组装分镜提示词 ====================
def build_shot_prompt(shot: Dict[str, Any], characters: List[Dict[str, Any]],
                      scenes: List[Dict[str, Any]], mode: str) -> str:
    """
    把单个分镜的结构化数据组装成完整的画面提示词（用于生图/生视频）。
    若 shot.prompt 已存在则优先用，否则现场拼装。
    """
    if shot.get("prompt"):
        return shot["prompt"]

    # 场景描述
    scene_name = shot.get("location", "")
    scene_desc = ""
    for s in scenes:
        if s.get("name") == scene_name:
            scene_desc = s.get("prompt") or s.get("description", "")
            break

    # 角色姿态
    char_parts: List[str] = []
    char_map = {c["name"]: c for c in characters if "name" in c}
    for ch in shot.get("characters", []):
        name = ch.get("name", "") if isinstance(ch, dict) else str(ch)
        if not name:
            continue
        pose = ch.get("pose", "") if isinstance(ch, dict) else ""
        appearance = char_map.get(name, {}).get("appearance_prompt", "")
        part = name
        if appearance:
            part += f"（{appearance}）"
        if pose:
            part += f"，{pose}"
        char_parts.append(part)

    parts = []
    if scene_desc:
        parts.append(f"场景：{scene_name}，{scene_desc}")
    elif scene_name:
        parts.append(f"场景：{scene_name}")
    if char_parts:
        parts.append("人物：" + "；".join(char_parts))
    if shot.get("shot_type"):
        parts.append(f"镜头：{shot['shot_type']}")
    if shot.get("camera_angle") and shot["camera_angle"] != "平视":
        parts.append(f"角度：{shot['camera_angle']}")
    if shot.get("camera_movement") and shot["camera_movement"] != "静止":
        parts.append(f"运镜：{shot['camera_movement']}")
    if shot.get("depth_of_field"):
        parts.append(f"景深：{shot['depth_of_field']}")
    if shot.get("lighting"):
        parts.append(f"光影：{shot['lighting']}")
    if mode == "ppt":
        parts.append("风格：静态构图，PPT 配图质感")
    else:
        lens_part = shot.get("lens") or "35mm"
        parts.append(f"风格：写实电影质感，{lens_part}")

    return "。".join(parts) + "。"
