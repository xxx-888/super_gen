# SceneGen · AI 短剧生成平台

> 专业级 AI 短剧生成平台 —— 从剧本导入到成片输出，全流程自动化。
>
> 项目代号：**SceneGen**（场景生成） · 仓库：`super_gen` · 状态：v1.0.0（核心链路已跑通：剧本解析 → 资源/分镜 → 画布/面板生成 → 一键成片 → 作品画廊）

---

## 📋 项目简介

SceneGen 是一个面向内容创作者、短视频制作团队与 MCN 机构的**专业级 AI 短剧生成平台**。它把"剧本 → 分镜 → 资源 → 生成 → 成片 → 发布"的完整生产链路收敛到一套现代化的 Web 工具中，并提供多模型兼容、团队协作与积分体系。

### 核心特性

- ✅ **全流程覆盖**：剧本导入 → AI 智能解析（角色/场景/道具/分镜）→ 资源管理 → 画布/面板生成 → 一键成片 → 作品画廊发布
- ✅ **@引用系统**：创新的提示词编辑器，用 `@角色 / @场景 / @道具 / @音频 / @视频` 直接引用资源；发送给模型的提示词**原文直发**，用户编辑的是什么就发什么
- ✅ **多模态参考生成（r2va）**：MiniMax-H3 官方渠道支持参考图片（≤9）+ 参考视频（≤3）+ 参考音频（≤3）混合驱动视频生成
- ✅ **画布节点编排**：React Flow 节点画布，拖拽组合 提示词/生成/上传/首尾帧/输出 节点，连线即引用，纯手搓完整视频
- ✅ **一键成片**：集（Episode）维度智能分流合并/生成，分镜成片直接发布画廊
- ✅ **参考素材自动规范化**：上传音视频自动截取（单段 ≤15s）并转码为渠道合规格式（音频 MP3 / 视频 H.264+AAC MP4）；生成时对超限素材兜底截取
- ✅ **多模型兼容**：智谱 GLM/CogView/CogVideoX、MiniMax H3（官方 / 优云智算 CompShare / 自部署 Ref2VA）+ ComfyUI 工作流预留
- ✅ **团队与积分**：多组织（Organization）多租户、成员/权限组、企业素材库、积分账户与按量扣费
- ✅ **作品画廊**：成片发布、公开/私有、点赞、我的作品管理
- ✅ **后台管理**：用户、项目、任务队列、模型配置、提示词模板、计价、积分、系统设置，以及**统一媒体资源管理**（生成任务输出 / 素材库 / 项目资产 / 画布节点媒体，集中搜索/禁用/删除/重命名）

---

## 🏗️ 技术架构

### 后端（Python）

| 组件 | 技术 | 说明 |
|------|------|------|
| Web 框架 | FastAPI 0.110+ | 高性能异步框架，自动 OpenAPI 文档 |
| ORM | SQLAlchemy 2.0（async） | 异步数据库操作 |
| 数据库 | PostgreSQL 16（JSONB/ARRAY） | 关系型数据 + 画布图/任务元数据 |
| 任务队列 | Celery + Redis（预留） | 当前生成任务以后台协程 + 轮询追踪为主 |
| 迁移工具 | Alembic（开发环境 `create_all` 自动建表） | 数据库版本管理 |
| 认证 | JWT（access + refresh） | 无状态认证 |
| 配置 | pydantic-settings | 环境变量驱动的类型安全配置 |
| 媒体处理 | imageio-ffmpeg（随 pip 依赖自动安装） | 参考素材探测/截取/转码、封面抽帧、成片合成 |

### 前端（React）

| 组件 | 技术 | 说明 |
|------|------|------|
| 框架 | React 18 + TypeScript | 类型安全 |
| 构建工具 | Vite 5 | 极速 HMR |
| UI 组件库 | Arco Design Web React | 现代简洁风格 |
| 状态管理 | Zustand | 轻量级状态管理 |
| 富文本编辑 | Tiptap | 提示词编辑器核心（自定义 Mention 扩展 + `[类型:名]` 芯片） |
| 画布 | @xyflow/react（React Flow 12） | 节点画布编排 |
| 路由 | React Router v6 | 声明式路由 |
| HTTP 客户端 | Axios | 请求拦截 / Token 刷新 / 统一错误提示 |

### 基础设施

| 组件 | 用途 |
|------|------|
| PostgreSQL 16 | 业务数据存储（`docker-compose.yml` 一键拉起） |
| Redis 7 | 缓存 + Celery Broker/Backend |
| 独立文件服务器（`fileserver/`，可选） | 视频/音频转传拿公网直链，供生成渠道下载参考素材 |
| 自部署 GPU 推理（`h3-deploy/`，可选） | 单卡跑 MiniMax-H3 Ref2VA 多图参考生视频，对外 HTTP API |

### AI 模型对接

| 能力 | 支持模型 | 说明 |
|------|---------|------|
| 剧本解析 / Agent 决策 | 智谱 GLM-4 系列（OpenAI 兼容端点） | 拆分镜、提角色/场景/道具、生成完整提示词 |
| 文生图 / 角色人设 | 智谱 CogView、glm-image | 角色四视图模板（16:9 正/侧/背人设图） |
| 图生视频 / 文生视频 | **MiniMax-H3 官方 V2**、优云智算 CompShare、自部署 Ref2VA、智谱 CogVideoX | i2va / t2va / r2va（多模态参考） |
| 参考视频/音频 | MiniMax-H3 官方（r2va） | 视频 MP4/MOV ≤50MB、音频 WAV/MP3 ≤15MB，单段 [2,15]s，自动截取/转码 |
| 语音合成 (TTS) / ASR | 预留（CosyVoice / Whisper 等） | 适配器接口已就绪 |

> 模型适配器统一抽象在 `backend/app/adapters/`，通过 `factory.py` 按后台「配置模型」或环境变量实例化，方便接入新厂商。MiniMax 官方 / CompShare 渠道协议一致，子类仅覆盖差异（分辨率档位、水印、参考能力开关）。

---

## 📁 项目结构

```
super_gen/
├── backend/                          # Python 后端
│   ├── app/
│   │   ├── main.py                   # FastAPI 应用入口（含 /uploads 静态挂载与禁用媒体拦截）
│   │   ├── core/                     # 配置 / 数据库 / 安全 / 异常 / 媒体禁用拦截(media_guard)
│   │   ├── models/                   # SQLAlchemy 数据模型（画布/集/积分/素材/作品/媒体状态…）
│   ├── schemas/                      # Pydantic 请求/响应模型
│   │   ├── api/v1/                   # RESTful 路由（auth/projects/scripts/scenes/episodes/
│   │   │                             #   resources/materials/canvas/creation/tasks/credits/admin…）
│   │   ├── adapters/                 # AI 模型适配器（智谱 / MiniMax 官方 / CompShare / ref2va…）
│   │   ├── services/                 # 业务逻辑（剧本解析 / 提示词构建 / 一键成片管道 /
│   │   │                             #   文件服务器转传 / 上传规范化(media_prep) / 素材库…）
│   │   └── tasks/                    # Celery 异步任务（预留）
│   ├── alembic/                      # 数据库迁移
│   ├── requirements.txt
│   └── .env.example                  # 环境变量样例（复制为 .env 后填写）
│
├── frontend/                         # React 前端
│   └── src/
│       ├── api/                      # Axios 客户端与服务封装
│       ├── stores/                   # Zustand 状态管理
│       ├── components/
│       │   ├── canvas/nodes/         # 画布节点（提示词/图片视频生成/上传素材/首尾帧/输出…）
│       │   ├── editor/               # 提示词编辑器（Tiptap @引用 + 预览面板 + 资源面板）
│       │   └── material/             # 企业素材选择器（选素材/新建并同步项目资源）
│       └── pages/                    # 工作台/画布/项目/剧本/集/资源/素材库/画廊/团队/后台
│
├── fileserver/                       # 独立文件服务器（可选部署，FastAPI + Bearer 鉴权）
├── h3-deploy/                        # MiniMax-H3 Ref2VA 自部署 GPU 服务（可选，见 h3-deploy/deploy.md）
├── docs/                             # 设计文档（OVERVIEW / architecture / 方案）
├── docker-compose.yml                # 本地基础设施（PostgreSQL 16 + Redis 7）
├── .gitignore
└── README.md
```

---

## ✨ 核心功能模块

### 1. 提示词编辑器（PromptEditor）⭐ 核心

基于 Tiptap 富文本编辑器的 @ 引用系统：

- `@角色 / @场景 / @道具 / @音频 / @视频` 芯片引用，底部资源面板点击/搜索插入
- 实时预览展开后的完整提示词（芯片 → `[角色:名]` 简洁标签，细节由参考图承载）
- 引用的图片/音频/视频自动作为参考素材（reference_image / reference_video / reference_audio）随请求发送
- **提示词原文直发**：适配器不注入任何自动绑定语，所见即所发

### 2. 剧本 → 分镜 → 集

- **AI 剧本解析**（`script_analyzer.py`）：LLM 拆分镜（时长/运镜/景别/台词/完整提示词），提取角色（含外貌描述）、场景、道具；解析结果人工确认后入库，资源自动关联来源剧本
- **角色生图**：四视图人设图模板（16:9 大半身 + 正/侧/背全身，同一人物一致性约束）
- **集（Episode）**：剧本下按集管理分镜，状态机流转，一键成片智能分流（合并/生成缺项 → 合成 → 发布）

### 3. 画布节点编排（Canvas）

- React Flow 画布：提示词节点、文生图/图生图/图生视频/文生视频/首尾帧/转绘/对口型/TTS 等生成节点、上传素材节点、输出节点
- **连线即引用**：上游节点输出自动作为下游输入（图→视频首帧、音频→参考等）
- 生成图一键存企业素材库；上传素材节点支持图片/音频/视频并可同步为项目资源

### 4. 多模态参考生成（MiniMax H3 r2va）

- 分镜/画布/创作面板的 @引用 → 自动组包为官方 V2 `content` 数组（text + reference_image/video/audio）
- **上传即规范化**（`media_prep.py`）：音视频上传入库/转传云端前自动截取前 15s 并转码 MP3/MP4，格式/大小/时长全部预校验
- **生成时兜底**（`minimax_adapter.py`）：公网 URL 与本地文件均探测时长，超限自动 ffmpeg 截取；格式不符自动转码；不合规且无法处理的跳过并写入任务日志，避免整单被拒
- data URI 按官方格式名词声明（`audio/mp3` / `video/mov`），多条参考按 15s÷条数分配时长预算

### 5. 团队 / 积分 / 素材库 / 画廊

- **组织（Organization）**：多租户顶层容器，注册即自动创建"个人团队"
- **积分系统**：积分账户、按任务类型/模型计价扣费、失败自动退款、充值与流水
- **企业素材库**：团队级共享素材（图片分类 character/scene/prop + 音视频），存储配额、目录、权限矩阵
- **作品画廊（Showcase）**：成片发布、公开/私有、点赞、浏览、我的作品管理

### 6. 后台管理系统

- 用户管理（CRUD、启停、重置密码）、项目监控、任务队列（实时进度/取消/重试）
- 模型配置（provider/endpoint/API Key/参数）、提示词模板（剧本解析等 system prompt 可视化编辑）
- 计价配置、积分管理（账户/充值/流水）、系统设置（含文件服务器配置与连通性测试）
- **媒体资源管理**：统一媒体库聚合 生成任务输出 / 素材库上传 / 项目音视频资产 / 角色·场景·道具主图 / 画布节点媒体 五类来源，按 URL 去重；支持关键词搜索（文件名/提示词/项目/用户）、类型与状态筛选、重命名、禁用（本地文件即刻 403 拦截）、删除（删底层文件 + 跨来源清理引用，含画布 JSON 递归摘除）

---

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 |
|------|------|
| Python | 3.11+（推荐 3.12+） |
| Node.js | 18+ |
| Docker | 用于一键拉起 PostgreSQL + Redis |

> ffmpeg 无需单独安装——后端依赖 `imageio-ffmpeg` 会自带可执行文件（参考素材截取/转码、封面抽帧、成片合成均用它）。

### 1. 启动基础设施（PostgreSQL + Redis）

```bash
docker compose up -d
docker compose ps   # 确认 scenegen-postgres / scenegen-redis 为 healthy
```

### 2. 启动后端

```bash
cd backend
python -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env                # 编辑 .env：至少填 LLM_API_KEY；SECRET_KEY 生产必改

uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

启动后访问：

- API 文档（Swagger）：http://localhost:8000/docs
- 健康检查：http://localhost:8000/health

> 开发环境启动时自动 `create_all` 建表；默认管理员 `ADMIN_DEFAULT_EMAIL / ADMIN_DEFAULT_PASSWORD`（首启后务必改密）。

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev                          # http://localhost:5173
```

开发服务器已配置 `/api`、`/uploads`、`/ws` 反向代理指向 `http://localhost:8000`。

### 4.（可选）配置模型渠道

后台「配置模型」添加启用模型：

| 渠道 | provider | endpoint | 说明 |
|------|----------|----------|------|
| MiniMax 官方 | `minimax` | `https://api.minimaxi.com` | 支持 r2va 参考图/视频/音频，data URI 内嵌本地素材 |
| 优云智算 CompShare | `minimax_compshare` | `https://cp.compshare.cn/minimax` | 协议同官方；仅 768P、无水印；2026-08-24 实测已支持音视频参考（URL/data URI） |
| 智谱 | `zhipu` | — | glm-image / cogview 文生图、CogVideoX 视频 |

### 5.（可选）部署独立文件服务器

音视频素材需要被生成渠道公网下载时部署 `fileserver/`（见其目录内说明）：后台上传的视频/音频会自动转传拿公网直链，未部署则本地存储 + base64 内嵌。

---

## 🔧 环境变量说明

后端配置在 `backend/.env`（从 `.env.example` 复制），关键项：

| 变量 | 说明 | 默认 / 示例 |
|------|------|------------|
| `DATABASE_URL` | PostgreSQL 异步连接串 | `postgresql+asyncpg://postgres:postgres@localhost:5432/scenegen` |
| `REDIS_URL` | Redis 连接 | `redis://localhost:6379/0` |
| `SECRET_KEY` | JWT 签名密钥（**生产必改**，≥32 字符） | 占位串 |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 智谱 LLM（剧本解析） | `zhipu` / 申请：https://open.bigmodel.cn/ / `glm-4-flash` |
| `CREDITS_ENABLED` | 积分扣费开关（联调可 `False`） | `True` |
| `CREDITS_INITIAL_BALANCE` | 个人团队初始积分 | `1000` |
| `FILE_SERVER_URL` / `FILE_SERVER_API_KEY` | 独立文件服务器（后台系统设置可覆盖） | 空 = 不转传 |
| `ADMIN_DEFAULT_EMAIL` / `ADMIN_DEFAULT_PASSWORD` | 首启默认管理员 | `admin@scenegen.com` |

完整配置项见 [`backend/app/core/config.py`](backend/app/core/config.py)。

---

## 📦 构建与部署

> **生产部署完整指南**（Ubuntu 单机实测：PostgreSQL/Redis、systemd、Nginx+HTTPS、
> 文件服务器、备案/证书续期常见问题）：见 [`deploy/README.md`](deploy/README.md)，
> 配套模板 `deploy/nginx-scenegen.conf.template`、`deploy/sg-backend.service.template`、
> `backend/.env.production.example`。

### 前端打包

```bash
cd frontend
npm run build      # tsc 类型检查 + vite 打包，产物在 frontend/dist/
```

产物为纯静态文件，由 Nginx 或任意静态服务器托管；`/api`、`/uploads`、`/ws` 反代到后端。

### 后端部署要点

- **生产环境**：`ENVIRONMENT=production`、`DEBUG=False`，关闭文档端点
- **SECRET_KEY** 与默认管理员密码必改；CORS 白名单收紧到实际域名
- **数据库**：`alembic upgrade head` 管理表结构（开发环境才会 `create_all`）
- **更新部署**：`git pull` → `pip install -r requirements.txt`（有新依赖时）→ 重启 uvicorn；前端重新 `npm run build`
- **反向代理**：Nginx + HTTPS，启用 Gzip；静态与上传目录建议 CDN

```
Nginx (443, HTTPS)
  ├── /            → frontend/dist（静态）
  ├── /api         → uvicorn (8000)
  ├── /uploads     → uvicorn (8000)（含禁用媒体 403 拦截）或对象存储
  └── /ws          → uvicorn (8000, WebSocket)
```

---

## 🗄️ 数据库与迁移

```bash
cd backend
alembic upgrade head                                # 应用迁移
alembic revision --autogenerate -m "描述本次变更"    # 修改 models 后生成
```

---

## 🔌 API 概览

主要路由前缀 `/api/v1`，完整接口见运行后的 `/docs`：

| 模块 | 路径 | 说明 |
|------|------|------|
| 认证 | `/auth` | 注册 / 登录 / 刷新 Token / 站点配置 |
| 项目 | `/projects` | 项目 CRUD、成员管理 |
| 剧本 | `/scripts` | 剧本 CRUD、AI 解析、解析确认入库 |
| 分镜 | `/scenes` | 分镜 CRUD、提示词预览、生成 |
| 集 | `/episodes` | 集管理、向导式一键成片 |
| 资源 | `/resources` | 角色（四视图生图）/ 场景 / 道具 / 音频 / 视频资产 |
| 素材库 | `/materials` | 企业素材、目录、配额、同步 |
| 画布 | `/projects/{id}/canvas` | 画布 CRUD、图数据保存 |
| 创作 | `/creation` | 创作面板 / 分镜生成（多模态参考组包） |
| 任务 | `/tasks` | 生成任务、批量、取消/重试、`WS /ws/tasks/{id}` 进度 |
| 积分 | `/credits` | 账户、扣费、充值、流水、计价 |
| 画廊 | `/works` | 发布、点赞、我的作品 |
| 上传 | `/upload` | 图片/视频/音频上传（自动规范化 + 转传文件服务器） |
| 后台管理 | `/admin` | 统计、用户、项目、任务、模型、模板、计价、积分、设置、**媒体资源管理** |

---

## 🛡️ 安全提醒

生产环境部署前务必：

1. 修改 `SECRET_KEY` 为强随机字符串（≥ 32 字符）
2. 修改默认管理员账号 / 密码（`ADMIN_DEFAULT_*`）
3. 配置 HTTPS 与 CORS 白名单
4. 关闭 `DEBUG` 与文档端点
5. 配置数据库备份策略
6. 文件服务器 API Key 与后端 `.env` 均勿入库（已在 `.gitignore` 忽略）

---

## 📑 开发文档

更详细的设计文档位于 [`docs/`](docs/)：

- [`OVERVIEW.md`](docs/OVERVIEW.md) — 项目总览
- [`architecture.md`](docs/architecture.md) — 系统架构设计
- [`PLAN_jurilu_features.md`](docs/PLAN_jurilu_features.md) — 功能复刻与扩展方案
- [`h3-deploy/deploy.md`](h3-deploy/deploy.md) — MiniMax-H3 Ref2VA 自部署 GPU 服务指南

> 工作日报（`docs/日报_*.md`）为私有记录，不纳入版本库。

---

## 📝 License

待定（MIT）。

---

> 🎬 让 AI 短剧创作变得简单而强大。
