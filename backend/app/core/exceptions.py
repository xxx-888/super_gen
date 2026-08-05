"""
Custom Exceptions & Handlers - 自定义异常与处理器
"""
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from typing import Any, Dict, Optional
import logging

logger = logging.getLogger(__name__)


# ==================== 自定义异常类 ====================

class AppException(Exception):
    """应用基础异常"""

    def __init__(
        self,
        message: str = "Internal server error",
        status_code: int = 500,
        error_code: str = "INTERNAL_ERROR",
        details: Optional[Dict[str, Any]] = None,
    ):
        self.message = message
        self.status_code = status_code
        self.error_code = error_code
        self.details = details
        super().__init__(self.message)


class NotFoundException(AppException):
    """资源未找到"""

    def __init__(self, message: str = "Resource not found", resource: str = None):
        detail_msg = f"{resource}: {message}" if resource else message
        super().__init__(
            message=detail_msg,
            status_code=404,
            error_code="NOT_FOUND",
        )


class BadRequestException(AppException):
    """请求参数错误"""

    def __init__(self, message: str = "Bad request", details: Optional[Dict] = None):
        super().__init__(
            message=message,
            status_code=400,
            error_code="BAD_REQUEST",
            details=details,
        )


class UnauthorizedException(AppException):
    """未授权"""

    def __init__(self, message: str = "Unauthorized"):
        super().__init__(
            message=message,
            status_code=401,
            error_code="UNAUTHORIZED",
        )


class ForbiddenException(AppException):
    """禁止访问"""

    def __init__(self, message: str = "Forbidden"):
        super().__init__(
            message=message,
            status_code=403,
            error_code="FORBIDDEN",
        )


class ConflictException(AppException):
    """资源冲突"""

    def __init__(self, message: str = "Resource conflict"):
        super().__init__(
            message=message,
            status_code=409,
            error_code="CONFLICT",
        )


class RateLimitException(AppException):
    """请求频率限制"""

    def __init__(self, message: str = "Rate limit exceeded", retry_after: int = 60):
        self.retry_after = retry_after
        super().__init__(
            message=message,
            status_code=429,
            error_code="RATE_LIMITED",
        )


class QuotaExceededException(AppException):
    """配额超限"""

    def __init__(self, message: str = "Quota exceeded", quota_type: str = None):
        detail_msg = f"{quota_type}: {message}" if quota_type else message
        super().__init__(
            message=detail_msg,
            status_code=429,
            error_code="QUOTA_EXCEEDED",
        )


class GenerationFailedException(AppException):
    """AI生成失败"""

    def __init__(
        self,
        message: str = "Generation failed",
        model: str = None,
        original_error: str = None,
    ):
        details = {}
        if model:
            details["model"] = model
        if original_error:
            details["original_error"] = original_error
        super().__init__(
            message=message,
            status_code=502,
            error_code="GENERATION_FAILED",
            details=details if details else None,
        )


class FileUploadException(AppException):
    """文件上传错误"""

    def __init__(self, message: str = "File upload failed"):
        super().__init__(
            message=message,
            status_code=400,
            error_code="FILE_UPLOAD_ERROR",
        )


class ValidationException(Exception):
    """验证异常(用于业务逻辑验证)"""

    def __init__(self, message: str, field: str = None):
        self.message = message
        self.field = field
        super().__init__(self.message)


# ==================== 异常处理器 ====================

async def AppExceptionHandler(request: Request, exc: AppException):
    """应用自定义异常处理器"""
    logger.warning(
        f"AppException: {exc.error_code} - {exc.message} | "
        f"Path: {request.url.path} | User: {getattr(request.state, 'user_id', 'unknown')}"
    )

    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.status_code,
            "message": exc.message,
            "error_code": exc.error_code,
            "details": exc.details,
        },
    )


async def ValidationExceptionHandler(request: Request, exc: RequestValidationError):
    """请求验证异常处理器(参数校验失败)"""
    logger.warning(f"ValidationError: {exc.errors()} | Path: {request.url.path}")

    # 格式化错误信息
    errors = []
    for error in exc.errors():
        field = ".".join(str(loc) for loc in error.get("loc", []))
        errors.append({
            "field": field,
            "message": error.get("msg"),
            "type": error.get("type"),
        })

    return JSONResponse(
        status_code=422,
        content={
            "code": 422,
            "message": "Request validation failed",
            "error_code": "VALIDATION_ERROR",
            "details": {"errors": errors},
        },
    )


async def GenericExceptionHandler(request: Request, exc: Exception):
    """通用异常处理器(未捕获的异常)"""
    logger.error(
        f"Unhandled Exception: {type(exc).__name__} - {str(exc)} | "
        f"Path: {request.url.path}",
        exc_info=True,
    )

    # 生产环境不暴露详细错误信息
    message = "Internal server error"
    if get_settings().DEBUG:
        message = f"{type(exc).__name__}: {str(exc)}"

    return JSONResponse(
        status_code=500,
        content={
            "code": 500,
            "message": message,
            "error_code": "INTERNAL_ERROR",
        },
    )


# 导入配置(避免循环导入)
def get_settings():
    from app.core.config import settings
    return settings
