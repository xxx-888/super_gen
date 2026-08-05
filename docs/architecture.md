# AI短剧生成平台 - 系统架构设计文档

> **项目代号**: SceneGen (场景生成)
> **版本**: v1.0
> **日期**: 2026-07-30
> **状态**: 设计阶段

---

## 📋 项目概述

### 产品定位
一个**专业级的AI短剧生成平台**，支持从剧本导入到视频产出的全流程自动化。面向内容创作者、短视频制作团队、MCN机构等用户群体。

### 核心价值主张
- **全流程覆盖**: 剧本 → 分镜 → 资源 → 视频，一站式完成
- **多模型兼容**: 支持云端API + 本地模型 + ComfyUI工作流
- **专业编辑器**: 类似IDE的提示词编辑体验，@引用资源
- **批量生产**: 一键批量生成分镜视频，效率提升10倍+

---

## 🏗️ 系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        客户端层 (Frontend)                       │
│  ┌───────────┬───────────┬───────────┬───────────┬───────────┐  │
│  │ 剧本编辑器 │ 分镜编辑器 │ 资源管理器 │ 视频预览  │ 后台管理  │  │
│  └─────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┘  │
│        │           │           │           │           │         │
│  └─────────────────┴───────────┴───────────┴───────────┘         │
│                         React + TypeScript                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP / WebSocket
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API网关层 (Backend)                        │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │              FastAPI + WebSocket (实时通信)                  │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────┘
                               ���
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   业务逻辑层     │  │   任务调度层     │  │   模型适配层    │
│                 │  │                 │  │                 │
│ • 剧本服务      │  │ • Celery Worker  │  │ • SD/SDXL       │
│ • 分镜服务      │  │ • Redis Queue    │  │ • Sora/Runway   │
│ • 资源服务      │  │ • 任务优先级     │  │ • 可灵/即梦     │
│ • 用户服务      │  │ • 进度推送       │  │ • ComfyUI       │
│ • 项目服务      │  │ • 失败重试       │  │ • 本地Ogg/Diff  │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   数据存储层     │  │   文件存储层     │  │   缓存层         │
│                 │  │                 │  │                 │
│ • PostgreSQL    │  │ • 本地存储      │  │ • Redis          │
│ • SQLAlchemy    │  │ • MinIO/S3      │  │ • 会话缓存       │
│ • Alembic迁移   │  │ • OSS/COS       │  │ • 任务队列       │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## 🛠️ 技术选型

### 后端技术栈

| 组件 | 技术方案 | 说明 |
|------|---------|------|
| **Web框架** | FastAPI 0.115+ | 高性能异步框架，自动OpenAPI文档 |
| **任务队列** | Celery + Redis | 异步任务处理（图片/视频生成） |
| **ORM** | SQLAlchemy 2.0 | 异步支持，类型安全 |
| **数据库** | PostgreSQL 16 | 关系型数据，JSONB支持 |
| **文件存储** | MinIO (S3兼容) | 对象存储，可替换为云服务 |
| **认证** | JWT + OAuth2 | 无状态认证，支持刷新令牌 |
| **实时通信** | WebSocket | 任务进度、协作编辑 |

### 前端技术栈

| 组件 | 技术方案 | 说明 |
|------|---------|------|
| **框架** | React 18 + TypeScript | 类型安全，生态成熟 |
| **构建工具** | Vite 6 | 极速HMR，原生ESM |
| **UI组件库** | Arco Design | 字节出品，现代简洁风格 |
| **状态管理** | Zustand | 轻量级，适合中大型应用 |
| **富文本编辑** | Slate.js / Tiptap | 提示词编辑器的核心 |
| **路由** | React Router v7 | 声明式路由 |
| **HTTP客户端** | Axios | 拦截器、取消请求 |
| **图表** | ECharts / Recharts | 数据可视化 |

### AI模型对接

| 类型 | 支持模型 | 用途 |
|------|---------|------|
| **文生图** | Stable Diffusion XL, Midjourney API, DALL-E 3, 通义万相 | 角色/场景/道具图片 |
| **图生视频** | Sora, Runway Gen-3, Pika, 可灵(Kling), 即梦, ComfyUI AnimateDiff | 分镜视频生成 |
| **语音合成** | CosyVoice, ChatTTS, Azure TTS, Edge TTS | 配音/旁白 |
| **字幕识别** | Whisper (本地), 讯飞ASR | 自动字幕 |
| **本地推理** | Ollama, LocalAI, ComfyUI | 隐私/成本敏感场景 |

---

## 📦 模块设计

### 核心模块划分

```
src/
├── backend/
│   ├── app/
│   │   ├── api/                    # API路由
│   │   │   ├── v1/
│   │   │   │   ├── auth.py         # 认证接口
│   │   │   │   ├── users.py        # 用户管理
│   │   │   │   ├── projects.py     # 项目管理
│   │   │   │   ├── scripts.py      # 剧本管理
│   │   │   │   ├── scenes.py       # 分镜管理
│   │   │   │   ├── resources.py    # 资源管理(角色/场景/道具)
│   │   │   │   ├── assets.py       # 文件资产
│   │   │   │   ├── tasks.py        # 任务管理
│   │   │   │   ├── videos.py       # 视频管理
│   │   │   │   └── admin.py        # 后台管理
│   │   │   └── deps.py             # 依赖注入
│   │   ├── core/                   # 核心配置
│   │   │   ├── config.py           # 配置管理
│   │   │   ├── security.py         # 安全/JWT
│   │   │   └── exceptions.py       # 异常处理
│   │   ├── models/                 # 数据模型
│   │   │   ├── user.py
│   │   │   ├── project.py
│   │   │   ├── script.py
│   │   │   ├── scene.py
│   │   │   ├── resource.py
│   │   │   └── task.py
│   │   ├── services/               # 业务逻辑
│   │   │   ├── script_parser.py    # 剧本解析器
│   │   │   ├── scene_generator.py  # 分镜生成器
│   │   │   ├── prompt_builder.py   # 提示词构建器
│   │   │   └── video_pipeline.py   # 视频生成管道
│   │   ├── adapters/               # 模型适配器
│   │   │   ├── base.py             # 适配器基类
│   │   │   ├── stable_diffusion.py
│   │   │   ├── runway.py
│   │   │   ├── kling.py
│   │   │   ├── comfyui.py
│   │   │   └── local_model.py
│   │   ├── tasks/                  # Celery任务
│   │   │   ├── image_gen.py        # 图片生成任务
│   │   │   ├── video_gen.py        # 视频生成任务
│   │   │   ├── audio_gen.py        # 音频生成任务
│   │   │   └── subtitle.py         # 字幕处理任务
│   │   └── utils/                  # 工具函数
│   │       ├── file_utils.py
│   │       └── prompt_parser.py    # 提示词解析(@引用)
│   ├── tests/                      # 测试
│   ├── alembic/                    # 数据库迁移
│   └── requirements.txt
│
├── frontend/
│   ├── src/
│   │   ├── pages/                  # 页面组件
│   │   │   ├── auth/               # 登录/注册
│   │   │   ├── dashboard/          # 工作台
│   │   │   ├── project/            # 项目详情
│   │   │   ├── script/             # 剧本编辑
│   │   │   ├── scene/              # 分镜编辑
│   │   │   ├── resource/           # 资源管理
│   │   │   ├── video/              # 视频预览/导出
│   │   │   └── admin/              # 后台管理
│   │   ├── components/             # 通用组件
│   │   │   ├── editor/             # 编辑器组件
│   │   │   │   ├── PromptEditor    # 提示词编辑器(核心)
│   │   │   │   ├── ResourcePanel   # 资源面板
│   │   │   │   ├── MentionTag      # @引用标签
│   │   │   │   └── SceneTimeline   # 分镜时间轴
│   │   │   ├── resource/           # 资源卡片
│   │   │   └── common/             # 通用UI
│   │   ├── stores/                 # Zustand状态
│   │   ├── hooks/                  # 自定义Hooks
│   │   ├── api/                    # API调用
│   │   ├── types/                  # TypeScript类型
│   │   ├── utils/                  # 工具函数
│   │   └── styles/                 # 全局样式
│   └── package.json
│
└── docs/                           # 文档
```

---

## 🗄️ 数据库设计

### ER关系图

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│   User   │────<│ Project  │────<│  Script  │
│──────────│     │──────────│     │──────────│
│ id       │     │ id       │     │ id       │
│ email    │     │ user_id  │     │project_id│
│ password │     │ name     │     │ content  │
│ role     │     │ status   │     │ format   │
│ created_at│    │created_at│     │scenes_json│
└──────────┘     └────┬─────┘     └──────────┘
                      │
                      │ 1
                      │
                      ▼ N
               ┌──────────┐     ┌──────────┐
               │  Scene   │────<│SceneAsset│
               │(分镜)    │     │(关联资源) │
               │──────────│     │──────────│
               │ id       │     │ id       │
               │script_id │     │ scene_id │
               │ sequence │     │resource_type│
               │ prompt   │     │ resource_id│
               │ duration │     │ position  │
               │ status   │     └──────────┘
               └────┬─────┘
                    │
                    │ 引用
        ┌───────────┼───────────┐
        ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Character│ │  SceneBG │ │   Prop   │
│ (角色)   │ │ (场景背景)│ │ (道具)   │
│──────────│ │──────────│ │──────────│
│ id       │ │ id       │ │ id       │
│project_id│ │project_id│ │project_id│
│ name     │ │ name     │ │ name     │
│ image_url│ │ image_url│ │ image_url│
│ prompt   │ │ prompt   │ │ prompt   │
│ metadata │ │ metadata │ │ metadata │
└──────────┘ └──────────┘ └──────────┘

┌──────────┐ ┌──────────┐ ┌──────────┐
│  Audio   │ │   Video  │ │   Task   │
│ (音频)   │ │ (视频)   │ │ (任务)   │
│──────────│ │──────────│ │──────────│
│ id       │ │ id       │ │ id       │
│project_id│ │ scene_id │ │ type     │
│ type     │ │ url      │ │ status   │
│ url      │ │ duration │ │ progress │
│ duration │ │ metadata │ │ result_id│
└──────────┘ └──────────┘ └──────────┘
```

### 核心表结构

#### users 表
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    hashed_password VARCHAR(255) NOT NULL,
    nickname VARCHAR(100),
    avatar_url TEXT,
    role VARCHAR(20) DEFAULT 'user',  -- admin/user
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### projects 表
```sql
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    cover_image_url TEXT,
    status VARCHAR(20) DEFAULT 'draft',  -- draft/producing/completed/archived
    settings JSONB DEFAULT '{}',  -- 项目设置(模型选择、参数等)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### scripts 表
```sql
CREATE TABLE scripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    title VARCHAR(255),
    content TEXT NOT NULL,  -- 原始剧本文本
    format VARCHAR(20) DEFAULT 'plain',  -- plain/fountain/finaldraft
    parsed_data JSONB,  -- 解析后的结构化数据
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### scenes 表 (分镜)
```sql
CREATE TABLE scenes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    script_id UUID REFERENCES scripts(id),
    sequence INTEGER NOT NULL,  -- 序号
    scene_type VARCHAR(20) DEFAULT 'normal',  -- normal/title/transition
    prompt TEXT NOT NULL,  -- 提示词(包含@引用)
    parsed_prompt JSONB,  -- 解析后的提示词(展开@引用)
    duration FLOAT DEFAULT 5.0,  -- 时长(秒)
    camera_angle VARCHAR(50),  -- 镜头角度
    movement VARCHAR(50),  -- 镜头运动
    mood VARCHAR(50),  -- 情绪氛围
    status VARCHAR(20) DEFAULT 'pending',  -- pending/ready/generating/completed/failed
    generated_video_url TEXT,
    thumbnail_url TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### characters 表 (角色)
```sql
CREATE TABLE characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    appearance_prompt TEXT,  -- 外观描述(用于文生图)
    image_url TEXT,  -- 生成的角色图
    images JSONB DEFAULT '[]',  -- 多角度/多表情图片
    voice_id VARCHAR(100),  # 关联的音色ID
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### scene_backgrounds 表 (场景)
```sql
CREATE TABLE scene_backgrounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    prompt TEXT,  -- 场景描述
    image_url TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### props 表 (道具)
```sql
CREATE TABLE props (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    prompt TEXT,
    image_url TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### audio_assets 表 (音频)
```sql
CREATE TABLE audio_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL,  -- dialogue/music/sfx/narration
    content TEXT,  -- 台词文本或音乐描述
    url TEXT NOT NULL,
    duration FLOAT,
    character_id UUID REFERENCES characters(id),  -- 如果是对白，关联角色
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### scene_assets 表 (分镜-资源关联)
```sql
CREATE TABLE scene_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
    resource_type VARCHAR(20) NOT NULL,  -- character/scene_bg/prop/audio
    resource_id UUID NOT NULL,
    position INTEGER DEFAULT 0,  -- 在提示词中的位置
    usage_context TEXT,  -- 使用上下文
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(scene_id, resource_type, resource_id)
);
```

#### generation_tasks 表 (生成任务)
```sql
CREATE TABLE generation_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    type VARCHAR(20) NOT NULL,  -- image/video/audio/subtitle
    model VARCHAR(50) NOT NULL,  -- 使用的模型
    input_data JSONB NOT NULL,  -- 输入参数
    output_urls TEXT[],  -- 输出文件URL列表
    status VARCHAR(20) DEFAULT 'pending',  -- pending/processing/completed/failed
    progress INTEGER DEFAULT 0,  -- 0-100
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 🔌 API接口设计

### RESTful API规范

**Base URL**: `/api/v1`

#### 认证模块 `POST /auth/*`
```
POST   /auth/register          # 注册
POST   /auth/login             # 登录
POST   /auth/refresh           # 刷新令牌
POST   /auth/logout            # 登出
GET    /auth/me                # 当前用户信息
```

#### 用户管理 `GET/PUT /users/*` (Admin)
```
GET    /users                  # 用户列表(分页)
GET    /users/{id}             # 用户详情
PUT    /users/{id}             # 更新用户
DELETE /users/{id}             # 删除用户
PUT    /users/{id}/role        # 修改角色
```

#### 项目管理 `CRUD /projects`
```
GET    /projects               # 我的项目列表
POST   /projects               # 创建项目
GET    /projects/{id}          # 项目详情(含所有关联数据)
PUT    /projects/{id}          # 更新项目
DELETE /projects/{id}          # 删除项目
POST   /projects/{id}/clone    # 克隆项目
GET    /projects/{id}/stats    # 项目统计
```

#### 剧本管理 `CRUD /projects/{id}/scripts`
```
GET    /projects/{id}/scripts          # 剧本列表
POST   /projects/{id}/scripts          # 上传/创建剧本
GET    /scripts/{id}                   # 剧本详情
PUT    /scripts/{id}                   # 更新剧本
DELETE /scripts/{id}                   # 删除剧本
POST   /scripts/{id}/parse             # 解析剧本→分镜
POST   /scripts/{id}/import            # 导入(FinalDraft/ Fountain)
POST   /scripts/{id}/export            # 导出
```

#### 分镜管理 `CRUD /scripts/{id}/scenes`
```
GET    /scripts/{id}/scenes            # 分镜列表
POST   /scripts/{id}/scenes            # 创建分镜
PUT    /scenes/{id}                    # 更新分镜
DELETE /scenes/{id}                    # 删除分镜
PUT    /scenes/{id}/reorder            # 排序
PUT    /scenes/{id}/prompt             # 更新提示词
POST   /scenes/{id}/preview            # 预览提示词效果
POST   /scenes/batch-update            # 批量更新
POST   /scripts/{id}/generate-scenes   # AI批量生成分镜
```

#### 资源管理 `CRUD /projects/{id}/{resources}`
```
# 角色
GET    /projects/{id}/characters       # 角色列表
POST   /projects/{id}/characters       # 创建角色
PUT    /characters/{id}                # 更新角色
DELETE /characters/{id}                # 删除角色
POST   /characters/{id}/generate-image # AI生成角色图

# 场景
GET    /projects/{id}/scenes-bg        # 场景列表
POST   /projects/{id}/scenes-bg        # 创建场景
PUT    /scene-backgrounds/{id}         # 更新场景
DELETE /scene-backgrounds/{id}         # 删除场景
POST   /scene-backgrounds/{id}/generate-image

# 道具
GET    /projects/{id}/props            # 道具列表
POST   /projects/{id}/props            # 创建道具
PUT    /props/{id}                     # 更新道具
DELETE /props/{id}                     # 删除道具
POST   /props/{id}/generate-image

# 音频
GET    /projects/{id}/audio            # 音频列表
POST   /projects/{id}/audio            # 上传/创建音频
PUT    /audio-assets/{id}              # 更新音频
DELETE /audio-assets/{id}              # 删除音频
POST   /audio-assets/{id}/tts          # 文字转语音
```

#### 分镜资源关联 `CRUD /scenes/{id}/assets`
```
GET    /scenes/{id}/assets             # 获取关联资源
POST   /scenes/{id}/assets             # 添加资源关联
DELETE /scenes/{id}/assets/{asset_id}  # 移除资源关联
```

#### 任务管理 `GET /tasks`
```
GET    /tasks                          # 任务列表
GET    /tasks/{id}                     # 任务详情
POST   /tasks/{id}/cancel              # 取消任务
POST   /tasks/{id}/retry               # 重试任务
GET    /tasks/{id}/logs                # 任务日志
WebSocket /ws/tasks/{id}               # 实时进度
```

#### 视频生成 `POST /generate/*`
```
POST   /generate/image                 # 单张图片生成
POST   /generate/video                 # 单个视频生成
POST   /generate/batch-video           # 批量视频生成
POST   /generate/batch-full            # 全流程一键生成
POST   /generate/subtitle              # 生成字幕
POST   /generate/remove-subtitle       # 去除字幕
POST   /projects/{id}/export/video     # 导出最终视频
```

#### ComfyUI集成 `POST /comfyui/*`
```
GET    /comfyui/workflows              # 工作流列表
POST   /comfyui/workflows              # 创建工作流
PUT    /comfyui/workflows/{id}         # 更新工作流
POST   /comfyui/workflows/{id}/run     # 执行工作流
GET    /comfyui/workflows/{id}/status  # 执行状态
WebSocket /ws/comfyui/{id}             # 实时输出
```

#### 文件上传
```
POST   /upload/image                   # 上传图片
POST   /upload/video                   # 上传视频
POST   /upload/audio                   # 上传音频
POST   /upload/script                  # 上传剧本文件
GET    /files/{file_id}                # 下载文件
```

#### 后台管理 `Admin Only`
```
GET    /admin/stats                    # 平台统计
GET    /admin/users                    # 用户管理
GET    /admin/projects                 # 项目管理
GET    /admin/tasks                    # 任务监控
GET    /admin/models                   # 模型配置
PUT    /admin/models/{id}              # 更新模型配置
GET    /admin/system/logs              # 系统日志
GET    /admin/system/settings          # 系统设置
PUT    /admin/system/settings          # 更新设置
```

---

## 🎬 核心业务流程

### 流程1: 从剧本到视频的完整流程

```
1. 创建项目
   └─> POST /projects {name: "我的短剧"}

2. 导入/编写剧本
   ├─> 手动编写: POST /projects/{id}/scripts {content: "..."}
   ├─> 上传文件: POST /upload/script → POST /projects/{id}/scripts
   └─> 导入格式: POST /scripts/{id}/import {format: "fountain"}

3. 解析剧本为分镜
   └─> POST /scripts/{id}/parse
       └─> 返回: scenes[] (每个场景包含: 场景描述、对白、动作、情绪)

4. 创建/管理资源
   ├─> 创建角色: POST /projects/{id}/characters
   │   └─> 生成角色图: POST /characters/{id}/generate-image
   ├─> 创建场景: POST /projects/{id}/scenes-bg
   │   └─> 生成场景图: POST /scene-backgrounds/{id}/generate-image
   ├─> 创建道具: POST /projects/{id}/props
   │   └─> 生成道具图: POST /props/{id}/generate-image
   └─> 创建音频: POST /projects/{id}/audio
       └─> TTS生成: POST /audio-assets/{id}/tts

5. 编辑分镜提示词 (核心交互)
   └─> GET /scenes/{id}
       └─> 前端编辑器:
           ├─> 显示原始提示词
           ├─> 解析@引用为可点击标签
           ├─> 底部显示可用资源面板(角色/场景/道具/音频)
           └─> 用户通过点击/拖拽插入@引用
       └─> PUT /scenes/{id}/prompt {prompt: "..."}

6. 关联资源到分镜
   └─> POST /scenes/{id}/assets
       [{resource_type: "character", resource_id: "uuid"},
        {resource_type: "scene_bg", resource_id: "uuid"},
        {resource_type: "prop", resource_id: "uuid"},
        {resource_type: "audio", resource_id: "uuid"}]

7. 生成视频
   ├─> 单个生成: POST /generate/video {scene_id: "..."}
   ├─> 批量生成: POST /generate/batch-video {scene_ids: [...]}
   └─> 一键全流程: POST /generate/batch-full {project_id: "..."}

8. 后期处理
   ├─> 生成字幕: POST /generate/subtitle {video_id: "..."}
   └─> 去除字幕: POST /generate/remove-subtitle {video_id: "..."}

9. 导出成品
   └─> POST /projects/{id}/export/video {format: "mp4", quality: "1080p"}
```

### 流程2: 提示词解析与@引用系统

```
输入提示词示例:
"""
【风格】CN-URBAN-03 | 国产都市生活与逆袭爽文影视品鉴：白描素光与环境强对比...

cd01,26;阿伊玛基薇欧姿容厅舞台台(姿态) @沈如姬 站立于舞台左侧，
@林若薇 站立于舞台右侧... @沈如姬 与 @林若薇 分立舞台两侧...
"""

解析过程:
1. 正则匹配 @[资源名称] 或 @{resource_type:resource_id}
2. 查询数据库获取资源详细信息
3. 展开为完整提示词:

展开后:
"""
【风格】CN-URBAN-03 | 国产都市生活与逆袭爽文影视品鉴：白描素光与环境强对比...

cd01,26;阿伊玛基薇欧姿容厅舞台台(姿态) [角色:沈如姬 外观:黑发红唇身穿黑色礼服 身材高挑]
站立于舞台左侧，[角色:林若薇 外观:棕色卷发白色连衣裙 温柔气质] 站立于舞台右侧...
[角色:沈如姬...] 与 [角色:林若薇...] 分立舞台两侧...
"""

4. 发送给AI模型时使用展开后的完整提示词
5. 保持原始提示词用于显示和编辑
```

---

## 🎨 前端核心组件设计

### 提示词编辑器 (PromptEditor)

这是整个平台的**核心交互组件**，参考用户提供的设计图。

```
┌─────────────────────────────────────────────────────────┐
│  编辑提示词                                    [×关闭]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  【风格】CN-URBAN-03 | 国产都市...                      │
│                                                         │
│  cd01,26;阿伊玛基薇欧姿容厅舞台台(姿态)                  │
│  @沈如姬 站立于舞台左侧，                                │  ← 可点击标签
│  @林若薇 站立于舞台右侧...                              │  ← 橙色边框
│  @沈如姬 与 @林若薇 分立舞台两侧。                       │
│                                                         │
│  ...更多提示词内容...                                    │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  角色:                                                  │
│  ┌──────┐ ┌──────┐ ┌──────┐                             │
│  │ +新增│ │沈如姬│ │林若薇│ ...                          │
│  │      │ │ [头像]│ │ [头像]│                             │
│  └──────┘ └──────┘ └──────┘                             │
│                                                         │
│  场景:                                                  │
│  ┌──────┐                                               │
│  │ +新增│ ┌─────────┐                                   │
│  │      │ │ 舞台场景 │                                  │
│  └──────┘ └─────────┘                                   │
│                                                         │
│  物品:                                                  │
│  ┌──────┐                                               │
│  │ +新增│                                               │
│  └──────┘                                               │
│                                                         │
│  音频:                                                  │
│  ┌──────┐                                               │
│  │ +新增│                                               │
│  └──────┘                                               │
└─────────────────────────────────────────────────────────┘
```

**技术实现要点**:
- 使用 Slate.js 或 Tiptap 构建富文本编辑器
- 自定义 `Mention` 节点渲染 @引用为彩色标签
- 底部面板使用拖拽或点击插入
- 实时解析提示词，预览展开后的完整版本
- 支持 Markdown 语法高亮

### 分镜时间轴 (SceneTimeline)

```
┌─────────────────────────────────────────────────────────┐
│  分镜时间轴                              [+ 添加分镜]   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  #1  ████████████████  5s  [✓完成]                      │
│  #2  ██████████████████████  8s  [⏳生成中]             │
│  #3  ██████████  3s  [○待处理]                           │
│  #4  ████████████████████████████  12s  [○待处理]        │
│  #5  ██████████████████  7s  [○待处理]                   │
│  ...                                                    │
│                                                         │
│  总时长: 35s | 已完成: 1/5 | 生成中: 1/5                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 🔐 权限设计

### 角色定义

| 角色 | 权限范围 |
|------|---------|
| **admin** | 全部权限，后台管理，用户管理，系统配置 |
| **user** | 创建项目，管理自己的资源和项目，生成任务 |

### 权限矩阵

| 功能 | admin | user |
|------|-------|------|
| 用户管理 | ✅ | ❌ |
| 系统配置 | ✅ | ❌ |
| 查看所有项目 | ✅ | 仅自己 |
| 创建项目 | ✅ | ✅ |
| 编辑项目 | ✅ | 仅自己 |
| 删除项目 | ✅ | 仅自己 |
| 生成任务 | ✅ | ✅ (受配额限制) |
| 模型配置 | ✅ | ❌ |

---

## ⚡ 性能优化策略

### 1. 前端优化
- **代码分割**: 路由级别懒加载
- **虚拟滚动**: 分镜列表大数据量优化
- **图片懒加载**: 资源卡片图片按需加载
- **缓存策略**: API响应缓存 + Service Worker
- **WebSocket**: 实时任务进度，避免轮询

### 2. 后端优化
- **异步任务**: 所有AI生成任务走Celery队列
- **连接池**: 数据库连接池复用
- **Redis缓存**: 热点数据缓存(用户信息、项目列表)
- **文件CDN**: 静态资源CDN加速
- **分页查询**: 所有列表接口强制分页

### 3. 存储优化
- **对象存储**: MinIO/S3存储生成的媒体文件
- **缩略图**: 图片自动生成多尺寸缩略图
- **生命周期**: 临时文件定期清理
- **压缩传输**: Gzip/Brotli压缩

---

## 🔒 安全设计

### 认证与授权
- JWT Access Token (15分钟) + Refresh Token (7天)
- 密码bcrypt加密存储
- API Rate Limiting (按用户/IP)
- CORS严格配置

### 数据安全
- SQL注入防护 (SQLAlchemy参数化查询)
- XSS防护 (前端转义 + CSP头)
- CSRF保护 (Double Submit Cookie)
- 文件上传验证 (类型、大小、病毒扫描)

### 隐私保护
- 敏感数据脱敏 (日志中隐藏token/密码)
- GDPR合规 (用户数据导出/删除)
- API访问日志审计

---

## 🚀 部署架构

### 开发环境
```
本地开发:
├── Frontend (Vite Dev Server :5173)
├── Backend (Uvicorn :8000)
├── PostgreSQL (:5432)
├── Redis (:6379)
├── Celery Worker
├── MinIO (:9000)
└── ComfyUI (:8188) (可选)
```

### 生产环境 (Docker Compose)
```yaml
version: '3.8'
services:
  nginx:
    image: nginx:alpine
    ports: ["80:80", "443:443"]
    depends_on: [frontend, backend]

  frontend:
    build: ./frontend
    environment:
      - API_URL=/api

  backend:
    build: ./backend
    depends_on: [postgres, redis, minio]
    environment:
      - DATABASE_URL=postgresql://...
      - REDIS_URL=redis://redis:6379
      - MINIO_ENDPOINT=minio:9000

  postgres:
    image: postgres:16-alpine
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7-alpine

  celery-worker:
    build: ./backend
    command: celery -A app.tasks worker -l info
    depends_on: [backend, redis]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    volumes: ["miniodata:/data"]

  comfyui:  # 可选
    build: ./comfyui
    ports: ["8188:8188"]
    volumes: ["comfyui_models:/models"]
```

---

## 📅 开发里程碑

### Phase 1: 基础框架 (Week 1-2)
- [ ] 项目初始化 (前后端脚手架)
- [ ] 数据库设计与迁移
- [ ] 用户认证系统
- [ ] 基础CRUD (用户/项目)

### Phase 2: 核心功能 (Week 3-4)
- [ ] 剧本导入与解析
- [ ] 分镜管理
- [ ] 资源管理 (角色/场景/道具/音频)
- [ ] **提示词编辑器 (核心)**

### Phase 3: AI集成 (Week 5-6)
- [ ] 模型适配器框架
- [ ] Stable Diffusion集成
- [ ] 图生视频模型集成 (可灵/Runway)
- [ ] Celery任务队列
- [ ] 实���进度推送

### Phase 4: 高级功能 (Week 7-8)
- [ ] ComfyUI工作流集成
- [ ] 批量生成管道
- [ ] 字幕生成/去除
- [ ] 视频导出

### Phase 5: 管理与优化 (Week 9-10)
- [ ] 后台管理系统
- [ ] 数据统计仪表盘
- [ ] 性能优化
- [ ] 安全加固
- [ ] Docker部署配置

---

## 📝 关键技术决策记录

### Q1: 为什么选择FastAPI而不是Django?
- **A**: FastAPI原生异步性能更好，自动OpenAPI文档，类型提示更严格。
  对于AI生成这种I/O密集型应用更合适。

### Q2: 为什么选择Arco Design而不是Ant Design?
- **A**: Arco Design视觉更现代简洁，符合"不要AI味道"的要求，
  且字节内部大量使用，质量有保障。

### Q3: 为什么用Slate.js而不是其他富文本编辑器?
- **A**: Slate.js的数据模型是可定制的，对于实现自定义的@引用节点
  更灵活，虽然开发成本稍高但可控性最好。

### Q4: 如何处理ComfyUI的异步特性?
- **A**: 通过WebSocket连接ComfyUI的实时输出，后端作为代理转发给前端。
  同时将执行状态持久化到数据库，支持断线重连。

---

## 🔮 未来扩展方向

- [ ] **协作编辑**: 多人同时编辑同一项目 (CRDT)
- [ ] **模板市场**: 预设的分镜模板、风格模板
- [ ] **插件系统**: 第三方模型接入插件
- [ ] **AI辅助**: AI自动优化提示词、智能推荐资源
- [ ] **版本控制**: 剧本/分镜的版本历史与回滚
- [ ] **云端渲染**: 将渲染任务分发到云端GPU集群

---

## 📞 联系方式

**项目负责人**: Senior Developer (高级开发工程师)
**技术栈**: Python + React + PostgreSQL + Redis
**文档版本**: v1.0.0
**最后更新**: 2026-07-30

---

> 💡 **提示**: 本文档会随着项目进展持续更新，建议关注Git仓库中的最新版本。
