"""
Application Configuration - 环境变量与配置管理
"""
from pydantic_settings import BaseSettings
from typing import List, Optional, Tuple
from functools import lru_cache


class Settings(BaseSettings):
    """应用配置"""

    # ==================== 基础配置 ====================
    PROJECT_NAME: str = "SceneGen"
    VERSION: str = "1.0.0"
    DEBUG: bool = True
    ENVIRONMENT: str = "development"  # development/staging/production

    # API配置
    API_V1_PREFIX: str = "/api/v1"

    # ==================== 服务器配置 ====================
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    WORKERS: int = 1  # Uvicorn worker数量(生产环境建议4-8)

    # ==================== CORS配置 ====================
    CORS_ORIGINS: List[str] = [
        "http://localhost:5173",  # Vite dev server
        "http://localhost:3000",  # 备用前端端口
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
    ]

    # ==================== 数据库配置 ====================
    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/scenegen"
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20
    DATABASE_ECHO: bool = False  # 打印SQL日志

    # ==================== Redis配置 ====================
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_MAX_CONNECTIONS: int = 10

    # ==================== JWT认证配置 ====================
    SECRET_KEY: str = "your-super-secret-key-change-in-production-min-32-chars!"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    ALGORITHM: str = "HS256"

    # ==================== 文件存储配置 ====================
    STORAGE_TYPE: str = "local"  # local/minio/s3/oss/cos
    STORAGE_LOCAL_PATH: str = "./uploads"  # 本地存储路径
    STORAGE_ENDPOINT: Optional[str] = None  # MinIO/S3 endpoint
    STORAGE_BUCKET: str = "scenegen"
    STORAGE_ACCESS_KEY: Optional[str] = None
    STORAGE_SECRET_KEY: Optional[str] = None
    STORAGE_REGION: Optional[str] = None
    MAX_UPLOAD_SIZE: int = 100 * 1024 * 1024  # 100MB
    ALLOWED_IMAGE_TYPES: List[str] = ["image/jpeg", "image/png", "image/webp", "image/gif"]
    ALLOWED_VIDEO_TYPES: List[str] = ["video/mp4", "video/webm"]
    ALLOWED_AUDIO_TYPES: List[str] = ["audio/mpeg", "audio/wav", "audio/ogg"]

    # ==================== Celery配置 ====================
    CELERY_BROKER_URL: str = "redis://localhost:6379/1"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/2"
    CELERY_TASK_SERIALIZER: str = "json"
    CELERY_RESULT_SERIALIZER: str = "json"
    CELERY_ACCEPT_CONTENT: List[str] = ["json"]
    CELERY_TIMEZONE: str = "Asia/Shanghai"
    CELERY_ENABLE_UTC: bool = True

    # ==================== AI模型配置 ====================

    # Stable Diffusion / SDXL
    SD_API_URL: Optional[str] = None  # http://localhost:7860 (Automatic1111) 或 ComfyUI
    SD_MODEL: str = "stable-diffusion-xl-base-1.0"
    SD_DEFAULT_STEPS: int = 30
    SD_DEFAULT_CFG: float = 7.0
    SD_DEFAULT_SIZE: Tuple[int, int] = (1024, 1024)

    # 可灵 (Kling)
    KLING_API_KEY: Optional[str] = None
    KLING_API_URL: str = "https://api.klingai.com/v1"

    # Runway
    RUNWAY_API_KEY: Optional[str] = None
    RUNWAY_API_URL: str = "https://api.runwayml.com/v1"

    # ComfyUI
    COMFYUI_API_URL: str = "http://127.0.0.1:8188"
    COMFYUI_ENABLED: bool = False

    # TTS (语音合成)
    TTS_PROVIDER: str = "cosyvoice"  # cosyvoice/chattts/edge_tts/azure
    COSYVOICE_API_URL: Optional[str] = None
    AZURE_TTS_KEY: Optional[str] = None
    AZURE_TTS_REGION: Optional[str] = None

    # ASR (语音识别 - 字幕)
    ASR_PROVIDER: str = "whisper_local"  # whisper_local/whisper_api/xunfei
    WHISPER_MODEL: str = "base"  # tiny/base/small/medium/large

    # LLM (大语言模型 - Agent 决策层) 默认智谱 GLM OpenAI 兼容端点
    # 配置后 Agent 模式可用真实 LLM 做规划；未配置则降级为规则 pipeline
    LLM_PROVIDER: str = "zhipu"  # zhipu / openai / compatible
    LLM_API_KEY: Optional[str] = None
    LLM_BASE_URL: Optional[str] = None  # 智谱: https://open.bigmodel.cn/api/paas/v4
    LLM_MODEL: str = "glm-4-flash"  # 智谱免费档; 可改 glm-4 / glm-4-plus
    LLM_TIMEOUT: int = 300

    # ==================== 任务队列配置 ====================
    TASK_QUEUE_CONCURRENCY: int = 3  # 并发任务数
    TASK_RETRY_COUNT: int = 3  # 失败重试次数
    TASK_RETRY_DELAY: int = 5  # 重试间隔(秒)
    TASK_TIMEOUT: int = 300  # 超时时间(秒)

    # ==================== 用户配额配置 ====================
    FREE_USER_DAILY_GENERATIONS: int = 10  # 免费用户每日生成次数
    PREMIUM_USER_DAILY_GENERATIONS: int = 100  # 付费用户每日生成次数
    MAX_PROJECTS_PER_USER: int = 50  # 每用户最大项目数
    MAX_SCENES_PER_PROJECT: int = 500  # 每项目最大分镜数

    # ==================== 积分系统配置 (M1) ====================
    CREDITS_ENABLED: bool = True  # 积分扣费开关; False 时跳过扣费(开发联调)
    CREDITS_INITIAL_BALANCE: int = 1000  # 个人团队初始赠送积分(便于联调)
    # 各类任务默认单价(实际以 AIModel.cost_per_request 为准, 此为兜底)
    CREDITS_COST_TEXT_TO_IMAGE: int = 1
    CREDITS_COST_IMAGE_TO_VIDEO: int = 3
    CREDITS_COST_TTS: int = 1
    CREDITS_COST_LIP_SYNC: int = 2

    # ==================== 管理员默认账户 ====================
    ADMIN_DEFAULT_EMAIL: str = "admin@scenegen.com"
    ADMIN_DEFAULT_PASSWORD: str = "Admin123456"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True


@lru_cache()
def get_settings() -> Settings:
    """获取配置单例"""
    return Settings()


settings = get_settings()
