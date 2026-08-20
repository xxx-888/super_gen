"""
FastAPI Application - AI短剧生成平台
"""
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import time
import logging
import os

from app.core.config import settings
from app.core.exceptions import (
    AppException,
    AppExceptionHandler,
    ValidationExceptionHandler,
    GenericExceptionHandler,
)
from app.api.v1.router import api_router
from app.core.database import init_db

# 配置日志
logging.basicConfig(
    level=logging.INFO if not settings.DEBUG else logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时
    logger.info("🚀 Starting SceneGen API Server...")
    logger.info(f"   Environment: {settings.ENVIRONMENT}")
    logger.info(f"   Debug: {settings.DEBUG}")

    # 开发环境: 自动创建数据库表
    if settings.DEBUG:
        try:
            await init_db()
            logger.info("✅ Database tables ensured")
        except Exception as e:
            logger.warning(f"⚠️  Failed to init DB (tables may already exist): {e}")

    # 这里可以添加:
    # - 数据库连接池初始化
    # - Redis连接初始化
    # - Celery Beat启动(定时任务)

    yield

    # 关闭时
    logger.info("👋 Shutting down SceneGen API Server...")


# 创建FastAPI应用实例
app = FastAPI(
    title=settings.PROJECT_NAME,
    description="""
## AI短剧生成平台 (SceneGen) API

专业级AI短剧生成平台，支持从剧本导入到视频产出的全流程自动化。

### 主要功能
- 📝 剧本管理: 导入、编辑、解析剧本
- 🎬 分镜编辑: 智能分镜生成与编辑器
- 🎨 资源管理: 角色/场景/道具/音频资产管理
- 🤖 AI生成: 对接多种文生图/图生视频模型
- ⚡ ComfyUI: 工作流自动化集成
- 👥 后台管理: 用户/项目/任务全面管理
    """,
    version=settings.VERSION,
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
    openapi_url="/openapi.json" if settings.DEBUG else None,
    lifespan=lifespan,
)

# 中间件配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    """记录请求处理时间"""
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(round(process_time * 1000, 2))
    return response


# 注册异常处理器
app.add_exception_handler(AppException, AppExceptionHandler)
app.add_exception_handler(RequestValidationError, ValidationExceptionHandler)
app.add_exception_handler(Exception, GenericExceptionHandler)


# 注册API路由
app.include_router(api_router, prefix="/api/v1")

# 挂载静态文件目录(文件上传访问)
# GuardedStaticFiles: 后台「媒体资源」禁用的生成文件返回 403（media_guard 缓存查询）
_uploads_path = settings.STORAGE_LOCAL_PATH
os.makedirs(_uploads_path, exist_ok=True)


class GuardedStaticFiles(StaticFiles):
    """静态目录 + 禁用媒体拦截（仅本地 /uploads 文件；云端直链见 media_guard 说明）"""

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            from app.core.media_guard import get_disabled_upload_paths
            path = scope.get("path", "")
            if path in await get_disabled_upload_paths():
                from starlette.responses import PlainTextResponse
                await PlainTextResponse("Forbidden: 管理员已禁用该媒体文件", status_code=403)(
                    scope, receive, send)
                return
        await super().__call__(scope, receive, send)


app.mount("/uploads", GuardedStaticFiles(directory=_uploads_path), name="uploads")


# 健康检查端点
@app.get("/health", tags=["Health"])
async def health_check():
    """健康检查接口"""
    return {
        "status": "healthy",
        "service": "scenegen-api",
        "version": settings.VERSION,
        "environment": settings.ENVIRONMENT,
    }


@app.get("/", tags=["Root"])
async def root():
    """根路径 - API信息"""
    return {
        "message": "Welcome to SceneGen API",
        "version": settings.VERSION,
        "docs": "/docs",
        "health": "/health",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.DEBUG,
    )
