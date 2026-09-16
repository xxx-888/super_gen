"""模板库种子（M9）：官方剧本模板 + 完整示例项目，启动时幂等执行。

- 剧本模板：按稳定 id 插入（已存在跳过，后台可自由修改，重启不会覆盖）
- 示例项目：settings.template_seed_key 幂等标记。示例项目挂在首个 admin
  名下（普通用户项目列表已排除 is_template，不影响 admin 自己的列表），
  含完整创作树：剧本(已解析) + 3角色 + 3场景 + 2道具 + 1集 + 8分镜 +
  分镜-资源引用，克隆后用户可直接体验「生成第一支片」全流程。
"""
import logging

from sqlalchemy import select

from app.core.database import AsyncSessionLocal

logger = logging.getLogger(__name__)

EXAMPLE_SEED_KEY = "example-urban-romance-1"


async def ensure_default_templates() -> None:
    """幂等种子：剧本模板表 + 官方示例项目（供 lifespan 调用）。"""
    async with AsyncSessionLocal() as db:
        await _seed_script_templates(db)
        await _seed_example_project(db)
        await db.commit()


async def _seed_script_templates(db) -> None:
    from app.data.script_templates_data import SCRIPT_TEMPLATES
    from app.models import ScriptTemplate

    existing = {row[0] for row in (await db.execute(select(ScriptTemplate.id))).all()}
    added = 0
    for t in SCRIPT_TEMPLATES:
        if t["id"] in existing:
            continue
        db.add(ScriptTemplate(
            id=t["id"], genre=t["genre"], title=t["title"],
            logline=t["logline"], description=t["description"],
            tags=t["tags"], content=t["content"],
            characters=t["characters"], episode_count=t["episode_count"],
            sort_order=t["sort_order"], is_active=True,
        ))
        added += 1
    if added:
        logger.info(f"模板库：已种子 {added} 个官方剧本模板")


async def _seed_example_project(db) -> None:
    from app.models import (
        Project, User, Organization, Script, Character, SceneBackground,
        Prop, Episode, Scene, SceneAsset,
    )

    # 幂等：按 seed key 查询（JSONB 索引查询与邀请 token 同款写法）
    dup = (await db.execute(
        select(Project).where(Project.settings["template_seed_key"].astext == EXAMPLE_SEED_KEY)
    )).scalar_one_or_none()
    if dup:
        return

    admin = (await db.execute(
        select(User).where(User.role == "admin").order_by(User.created_at.asc()).limit(1)
    )).scalar_one_or_none()
    if admin is None:
        logger.warning("模板库：无 admin 用户，跳过示例项目种子")
        return
    org_id = admin.active_org_id
    if org_id is None:
        org = (await db.execute(
            select(Organization).where(
                Organization.owner_id == admin.id, Organization.is_personal.is_(True))
        )).scalar_one_or_none()
        org_id = org.id if org else None

    from app.data.script_templates_data import SCRIPT_TEMPLATES
    src_id = EXAMPLE_SEED_KEY.removeprefix("example-")
    src = next(t for t in SCRIPT_TEMPLATES if t["id"] == src_id)

    project = Project(
        user_id=admin.id, org_id=org_id,
        name="示例项目·《咖啡厅的心动预告》",
        description="官方示例：完整演示 剧本→角色/场景→分镜提示词 的标准工作流，一键克隆后即可开始你的第一支片。",
        cover_image_url="/template-covers/urban-romance.svg",
        status="draft",
        settings={"template_seed_key": EXAMPLE_SEED_KEY},
        is_template=True,
        template_genre="都市甜宠",
        template_desc="完整走通全流程的入门示例：3 角色 / 3 场景 / 8 分镜提示词全部配好，克隆后可直接点「生成分镜图」。",
        template_sort=1,
    )
    db.add(project)
    await db.flush()

    # ---- 资源：角色 / 场景 / 道具 ----
    chars = {}
    for c in src["characters"]:
        ch = Character(
            project_id=project.id, name=c["name"],
            appearance_prompt=c["appearance_prompt"],
            description=c["role"],
            meta={"seed": True},
        )
        db.add(ch)
        chars[c["name"]] = ch

    bgs = {}
    for name, prompt in [
        ("街角咖啡厅", "暖色原木咖啡厅内景，晨光透过落地窗洒在吧台，蒸汽与浮尘逆光，治愈系日杂风"),
        ("城市街道", "梧桐树影斑驳的城市街道外景，午后柔光，行人虚化，浅景深电影感"),
        ("咖啡厅门口", "咖啡厅临街门口，风铃与木质招牌，清晨薄光，生活流氛围"),
    ]:
        b = SceneBackground(project_id=project.id, name=name, prompt=prompt,
                            description="示例场景", meta={"seed": True})
        db.add(b)
        bgs[name] = b

    props = {}
    for name, prompt in [
        ("牛皮纸剧本文件袋", "牛皮纸文件袋特写，边缘磨损，封面手写片名《心动预告》，电影质感道具"),
        ("旧笔记本电脑", "贴满剧组和影展贴纸的旧笔记本电脑，键帽磨亮，编剧工作台道具"),
    ]:
        p = Prop(project_id=project.id, name=name, prompt=prompt,
                 description="示例道具", meta={"seed": True})
        db.add(p)
        props[name] = p
    await db.flush()

    # ---- 剧本（标记已解析，前端直接展示解析结果）----
    script = Script(
        project_id=project.id,
        title=f"{src['title']}·第1集",
        content=src["content"],
        parsed_data={"confirmed": True, "seed": True},
    )
    db.add(script)
    await db.flush()

    episode = Episode(
        project_id=project.id, script_id=script.id,
        number=1, title="第1集", status="asset", sort_order=1,
    )
    db.add(episode)
    await db.flush()

    # ---- 8 个分镜：提示词 = @场景 @角色 + 画面描述（与解析确认后的格式一致）----
    shots = [
        (1, "街角咖啡厅", ["林晚星", "苏小柔"], "近景，晨光透过落地窗，林晚星抱着笔记本电脑揉眉心，桌上凉掉的拿铁冒着最后一缕热气", 5, "close_up", "static", "疲惫温暖"),
        (2, "街角咖啡厅", ["林晚星"], "特写，屏幕上是刚被拒掉的剧本大纲，林晚星把凉咖啡一饮而尽，眼神倔强", 4, "close_up", "push_in", "坚毅"),
        (3, "咖啡厅门口", ["顾言深"], "中景，顾言深收伞推门而入，风铃晃动，他目光扫过店内停在前方", 4, "medium", "static", "悬念"),
        (4, "街角咖啡厅", ["林晚星", "顾言深"], "过肩镜头，顾言深在林晚星对面坐下，两人对视，空气凝固", 5, "over_shoulder", "static", "张力"),
        (5, "街角咖啡厅", ["顾言深"], "特写，一份封面写着《心动预告》的文件推到桌面，林晚星瞳孔微缩", 4, "close_up", "push_in", "震动"),
        (6, "街角咖啡厅", ["林晚星"], "中景，林晚星合上电脑起身离开，顾言深望着她的背影欲言又止", 5, "medium", "pan", "遗憾克制"),
        (7, "城市街道", ["林晚星"], "远景跟拍，林晚星快步走在梧桐树影里，眼眶泛红却不落泪", 6, "wide", "tracking", "酸楚"),
        (8, "城市街道", [], "空镜，梧桐叶随风飘落，阳光穿过树叶洒在斑驳路面，故事留白", 4, "wide", "drift", "余韵"),
    ]
    for seq, bg_name, char_names, desc, dur, angle, movement, mood in shots:
        sc = Scene(
            script_id=script.id, episode_id=episode.id,
            sequence=seq, scene_type="normal",
            prompt=" ".join([f"@{bg_name}"] + [f"@{n}" for n in char_names] + [desc]),
            duration=float(dur),
            camera_angle=angle, camera_movement=movement, mood=mood,
            shot_type="对话场景" if len(char_names) >= 2 else "情绪场景",
            status="ready", meta={"seed": True},
        )
        db.add(sc)
        await db.flush()
        # 分镜-资源引用（与解析确认后 Agent 自动挂载的行为一致）
        db.add(SceneAsset(scene_id=sc.id, resource_type="scene_bg",
                          resource_id=bgs[bg_name].id, usage_context="场景"))
        for n in char_names:
            db.add(SceneAsset(scene_id=sc.id, resource_type="character",
                              resource_id=chars[n].id, usage_context="出镜"))

    logger.info("模板库：已种子官方示例项目《咖啡厅的心动预告》")
