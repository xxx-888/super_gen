# SceneGen - AI短剧生成平台 项目概览

> **项目代号**: SceneGen (场景生成)
> **版本**: v1.0.0-alpha
> **最后更新**: 2026-07-30
> **状态**: 基础架构搭建完成，核心模块设计完成

---

## 📋 项目简介

SceneGen 是一个**专业级的AI短剧生成平台**，支持从剧本导入到视频产出的全流程自动化。平台采用现代化的技术栈，提供专业工具般的用户体验。

### 核心特性

✅ **全流程覆盖**: 剧本 → 分镜 → 资源 → 视频
✅ **@引用系统**: 创新的提示词编辑器，通过@符号引用角色/场景/道具/音频
✅ **多模型兼容**: 支持云端API + 本地模型 + ComfyUI工作流
✅ **批量生产**: 一键批量生成分镜视频
✅ **后台管理**: 完整的用户、项目、资源管理系统

---

## 🏗️ 技术架构

### 后端 (Python)

| 组件 | 技术 | 说明 |
|------|------|------|
| Web框架 | FastAPI 0.115+ | 高性能异步框架 |
| ORM | SQLAlchemy 2.0 | 异步数据库操作 |
| 数据库 | PostgreSQL 16 | 关系型数据库 |
| 任务队列 | Celery + Redis | 异步AI生成任务 |
| 文件存储 | MinIO (S3兼容) | 对象存储 |
| 认证 | JWT | 无状态认证 |

### 前端 (React)

| 组件 | 技术 | 说明 |
|------|------|------|
| 框架 | React 18 + TypeScript | 类型安全 |
| 构建工具 | Vite 6 | 快速开发体验 |
| UI组件库 | Arco Design | 字节出品，现代简洁 |
| 状态管理 | Zustand | 轻量级状态管理 |
| 富文本编辑器 | Tiptap | 提示词编辑器核心 |
| HTTP客户端 | Axios | API请求封装 |

### AI模型对接

| 类型 | 支持模型 |
|------|---------|
| 文生图 | Stable Diffusion XL, Midjourney, DALL-E 3, 通义万相 |
| 图生视频 | Sora, Runway Gen-3, Pika, 可灵(Kling), 即梦 |
| 语音合成 | CosyVoice, ChatTTS, Azure TTS, Edge TTS |
| 字幕识别 | Whisper (本地), 讯飞ASR |
| 工作流 | ComfyUI (自定义工作流) |

---

## 📁 项目结构

```
super_gen/
├── docs/
│   └── architecture.md          # 完整架构设计文档
│
├── backend/                     # Python后端
│   ├── app/
│   │   ├── main.py              # FastAPI应用入口
│   │   ├── core/                # 核心配置
│   │   │   ├── config.py        # 环境变量与配置
│   │   │   ├── database.py      # 数据库连接
│   │   │   ├── security.py      # JWT认证与安全
│   │   │   └── exceptions.py    # 自定义异常处理
│   │   ├── models/              # SQLAlchemy数据模型
│   │   │   └── __init__.py      # 所有模型定义
│   │   ├── schemas/             # Pydantic请求/响应模型
│   │   │   └── __init__.py      # 所有Schema定义
│   │   ├── api/v1/              # RESTful API路由
│   │   │   ├── router.py        # 路由聚合
│   │   │   ├── auth.py          # 认证接口
│   │   │   ├── users.py         # 用户管理(Admin)
│   │   │   ├── projects.py      # 项目管理
│   │   │   ├── scripts.py       # 剧本管理
│   │   │   ├── scenes.py        # 分镜管理(核心)
│   │   │   ├── resources.py     # 资源管理
│   │   │   ├── tasks.py         # 任务管理+视频生成
│   │   │   └── admin.py         # 后台管理
│   │   ├── services/            # 业务逻辑服务
│   │   │   ├── script_parser.py # 剧本解析服务
│   │   │   ├── prompt_builder.py# 提示词构建服务(核心)
│   │   │   ├── scene_generator.py# AI分镜生成服务
│   │   │   └── video_pipeline.py# 视频生成管道
│   │   └── api/deps.py          # 依赖注入
│   └── requirements.txt         # Python依赖
│
├── frontend/                    # React前端
│   ├── src/
│   │   ├── main.tsx             # 应用入口
│   │   ├── App.tsx              # 路由配置
│   │   ├── types/index.ts       # TypeScript类型定义
│   │   ├── stores/index.ts      # Zustand状态管理
│   │   ├── api/client.ts        # Axios封装
│   │   ├── utils/auth.ts        # 认证工具函数
│   │   ├── styles/global.css    # 全局样式
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   └── MainLayout.tsx  # 主布局组件
│   │   │   └── editor/          # 编辑器组件(核心)
│   │   │       ├── PromptEditor.tsx     # 提示词编辑器主组件
│   │   │       ├── ResourcePanel.tsx    # 资源面板
│   │   │       ├── MentionTag.tsx       # @引用标签
│   │   │       └── PromptPreviewPanel.tsx # 预览面板
│   │   └── pages/
│   │       ├── auth/LoginPage.tsx       # 登录页
│   │       ├── dashboard/DashboardPage.tsx # 工作台
│   │       └── PlaceholderPages.tsx     # 占位页面
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── index.html
│
└── README.md                    # 本文档
```

---

## 🎯 核心功能模块

### 1. 提示词编辑器 (PromptEditor) ⭐ 核心

这是整个平台的**核心交互组件**，实现了创新的@引用系统：

**功能特性:**
- ✅ 富文本编辑器(Tiptap)，支持自定义Mention节点
- ✅ @角色 / @场景 / @道具 / @音频 引用语法
- ✅ 底部资源面板，点击或搜索插入引用
- ✅ 实时解析并预览展开后的完整提示词
- ✅ Token数量估算和质量评估
- ✅ 撤销/重做支持
- ✅ 自动保存提示

**使用示例:**
```
原始提示词:
【风格】CN-URBAN-03 | 国产都市生活...
cd01;阿伊玛基薇欧姿容厅舞台台(姿态) @沈如姬 站立于舞台左侧，
@林若薇 站立于舞台右侧...

展开后:
【风格】CN-URBAN-03 | 国产都市生活...
cd01;阿伊玛基薇欧姿容厅舞台台(姿态) [角色:沈如姬 外观:黑发红唇...]
站立于舞台左侧，[角色:林若薇 外观:棕色卷发...] 站立于舞台右侧...
```

### 2. 剧本解析服务 (ScriptParserService)

- ✅ 自动检测剧本格式(纯文本/Fountain)
- ✅ 智能拆分为场景单元
- ✅ 提取角色和对白
- ✅ 估算每个场景的时长
- ✅ 识别场景标题和转场

### 3. 分镜生成服务 (SceneGeneratorService)

- ✅ 基于剧本自动生成分镜列表
- ✅ 为每个分镜构建初始提示词
- ✅ 自动插入@引用占位符
- ✅ 支持手动调整和重新生成

### 4. 视频生成管道 (VideoPipelineService)

- ✅ 检查并补充缺失的资源图片
- ✅ 批量提交视频生成任务
- ✅ 并发控制和进度跟踪
- ✅ 可选的字幕自动添加
- ✅ 一键全流程自动化

### 5. 后台管理系统

- ✅ 用户管理(CRUD、启用/禁用)
- ✅ 项目监控(查看所有项目)
- ✅ 任务队列监控(实时进度)
- ✅ 模型配置管理(API Key等)
- ✅ 系统设置和日志
- ✅ 存储使用统计

---

## 🗄️ 数据库设计

### 核心实体关系

```
User (用户)
  └─< Project (项目)
       ├─< Script (剧本)
       │    └─< Scene (分镜) ──< SceneAsset (分镜-资源关联)
       ├─< Character (角色)
       ├─< SceneBackground (场景背景)
       ├─< Prop (道具)
       ├─< AudioAsset (音频资产)
       └─< GenerationTask (生成任务)
```

### 关键表说明

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| users | 用户账户 | email, role, is_active |
| projects | 项目容器 | name, status, settings |
| scripts | 剧本内容 | content, format, parsed_data |
| scenes | 分镜(核心) | prompt, parsed_prompt, duration, status |
| characters | 角色定义 | name, appearance_prompt, image_url |
| scene_backgrounds | 场景定义 | name, prompt, image_url |
| props | 道具定义 | name, prompt, image_url |
| audio_assets | 音频资产 | name, type, url, duration |
| generation_tasks | 生成任务 | type, model, status, progress |

---

## 🔌 API接口概览

### 认证模块 `/api/v1/auth`
- `POST /register` - 注册
- `POST /login` - 登录
- `POST /refresh` - 刷新Token
- `GET /me` - 当前用户信息

### 项目管理 `/api/v1/projects`
- `GET /` - 我的项目列表
- `POST /` - 创建项目
- `GET /{id}` - 项目详情
- `PUT /{id}` - 更新项目
- `DELETE /{id}` - 删除项目

### 分镜管理 `/api/v1/scenes` ⭐ 核心
- `GET /script/{id}` - 分镜列表
- `POST /script/{id}` - 创建分镜
- `PUT /{id}/prompt` - 更新提示词(含预览)
- `POST /{id}/preview` - 预览提示词展开效果
- `GET /{id}/assets` - 获取关联资源
- `POST /{id}/assets` - 添加资源关联

### 视频生成 `/api/v1/tasks`
- `POST /generate/image` - 图片生成
- `POST /generate/video` - 单个视频生成
- `POST /generate/batch-video` - 批量视频生成
- `POST /generate/batch-full` - 一键全流程
- `WS /ws/tasks/{id}` - WebSocket实时进度

### 后台管理 `/api/v1/admin`
- `GET /stats` - 平台统计
- `GET /users` - 用户列表
- `GET /tasks` - 任务监控
- `GET /models` - 模型配置
- `GET /settings` - 系统设置

---

## 🚀 快速开始

### 环境要求

- Python 3.11+
- Node.js 18+
- PostgreSQL 16
- Redis 7+

### 后端启动

```bash
cd backend

# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 配置数据库连接等信息

# 启动开发服务器
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 前端启动

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 访问 http://localhost:5173
```

### Docker部署 (推荐用于生产环境)

```bash
# 构建并启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f
```

---

## 📊 开发进度

### 已完成 ✅

- [x] 完整的系统架构设计文档
- [x] 数据库模型设计 (12张表)
- [x] API接口规范设计 (50+ 接口)
- [x] 后端基础架构 (FastAPI + SQLAlchemy)
- [x] JWT认证系统
- [x] CRUD API骨架 (全部模块)
- [x] 核心业务服务:
  - [x] 剧本解析服务
  - [x] 提示词构建服务 (@引用系统)
  - [x] 分镜生成服务
  - [x] 视频管道服务
- [x] 前端基础架构 (React + Vite + Arco Design)
- [x] 主布局组件 (侧边栏 + 顶栏)
- [x] 登录页面
- [x] 工作台仪表盘
- [x] **提示词编辑器 (核心组件)**:
  - [x] Tiptap富文本编辑器集成
  - [x] 自定义Mention扩展
  - [x] 资源面板组件
  - [x] @引用标签组件
  - [x] 预览面板组件
- [x] Zustand状态管理
- [x] Axios API客户端
- [x] 全局样式系统

### 进行中 🔄

- [ ] Celery任务队列实现
- [ ] AI模型适配器实现
- [ ] 文件上传/存储服务
- [ ] WebSocket实时通信完善

### 待开发 📋

- [ ] ComfyUI工作流集成
- [ ] 完整的分镜编辑页面
- [ ] 视频预览播放器
- [ ] 批量生成界面
- [ ] 字幕编辑器
- [ ] 导出功能(MP4拼接)
- [ ] 协作编辑功能
- [ ] 性能优化和测试

---

## 🎨 设计理念

### 不要"AI味道"

市面上很多AI产品都有明显的"AI味"：
- 过度使用渐变色和发光效果
- 充满科技感的深蓝/紫色配色
- 复杂的动画和3D元素
- 类似ChatGPT的对话界面

**SceneGen的设计原则:**
- ✨ **专业工具感**: 像IDE、Figma等专业软件
- 🎯 **简洁克制**: 功能优先，装饰次要
- 🖼️ **现代化但不花哨**: 使用Arco Design的简洁风格
- 💼 **效率导向**: 减少操作步骤，提升工作效率

### UI/UX亮点

1. **@引用系统**: 直观的资源引用方式，类似社交媒体的@提及
2. **实时预览**: 编辑时即时看到展开后的完整提示词
3. **质量评估**: Token计数和智能质量提示
4. **资源面板**: 侧边栏快速访问所有可用资源
5. **时间轴视图**: 直观的分镜序列展示

---

## 🔮 未来规划

### Phase 2 (短期)
- [ ] 完成AI模型对接 (SDXL, 可灵, Runway)
- [ ] 实现ComfyUI工作流集成
- [ ] 完善分镜编辑页面
- [ ] 添加视频预览和导出功能

### Phase 3 (中期)
- [ ] 模板市场 (预设分镜模板)
- [ ] 协作编辑 (多人实时协作)
- [ ] 版本控制 (剧本/分镜历史)
- [ ] 移动端适配

### Phase 4 (长期)
- [ ] AI辅助 (自动优化提示词)
- [ ] 云端渲染集群
- [ ] 开放API平台
- [ ] 插件生态系统

---

## 📝 注意事项

### 安全提醒

⚠️ **生产环境部署前必须:**
1. 修改 `SECRET_KEY` 为强随机字符串
2. 修改默认管理员密码
3. 配置HTTPS
4. 设置CORS白名单
5. 配置数据库备份策略
6. 限制文件上传大小和类型

### 性能建议

💡 **生产环境优化:**
1. 使用Nginx反向代理
2. 启用Gzip/Brotli压缩
3. 配置CDN加速静态资源
4. 数据库连接池调优
5. Redis缓存热点数据
6. Celery Worker多进程部署

---

## 👥 团队与贡献

**项目负责人**: Senior Developer (高级开发工程师)
**技术栈**: Python + React + PostgreSQL + Redis
**文档版本**: v1.0.0
**许可证**: MIT (待定)

---

## 📞 支持

如有问题或建议，请通过以下方式联系:

- 📧 Email: support@scenegen.com
- 📖 文档: https://docs.scenegen.com
- 💬 社区: https://community.scenegen.com

---

> 💡 **提示**: 本项目正在积极开发中，欢迎贡献代码和建议！
>
> 🎬 让AI短剧创作变得简单而强大！
