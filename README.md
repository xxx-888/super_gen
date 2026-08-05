# SceneGen · AI 短剧生成平台

> 专业级 AI 短剧生成平台 —— 从剧本导入到成片输出，全流程自动化。
>
> 项目代号：**SceneGen**（场景生成） · 仓库：`super_gen` · 状态：v1.0.0-alpha（基础架构搭建完成，核心模块设计中）

---

## 📋 项目简介

SceneGen 是一个面向内容创作者、短视频制作团队与 MCN 机构的**专业级 AI 短剧生成平台**。它把"剧本 → 分镜 → 资源 → 视频"的完整生产链路收敛到一套现代化的 Web 工具中，并提供多模型兼容、团队协作与积分体系。

### 核心特性

- ✅ **全流程覆盖**：剧本导入 → 智能分镜 → 资源管理 → 视频生成，一站式完成
- ✅ **@引用系统**：创新的提示词编辑器，用 `@角色 / @场景 / @道具 / @音频` 直接引用资源，实时预览展开后的完整提示词
- ✅ **多模型兼容**：支持云端 API（智谱 GLM / CogView / CogVideoX、MiniMax、可灵、Runway 等）+ 本地模型 + ComfyUI 工作流
- ✅ **团队与积分**：多组织（Organization）多租户、成员/权限组、积分账户与按量扣费
- ✅ **批量生产**：一键批量生成分镜视频，并发控制与进度跟踪
- ✅ **后台管理**：完整的用户、项目、任务、模型配置、系统设置管理

---

## 🏗️ 技术架构

### 后端（Python）

| 组件 | 技术 | 说明 |
|------|------|------|
| Web 框架 | FastAPI 0.110+ | 高性能异步框架，自动 OpenAPI 文档 |
| ORM | SQLAlchemy 2.0（async） | 异步数据库操作 |
| 数据库 | PostgreSQL 16 | 关系型数据库 |
| 任务队列 | Celery + Redis | 异步 AI 生成任务（文生图 / 图生视频 / 字幕） |
| 迁移工具 | Alembic | 数据库版本管理 |
| 认证 | JWT（python-jose + passlib） | 无状态认证 + 刷新令牌 |
| 配置 | pydantic-settings | 环境变量驱动的类型安全配置 |

### 前端（React）

| 组件 | 技术 | 说明 |
|------|------|------|
| 框架 | React 18 + TypeScript | 类型安全 |
| 构建工具 | Vite 5 | 极速 HMR |
| UI 组件库 | Arco Design Web React | 现代简洁风格 |
| 状态管理 | Zustand | 轻量级状态管理 |
| 富文本编辑 | Tiptap | 提示词编辑器核心（自定义 Mention 扩展） |
| 路由 | React Router v6 | 声明式路由 |
| HTTP 客户端 | Axios | 请求拦截与封装 |

### 基础设施

| 组件 | 用途 |
|------|------|
| PostgreSQL 16 | 业务数据存储 |
| Redis 7 | 缓存 + Celery Broker/Backend |
| Docker Compose | 本地一键拉起 PG + Redis |

### AI 模型对接

| 类型 | 支持模型 |
|------|---------|
| 剧本解析 / Agent 决策 | 智谱 GLM-4（OpenAI 兼容端点） |
| 文生图 | CogView-3、Stable Diffusion XL、MiniMax、通义万相 |
| 图生视频 | CogVideoX、可灵 (Kling)、Runway Gen-3、Pika、即梦 |
| 语音合成 (TTS) | CosyVoice、ChatTTS、Azure TTS、Edge TTS |
| 字幕识别 (ASR) | Whisper（本地）、讯飞 ASR |
| 工作流 | ComfyUI（自定义工作流） |

> 模型适配器统一抽象在 `backend/app/adapters/`，通过 `factory.py` 按配置实例化，方便接入新厂商。

---

## 📁 项目结构

```
super_gen/
├── backend/                          # Python 后端
│   ├── app/
│   │   ├── main.py                   # FastAPI 应用入口
│   │   ├── core/                     # 配置 / 数据库 / 安全 / 异常
│   │   │   ├── config.py             # 环境变量与配置（pydantic-settings）
│   │   │   ├── database.py           # 异步数据库连接
│   │   │   ├── security.py           # JWT 认证与密码哈希
│   │   │   └── exceptions.py         # 统一异常处理
│   │   ├── models/                   # SQLAlchemy 数据模型
│   │   ├── schemas/                  # Pydantic 请求/响应模型
│   │   ├── api/v1/                   # RESTful API 路由（auth/projects/scenes/tasks/admin …）
│   │   ├── adapters/                 # AI 模型适配器（智谱 / MiniMax / ComfyUI …）
│   │   ├── services/                 # 业务逻辑（剧本解析 / 提示词构建 / 分镜生成 / 视频管道 …）
│   │   └── tasks/                    # Celery 异步任务（文生图 / 图生视频 / 字幕）
│   ├── alembic/                      # 数据库迁移
│   ├── alembic.ini
│   ├── requirements.txt              # Python 依赖清单
│   └── .env.example                  # 环境变量样例（复制为 .env 后填写）
│
├── frontend/                         # React 前端
│   ├── src/
│   │   ├── main.tsx                  # 应用入口
│   │   ├── App.tsx                   # 路由配置
│   │   ├── api/                      # Axios 客户端与服务封装
│   │   ├── stores/                   # Zustand 状态管理
│   │   ├── components/               # 布局 / 提示词编辑器 / Agent 面板 / 素材选择器
│   │   ├── pages/                    # 认证 / 工作台 / 项目 / 剧本 / 分镜 / 资源 / 团队 / 后台
│   │   ├── hooks/                    # 自定义 Hooks
│   │   ├── types/                    # TypeScript 类型定义
│   │   └── utils/                    # 工具函数
│   ├── index.html
│   ├── vite.config.ts                # 含 /api /uploads /ws 开发代理
│   ├── tsconfig.json
│   └── package.json
│
├── docs/                             # 设计文档
│   ├── OVERVIEW.md                   # 项目总览
│   ├── architecture.md               # 系统架构设计
│   └── PLAN_jurilu_features.md       # 功能复刻与扩展方案
│
├── docker-compose.yml                # 本地基础设施（PostgreSQL + Redis）
├── .gitignore
└── README.md
```

---

## ✨ 核心功能模块

### 1. 提示词编辑器（PromptEditor）⭐ 核心

整个平台的**核心交互组件**，基于 Tiptap 富文本编辑器实现创新的 @ 引用系统：

- 富文本编辑 + 自定义 Mention 节点，支持 `@角色 / @场景 / @道具 / @音频`
- 底部资源面板，点击或搜索即可插入引用
- 实时解析并预览展开后的完整提示词
- Token 数量估算与质量评估
- 撤销 / 重做 / 自动保存

**使用示例：**

```
原始提示词：
  【风格】CN-URBAN-03 | 国产都市生活...  @沈如姬 站立于舞台左侧，@林若薇 站立于舞台右侧

展开后：
  【风格】CN-URBAN-03 | 国产都市生活...  [角色:沈如姬 外观:黑发红唇...] 站立于舞台左侧，
  [角色:林若薇 外观:棕色卷发...] 站立于舞台右侧
```

### 2. 剧本与分镜服务

- **剧本解析**（`script_parser.py` / `script_analyzer.py`）：自动检测纯文本 / Fountain 格式，拆分场景单元，提取角色与对白，估算时长。
- **分镜生成**（`scene_generator.py`）：基于剧本自动生成分镜列表，为每个分镜构建初始提示词并插入 @ 引用占位符。
- **提示词构建**（`prompt_builder.py`）：把 @ 引用展开为模型可读的完整提示词。

### 3. 视频生成管道（`video_pipeline.py`）

- 检查并补充缺失的资源图片
- 批量提交视频生成任务，并发控制与进度跟踪
- 可选的字幕自动添加
- 一键全流程自动化

### 4. 团队 / 积分 / 素材库（M1–M6 迭代）

- **组织（Organization）**：多租户顶层容器，注册即自动创建"个人团队"
- **积分系统（Credit）**：积分账户、按任务类型扣费、联调时可一键关闭扣费
- **企业素材库（TeamMaterial）**：团队级共享素材，存储配额管理
- **集（Episode）**：剧本下的片段/集层级与状态机流转
- **RBAC**：成员组、权限组、企业素材库权限矩阵

### 5. 后台管理系统

用户管理（CRUD、启用/禁用）、项目监控、任务队列监控（实时进度）、模型配置管理（API Key 等）、系统设置、存储使用统计、作品展示（Showcase）。

---

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 |
|------|------|
| Python | 3.11+（推荐 3.12 / 3.14） |
| Node.js | 18+ |
| PostgreSQL | 16 |
| Redis | 7+ |
| Docker（可选） | 用于一键拉起 PG + Redis |

### 1. 启动基础设施（PostgreSQL + Redis）

最简单的方式是用仓库自带的 `docker-compose.yml`：

```bash
docker compose up -d
# 查看状态
docker compose ps
```

> 也可以使用本地已安装的 PostgreSQL 与 Redis，连接信息通过 `.env` 配置。

### 2. 启动后端

```bash
cd backend

# 创建并激活虚拟环境
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env，至少填写：
#   DATABASE_URL / REDIS_URL / SECRET_KEY / LLM_API_KEY（智谱）

# （可选）执行数据库迁移
alembic upgrade head

# 启动开发服务器
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

启动后访问：

- API 文档（Swagger）：http://localhost:8000/docs
- 健康检查：http://localhost:8000/health

> 开发环境下 `DEBUG=True` 时，应用启动会自动 `create_all` 建表，方便快速联调。

### 3. 启动前端

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

访问 http://localhost:5173，开发服务器已配置对 `/api`、`/uploads`、`/ws` 的反向代理，指向 `http://localhost:8000`。

### 4.（可选）启动 Celery Worker（异步生成任务）

```bash
cd backend
source venv/bin/activate
celery -A app.tasks.celery_app worker -l info
```

---

## 🔧 环境变量说明

后端配置在 `backend/.env`（从 `.env.example` 复制），关键项：

| 变量 | 说明 | 默认 / 示例 |
|------|------|------------|
| `DATABASE_URL` | PostgreSQL 异步连接串 | `postgresql+asyncpg://postgres:postgres@localhost:5432/scenegen` |
| `REDIS_URL` | Redis 连接 | `redis://localhost:6379/0` |
| `SECRET_KEY` | JWT 签名密钥（**生产必改**） | `change-me-to-a-random-string` |
| `LLM_PROVIDER` | LLM 厂商 | `zhipu` |
| `LLM_API_KEY` | 智谱 API Key（驱动 GLM/CogView/CogVideoX） | 申请：https://open.bigmodel.cn/ |
| `LLM_BASE_URL` | OpenAI 兼容端点 | `https://open.bigmodel.cn/api/paas/v4` |
| `LLM_MODEL` | 默认模型 | `glm-4-flash` |
| `CREDITS_ENABLED` | 是否启用积分扣费（联调可设 `False`） | `False` |
| `CREDITS_INITIAL_BALANCE` | 个人团队初始积分 | `10000` |

完整配置项见 [`backend/app/core/config.py`](backend/app/core/config.py)。

---

## 📦 构建与部署

### 前端打包

```bash
cd frontend
npm run build      # 产物输出到 frontend/dist/
```

打包产物为纯静态文件，可由 Nginx 或任意静态服务器托管；建议配置反向代理将 `/api`、`/uploads`、`/ws` 转发到后端。

### 后端部署要点

- **生产环境**：`ENVIRONMENT=production`、`DEBUG=False`，关闭 `/docs`、`/redoc`、`/openapi.json`
- **SECRET_KEY**：替换为强随机字符串（≥ 32 字符）
- **数据库**：使用 `alembic upgrade head` 管理表结构，关闭 `create_all`
- **Worker**：Celery Worker 多进程部署，承接图片/视频生成任务
- **存储**：`STORAGE_TYPE` 可切换 `local` / `minio` / `s3` / `oss` / `cos`
- **反向代理**：Nginx + HTTPS，启用 Gzip/Brotli，CDN 加速静态资源

### 前端 + 后端一体化部署（参考）

```
Nginx (443, HTTPS)
  ├── /            → frontend/dist（静态）
  ├── /api         → uvicorn (8000)
  ├── /uploads     → uvicorn (8000) 或 对象存储
  └── /ws          → uvicorn (8000, WebSocket)
```

---

## 🗄️ 数据库与迁移

项目使用 Alembic 管理数据库版本，迁移文件位于 `backend/alembic/versions/`：

```bash
cd backend
source venv/bin/activate

# 应用所有迁移到最新
alembic upgrade head

# 生成新迁移（修改 models 后）
alembic revision --autogenerate -m "描述本次变更"
```

---

## 🔌 API 概览

主要路由前缀为 `/api/v1`，完整接口见运行后的 `/docs`：

| 模块 | 路径 | 说明 |
|------|------|------|
| 认证 | `/auth` | 注册 / 登录 / 刷新 Token / 当前用户 |
| 项目 | `/projects` | 项目 CRUD、成员管理 |
| 剧本 | `/scripts` | 剧本 CRUD、解析 |
| 分镜 | `/scenes` | 分镜 CRUD、提示词更新与预览（**核心**） |
| 资源 | `/resources` | 角色 / 场景 / 道具 / 音频 |
| 任务 | `/tasks` | 图片 / 单视频 / 批量视频 / 一键全流程生成；`WS /ws/tasks/{id}` 实时进度 |
| 创作 | `/creation` | 创作面板（镜头类型 / 创作模式 / 引擎选择） |
| 组织 / 团队 | `/organizations` `/team` | 多租户、成员、权限组、企业素材库 |
| 积分 | `/credits` | 积分账户、消耗、充值 |
| 上传 | `/upload` | 文件 / 图片 / 视频上传 |
| 工作台 | `/workbench` | 一键成片、转绘等快捷工具 |
| 后台管理 | `/admin` | 平台统计、用户、任务、模型配置、系统设置 |

---

## 🛡️ 安全提醒

生产环境部署前务必：

1. 修改 `SECRET_KEY` 为强随机字符串（≥ 32 字符）
2. 修改默认管理员账号 / 密码（`ADMIN_DEFAULT_*`）
3. 配置 HTTPS 与 CORS 白名单
4. 关闭 `DEBUG` 与文档端点
5. 配置数据库备份策略
6. 限制文件上传大小与类型

> ⚠️ **切勿将 `.env`、`config.json`、`backend/uploads/`（运行时上传产物）等包含敏感信息或运行时数据的文件提交到仓库**，它们已在 `.gitignore` 中忽略。

---

## 📑 开发文档

更详细的设计文档位于 [`docs/`](docs/)：

- [`OVERVIEW.md`](docs/OVERVIEW.md) — 项目总览
- [`architecture.md`](docs/architecture.md) — 系统架构设计
- [`PLAN_jurilu_features.md`](docs/PLAN_jurilu_features.md) — 功能复刻与扩展方案

---

## 📝 License

待定（MIT）。

---

> 🎬 让 AI 短剧创作变得简单而强大。
