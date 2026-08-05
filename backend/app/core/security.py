"""
Security & Authentication - JWT认证与安全工具
"""
from datetime import datetime, timedelta
from typing import Optional, Any, Dict
from uuid import UUID
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.core.database import get_db
from app.core.exceptions import UnauthorizedException, ForbiddenException

# 密码哈希上下文
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Bearer Token方案
security = HTTPBearer(auto_error=False)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """验证密码"""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """生成密码哈希"""
    return pwd_context.hash(password)


def create_access_token(
    subject: UUID,
    additional_claims: Optional[Dict[str, Any]] = None,
    expires_delta: Optional[timedelta] = None,
) -> str:
    """
    创建JWT访问令牌

    Args:
        subject: 用户ID
        additional_claims: 额外的claims
        expires_delta: 自定义过期时间
    """
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(
            minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES
        )

    to_encode = {
        "sub": str(subject),
        "exp": expire,
        "type": "access",
    }

    if additional_claims:
        to_encode.update(additional_claims)

    encoded_jwt = jwt.encode(
        to_encode,
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    return encoded_jwt


def create_refresh_token(subject: UUID) -> str:
    """创建刷新令牌"""
    expire = datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode = {
        "sub": str(subject),
        "exp": expire,
        "type": "refresh",
    }
    encoded_jwt = jwt.encode(
        to_encode,
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    return encoded_jwt


def decode_token(token: str) -> Dict[str, Any]:
    """解码并验证JWT令牌"""
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
        return payload
    except JWTError as e:
        raise UnauthorizedException("Invalid or expired token")


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
):
    """
    获取当前登录用户 (依赖注入)

    使用方式:
        @router.get("/protected")
        async def protected_route(current_user = Depends(get_current_user)):
            ...
    """
    if credentials is None:
        raise UnauthorizedException("Authentication required")

    token = credentials.credentials
    payload = decode_token(token)

    # 验证token类型
    if payload.get("type") != "access":
        raise UnauthorizedException("Invalid token type")

    user_id = payload.get("sub")
    if user_id is None:
        raise UnauthorizedException("Invalid token payload")

    # 查询用户
    from app.models import User
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if user is None:
        raise UnauthorizedException("User not found")

    if not user.is_active:
        raise ForbiddenException("User account is disabled")

    return user


async def get_current_active_user(
    current_user = Depends(get_current_user),
):
    """获取当前活跃用户"""
    if not current_user.is_active:
        raise ForbiddenException("Inactive user")
    return current_user


async def get_current_admin_user(
    current_user = Depends(get_current_user),
):
    """获取当前管理员用户"""
    if current_user.role != "admin":
        raise ForbiddenException("Admin access required")
    return current_user


class RoleChecker:
    """角色检查器"""

    def __init__(self, allowed_roles: list[str]):
        self.allowed_roles = allowed_roles

    def __call__(self, user=Depends(get_current_user)):
        if user.role not in self.allowed_roles:
            raise ForbiddenException(f"Required role: {self.allowed_roles}")
        return user


# 常用角色检查器实例
require_admin = RoleChecker(["admin"])
require_user_or_admin = RoleChecker(["admin", "user"])
