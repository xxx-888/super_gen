# 功能复刻与扩展方案：对标巨日禄AI

> 目标：将目标网站（巨日禄 AI，video.jurilu.com）的核心功能借鉴并复刻到本平台（super_gen / SceneGen）。
> 原则：先做框架，AI 模型适配器预留接口（占位结果），后续接入真实 API。
> 推进方式：本方案确认后，按模块逐个实现（每个模块 = 数据模型 + 后端 API + 前端页面 + 后台管理）。

---

## 〇、目标网站功能调研结论（参考基线）

| 模块 | 目标网站关键能力 |
|------|----------------|
| 项目管理 | 项目卡片网格（封面+名称+操作）、搜索/分页/新建/版本 |
| 片段(集)管理 | 按"集(episode/clip)"组织；状态流转 资产→待提交→视频编辑→已完成；每集一键成片、智能审片开关、此步后停止 |
| 创作面板 | 镜头类型 + 创作模式(图生视频/首尾帧/融合) + 生图引擎(星融2.1等) + 元素(角色/场景/物品/姿态/特效) + 提示词框架 + 尺寸/数量 |
| 角色/场景/物品 | 类型(真人/卡通)、状态(已生成/生成中/待生成)、3种生图(本地上传/选择器/AI生成)、批量上传/AI一键批量生成/批量提交 |
| 融合生图/图片改创 | 独立创作工具，产出图片库 |
| 参考视频/参考音频 | 本地上传，作为生成参考 |
| 企业素材库 | 图片/视频/音频三类；团队存储配额；目录树(角色/场景/物品分类文件夹)；素材网格(卡片/表格)；操作:查看/下载/编辑/移动/同步至项目库/删除 |
| 团队管理 | 数据看板(积分趋势/排行) + 积分统计(日期/项目/账号) + 成员管理(积分分配/项目归属/操作日志) + 成员组 + 权限组(查看/编辑/删除/下载) + 企业素材库权限矩阵(查看/上传/下载/编辑/删除/调用，级联) |
| 工作台 | 解说剧一键成片、一键转绘、视频去字幕/转高清/图片编辑 |
| 积分系统 | 积分充值、可用积分显示、按任务消耗积分 |
| 作品展示 | 公开作品画廊 |

---

## 一、本平台现状与缺口

**已具备（可复用）**：用户认证、项目CRUD、剧本+分镜(Scene)、角色/场景/道具/音频CRUD、Tiptap提示词编辑器(@-mention)、后台管理(用户/项目/任务/模型/设置)、Celery任务队列骨架、PostgreSQL+Redis。

**关键缺口**：
1. **团队/组织概念完全缺失** —— 当前是单用户模型(User→Project)，没有 Team/Organization。
2. **积分系统完全缺失** —— 没有 Credit 账户、消耗、充值、配额。
3. **企业素材库** —— 只有项目级资源，没有团队级共享素材库与存储配额。
4. **"集(episode)"层级缺失** —— Scene 直接挂在 Script 下，没有 Episode→Clip 的概念和状态机。
5. **AI 生图/生视频全是 stub** —— 无真实模型适配器。
6. **RBAC 权限细粒度缺失** —— 只有 admin/user 二分，无角色/权限组/资源权限矩阵。
7. **文件上传/视频导出端点缺失**。
8. **无 Alembic 迁移**（dev 靠 create_all）。

---

## 二、总体架构改造

### 2.1 引入"组织/团队"为顶层租户

当前数据模型是 `User 1—N Project`。要支持团队，需引入 **Organization（组织/团队）** 作为多租户边界：

```
Organization(团队) 1——N User(成员, 通过 Membership)
Organization 1——N Project      （项目归属团队）
Organization 1——N TeamMaterial （企业素材库）
Organization 1——N CreditAccount（积分账户）
```

**兼容策略**：每个 User 注册时自动创建一个"个人团队"（personal org），把现有 Project 迁移过去，保证单用户体验不变；之后用户可创建/加入多团队。

### 2.2 模块划分与优先级

| 优先级 | 模块 | 依赖 |
|--------|------|------|
| P0 | 基础设施：Organization/Membership + 迁移 + 文件上传服务 | 无 |
| P0 | 积分系统：CreditAccount/流水/扣费中间件 | Organization |
| P1 | 团队管理（成员/成员组/权限组/数据看板/积分统计） | Organization + Credit |
| P1 | 企业素材库（团队级）+ 存储配额 + 同步至项目库 | Organization + 文件上传 |
| P2 | 片段(集)管理重构：Episode/Clip + 状态机 + 一键成片流水线骨架 | Project |
| P2 | 创作工作流真实化：模型适配器框架 + 融合生图/图生视频/对口型 | Episode/Clip + AIModel + 积分扣费 |
| P3 | 工作台（解说剧一键成片、一键转绘）+ 作品展示 | 创作工作流 |
| P3 | 视频去字幕/转高清/图片编辑（占位） | 创作工作流 |

---

## 三、详细设计：数据模型（新增/修改）

> 命名沿用现有风格：UUID主键、TimestampMixin、JSONB。以下为新增模型，统一加到 `backend/app/models/`（建议拆分多文件，现有单文件保留兼容）。

### 3.1 组织与成员

```python
class Organization(Base, TimestampMixin):
    """组织/团队"""
    __tablename__ = "organizations"
    id = Column(UUID, primary_key=True, default=uuid4)
    name = Column(String(255), nullable=False)
    avatar_url = Column(Text)
    owner_id = Column(UUID, ForeignKey("users.id"), nullable=False)  # 创建者
    is_personal = Column(Boolean, default=False)  # 个人团队(注册自动创建)
    storage_quota_mb = Column(Integer, default=10240)  # 存储配额(MB), 默认10GB
    storage_used_mb = Column(Integer, default=0)
    settings = Column(JSONB, default=dict)
    # relationships: members, projects, materials, credit_account

class Membership(Base, TimestampMixin):
    """成员关系 (User ↔ Organization)"""
    __tablename__ = "memberships"
    id = Column(UUID, primary_key=True, default=uuid4)
    org_id = Column(UUID, ForeignKey("organizations.id"), nullable=False)
    user_id = Column(UUID, ForeignKey("users.id"), nullable=False)
    role = Column(String(20), default="member")  # owner/admin/member
    display_name = Column(String(100))  # 团队内昵称
    is_active = Column(Boolean, default=True)
    __table_args__ = (UniqueConstraint('org_id', 'user_id', name='uq_org_user'),)

class MemberGroup(Base, TimestampMixin):
    """成员组"""
    __tablename__ = "member_groups"
    id, org_id, name, leader_id(user), description

class MemberGroupItem(Base):
    """成员组-成员关联"""
    group_id, user_id   # 多对多

class PermissionGroup(Base, TimestampMixin):
    """权限组 (角色模板)"""
    __tablename__ = "permission_groups"
    id, org_id, name, description,
    permissions = Column(JSONB)  # {view:bool, edit:bool, delete:bool, download:bool, ...}
```

### 3.2 积分系统

```python
class CreditAccount(Base, TimestampMixin):
    """积分账户（每个团队一个）"""
    __tablename__ = "credit_accounts"
    id = Column(UUID, primary_key=True, default=uuid4)
    org_id = Column(UUID, ForeignKey("organizations.id"), nullable=False, unique=True)
    balance = Column(Integer, default=0)          # 团队可用总积分
    allocated = Column(Integer, default=0)        # 已分配给成员的积分
    total_recharged = Column(Integer, default=0)  # 累计充值
    total_consumed = Column(Integer, default=0)   # 累计消耗

class CreditAllocation(Base, TimestampMixin):
    """成员积分配额 (团队给成员分配的额度)"""
    __tablename__ = "credit_allocations"
    id, org_id, user_id, quota(分配额度), used(已用)

class CreditTransaction(Base, TimestampMixin):
    """积分流水（充值/分配/消耗/退还）"""
    __tablename__ = "credit_transactions"
    id = Column(UUID, primary_key=True, default=uuid4)
    org_id = Column(UUID, ForeignKey("organizations.id"), nullable=False)
    user_id = Column(UUID, ForeignKey("users.id"))       # 经手人
    project_id = Column(UUID, ForeignKey("projects.id")) # 关联项目(可空)
    task_id = Column(UUID, ForeignKey("generation_tasks.id"))
    type = Column(String(20))  # recharge/allocate/consume/refund/adjust
    amount = Column(Integer)    # 正=增加, 负=扣减
    balance_after = Column(Integer)
    model = Column(String(50))  # 消耗时记录模型
    meta = Column(JSONB, default=dict)  # 备注、充值订单号等
```

### 3.3 企业素材库（团队级）

```python
class TeamMaterial(Base, TimestampMixin):
    """团队素材（图片/视频/音频）"""
    __tablename__ = "team_materials"
    id = Column(UUID, primary_key=True, default=uuid4)
    org_id = Column(UUID, ForeignKey("organizations.id"), nullable=False)
    category = Column(String(20))   # image/video/audio
    # 目录分类: 角色/场景/物品（仅 image），video/audio 可用 folder
    class_type = Column(String(20)) # character/scene/prop (图片分类)
    folder_id = Column(UUID, ForeignKey("team_folders.id"))
    name = Column(String(255))
    url = Column(Text, nullable=False)
    thumbnail_url = Column(Text)
    size_bytes = Column(Integer)
    mime_type = Column(String(100))
    duration = Column(Float)        # 音视频时长
    meta = Column(JSONB, default=dict)  # 关联角色名、宽高、朝向等

class TeamFolder(Base, TimestampMixin):
    """素材目录树"""
    __tablename__ = "team_folders"
    id = Column(UUID, primary_key=True, default=uuid4)
    org_id = Column(UUID, ForeignKey("organizations.id"), nullable=False)
    class_type = Column(String(20))  # character/scene/prop
    name = Column(String(255))
    parent_id = Column(UUID, ForeignKey("team_folders.id"))  # 支持嵌套
    item_count = Column(Integer, default=0)

class TeamMaterialPermission(Base):
    """成员对团队素材库的权限矩阵"""
    org_id, user_id,
    can_view, can_upload, can_download, can_edit, can_delete, can_invoke(调用)
    # 级联规则在业务层: delete→edit+view, upload/download/edit→view

class MaterialSyncLog(Base, TimestampMixin):
    """企业素材 → 项目库 同步记录"""
    id, org_id, material_id, project_id, target_type(character/scene_bg/prop), target_id
```

### 3.4 片段(集)管理重构

目标网站是 **集(Episode) → 片段(Clip/Scene) → 素材(Material)** 三层。本平台现在是 **Script → Scene** 两层。重构方案：

```python
class Episode(Base, TimestampMixin):
    """集（剧集的一集，如"第56集"）— 新增层级"""
    __tablename__ = "episodes"
    id = Column(UUID, primary_key=True, default=uuid4)
    project_id = Column(UUID, ForeignKey("projects.id"), nullable=False)
    script_id = Column(UUID, ForeignKey("scripts.id"))  # 关联剧本(可空)
    number = Column(Integer, nullable=False)  # 集号
    title = Column(String(255))               # 第56集
    # 状态机: asset(资产待生成) → pending_submit(待提交) → video_editing(视频编辑) → completed
    status = Column(String(30), default="asset")
    stop_after_step = Column(Boolean, default=False)  # 此步后停止
    smart_review = Column(Boolean, default=False)     # 智能审片开关
    cover_image_url = Column(Text)
    sort_order = Column(Integer, default=0)
    meta = Column(JSONB, default=dict)

# 修改现有 Scene：增加 episode_id（Scene 成为"片段/分镜"）
# Scene.episode_id  → Episode   (一个集包含多个分镜片段)
# Scene.status 扩展: pending/asset_ready/pending_submit/generating/completed/failed
# Scene 增加: creation_mode(图生视频/首尾帧/融合), shot_type(对话场景等), video_assets(JSONB)
```

### 3.5 AI 模型适配器框架（核心，预留接口）

```python
# app/adapters/base.py  —— 统一适配器接口（新建包）
class BaseAdapter(ABC):
    @abstractmethod
    async def text_to_image(self, prompt, elements, size, count, **kw) -> List[GenResult]: ...
    @abstractmethod
    async def image_to_video(self, image_url, prompt, **kw) -> GenResult: ...
    @abstractmethod
    async def fusion_generate(self, elements, prompt, **kw) -> List[GenResult]: ...
    @abstractmethod
    async def lip_sync(self, video_url, audio_url) -> GenResult: ...   # 对口型
    @abstractmethod
    async def tts(self, text, voice_id) -> GenResult: ...
    @abstractmethod
    async def test_connection(self) -> bool: ...

# app/adapters/placeholder.py —— 占位实现（先返回 placeholder URL，供联调）
# app/adapters/{cloud_api,comfyui,local}.py —— 预留真实实现骨架

# 适配器工厂：根据 AIModel.provider/type 动态选择
class AdapterFactory:
    @staticmethod
    def get(model: AIModel) -> BaseAdapter: ...
```

GenerationTask 增加 `credits_consumed`、`clip_id`、`episode_id` 字段，便于积分统计。

---

## 四、详细设计：后端 API

> 统一前缀 `/api/v1`。沿用 verify_*_ownership 权限模式，新增 `verify_org_membership`、`verify_credits` 依赖。
> 新增路由模块注册到 `router.py`。

### 4.1 组织/团队 `/organizations`
- `POST /` 创建团队（注册时自动创建 personal org）
- `GET /mine` 我加入的团队列表
- `GET /{org_id}` 团队详情
- `PUT /{org_id}` 更新（owner/admin）
- `POST /{org_id}/switch` 切换当前团队（写入 session/偏好）

### 4.2 团队管理 `/organizations/{org_id}/dashboard`
- **数据看板** `GET /data` —— 近N天积分趋势、项目/片段总数、项目积分排行、人员积分排行
- **积分统计** `GET /credits/stats` —— 按日期/项目/账号维度，分页
- **成员管理** `/members`
  - `GET /` 成员列表（含积分配额、项目归属、状态、创建时间）
  - `POST /invite` 邀请/分配下级账户
  - `PUT /{user_id}` 编辑成员（角色、项目归属）
  - `POST /{user_id}/credits/allocate` 分配积分（+/-）
  - `POST /{user_id}/reset-password`、`POST /{user_id}/disable`、`GET /{user_id}/logs` 操作日志
  - `POST /batch/projects` 批量修改项目归属
- **成员组** `/member-groups` CRUD
- **权限组** `/permission-groups` CRUD
- **素材库权限** `/material-permissions`
  - `GET /` 权限矩阵；`PUT /batch` 批量设置；`PUT /{user_id}` 单成员权限（含级联规则）

### 4.3 积分系统 `/credits`
- `GET /account` 当前团队账户（余额/已分配/累计）
- `POST /recharge` 充值（后台/支付回调，先做后台手动充值）
- `GET /transactions` 流水（筛选 type/项目/成员/日期）
- `POST /allocate` 给成员分配
- `POST /consume` 消耗（内部：任务提交时调用，由 verify_credits 装饰）
- `GET /members/{user_id}` 成员配额详情

### 4.4 企业素材库 `/organizations/{org_id}/materials`
- `GET /?category=&class_type=&folder_id=` 素材列表（卡片/表格）
- `POST /upload` 上传（ multipart，校验配额）
- `GET /{id}`、`PUT /{id}`（编辑）、`DELETE /{id}`
- `POST /{id}/move` 移动到文件夹
- `POST /{id}/sync-to-project` **同步至项目库**（复制为项目级 Character/SceneBackground/Prop）
- `GET /folders/?class_type=` 目录树；`POST /folders`、`PUT /folders/{id}`、`DELETE /folders/{id}`
- `GET /storage` 存储用量；`POST /storage/refresh` 刷新；`PUT /quota` 升级配额（admin）

### 4.5 片段(集)管理 `/projects/{project_id}/episodes`
- `GET /` 集列表（分页，状态聚合）
- `POST /` 新建集；`PUT /{id}`（编辑/状态）；`DELETE /{id}`
- `POST /batch/reorder` 排序
- `POST /{id}/one-click-render` **一键成片**（编排流水线任务）
- `PUT /{id}/smart-review` 切换智能审片；`PUT /{id}/stop-after` 切换此步后停止
- 集内片段(clip)：`GET /episodes/{ep_id}/clips` → 复用现有 Scene，加 `episode_id` 过滤
- 创作面板提交：`POST /clips/{scene_id}/generate`（镜头类型+创作模式+元素+提示词→建任务、扣积分）

### 4.6 创作工作流 `/creation`
- `POST /fusion` 融合生图（元素组合→适配器→任务）
- `POST /image-to-video` 图生视频
- `POST /first-last-frame` 首尾帧生成视频
- `POST /lip-sync` 对口型
- `POST /tts` 配音
- `POST /image-edit` 图片改创
- `POST /video-remove-subtitle`、`/video-enhance`（占位）
- 每个端点：参数校验 → verify_credits → 创建 GenerationTask → 投递 Celery → 返回 task_id
- `GET /tasks/{id}/result` 轮询/WebSocket 获取结果

### 4.7 文件上传 `/upload`
- `POST /image`、`/video`、`/audio`（multipart）→ 存储到本地/OSS → 返回 url、size、mime
- 抽象 `StorageBackend`（LocalFileStorage / OssStorage），配置驱动

### 4.8 工作台 `/workbench`
- `POST /narration-one-click` 解说剧一键成片（剧本→角色场景→生成流水线）
- `POST /video-to-style` 一键转绘
- `GET /my-works` 我的作品

### 4.9 作品展示 `/showcase`
- `GET /public` 公开作品画廊（分页）；`POST /{project_id}/publish` 发布作品

### 4.10 后台管理扩展 `/admin`
现有 admin 基础上增加：
- **积分管理**：团队账户、充值审核、流水、全局积分配置（各模型单价）
- **团队管理**：所有组织、存储配额调整、成员概览
- **存储管理**：全局用量、配额策略、清理
- **素材审核**（可选）

---

## 五、详细设计：前端

### 5.1 路由新增（`App.tsx`）

```
/teams                                  团队选择/列表
/teams/:orgId/dashboard                 数据看板
/teams/:orgId/dashboard/credits         积分统计
/teams/:orgId/members                   成员管理
/teams/:orgId/member-groups             成员组管理
/teams/:orgId/permission-groups         权限组管理
/teams/:orgId/material-permissions      素材库权限
/teams/:orgId/materials                 企业素材库（图片/视频/音频）
/credits                                积分充值/账户
/projects/:projectId/episodes           集管理（替代/增强原 project detail）
/projects/:projectId/episodes/:epId     集详情-创作面板
/workbench                              工作台
/showcase                               作品展示
/admin/credits                          后台-积分管理
/admin/teams                            后台-团队管理
/admin/storage                          后台-存储管理
```

### 5.2 顶部导航改造（`MainLayout.tsx`）
参考目标网站菜单：首页 / 项目管理 / 企业素材库 / 工作台 / 作品展示 / 团队管理 + 右上角【积分充值】【可用积分: N】【团队切换器】【用户名】。

### 5.3 关键页面设计（对标实现）
- **集管理页**：4:3 卡片网格，每卡片显示封面+集号+状态标签+一键成片按钮+智能审片开关+ellipsis菜单(编辑/下载/删除)
- **创作面板**（集内）：左侧创作参数（镜头类型/创作模式/生图引擎/元素选择器/提示词/尺寸/数量）+ 右侧素材成果区（全部/看图片/看视频/对口型/Agent/改视频/看收藏 tab）
- **企业素材库**：左侧目录树（角色/场景/物品 radio + 文件夹列表）+ 右侧素材网格（卡片/表格切换）+ 顶部存储配额条
- **成员管理**：概览卡片(总成员/活跃/剩余积分/已分配) + 表格(成员/项目/+/-积分/状态/操作) + 分配下级账户弹窗
- **权限矩阵**：成员×权限勾选表（查看/上传/下载/编辑/删除/调用），批量设置

### 5.4 状态管理（Zustand）
新增 store：`teamStore`(当前团队/切换)、`creditStore`(余额)、`materialStore`(素材库)。

---

## 六、AI 模型适配器框架（预留）

```
backend/app/adapters/
  __init__.py
  base.py            # 抽象基类 + 数据类 GenResult
  factory.py         # 工厂：AIModel → Adapter
  placeholder.py     # 占位适配器（sleep+placeholder url，联调用）
  cloud_api.py       # 云API适配器骨架（httpx，待填具体厂商）
  comfyui.py         # ComfyUI适配器骨架（复用现有 ComfyUIWorkflow 模型）
  local.py           # 本地模型骨架
```
- 任务层 `tasks/image_gen.py`、`video_gen.py` 改为调用 `AdapterFactory.get(task.model_obj).xxx()`。
- 占位适配器保证整套流程可联调（提交→扣积分→任务排队→返回 placeholder→展示），后续只需替换适配器内部实现。

---

## 七、实施顺序（里程碑）

**M1 — 基础设施 + 积分（P0）**
1. 引入 Organization/Membership，注册自动建 personal org，迁移现有 Project 归属
2. Alembic 初始化 + 首个迁移
3. 文件上传服务 + StorageBackend（本地）
4. CreditAccount/Transaction + 扣费中间件(verify_credits)
5. 后台-积分管理页

**M2 — 团队管理（P1）**
6. 成员/成员组/权限组 CRUD + 权限矩阵（含级联）
7. 数据看板 + 积分统计
8. 前端团队管理全套页面 + 顶部导航改造

**M3 — 企业素材库（P1）**
9. TeamMaterial/Folder + 存储配额
10. 素材 CRUD + 目录树 + 卡片/表格视图 + 同步至项目库
11. 前端企业素材库页面

**M4 — 片段(集)重构（P2）**
12. Episode 模型 + 状态机 + 集管理页(卡片网格/一键成片/智能审片)
13. Scene 增加 episode_id + 创作面板（元素组合/提示词框架/尺寸数量）

**M5 — AI 工作流真实化（P2）**
14. 适配器框架(base/factory/placeholder)
15. 融合生图/图生视频/首尾帧/对口型/TTS 端点 + 任务扣积分
16. 巨日禄Agent 风格的一键成片流水线编排（骨架）

**M6 — 工作台/作品展示（P3）**
17. 解说剧一键成片、一键转绘、去字幕/转高清/图片编辑（占位）
18. 作品画廊

---

## 八、风险与决策点

1. **多租户改造影响面大**：现有所有 Project 查询都需带 org_id 过滤。方案：用 personal-org 兼容，逐步迁移，验证器统一注入 org。
2. **积分扣费的并发安全**：consume 必须用 `SELECT ... FOR UPDATE` 锁账户，防止超扣。
3. **状态机一致性**：一键成片是长链路编排，需任务编排器 + 失败补偿 + 断点续跑（"此步后停止"对应）。
4. **文件存储**：先本地，生产需 OSS（预留 StorageBackend）。
5. **Alembic 必须建立**：当前 create_all 无法做字段变更迁移，是隐患。

---

## 九、待确认（开工前）

- [ ] 团队/组织命名确认（"团队 Team" vs "组织 Organization"，UI 文案用"团队"）
- [ ] 积分充值先做"后台手动充值"还是直接接支付？（建议先后台手动）
- [ ] 现有 Project 是否一次性迁移到 personal org？（建议是）
- [ ] 集管理是否完全替换现有 ProjectDetail+Scene 流程？（建议并存，新流程为主）
