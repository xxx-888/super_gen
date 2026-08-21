"""启动引导服务：默认管理员创建。

全新部署（空库）时系统里没有任何 admin 角色用户，后台管理将无法登录。
此服务在应用启动时幂等执行：仅当不存在 admin 用户时，用环境变量
ADMIN_DEFAULT_EMAIL / ADMIN_DEFAULT_PASSWORD 创建默认管理员（含个人团队
与积分账户，与正常注册流程一致）。已存在 admin 则直接跳过，不做任何变更。
"""
import logging

from sqlalchemy import select

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.security import get_password_hash

logger = logging.getLogger(__name__)


async def ensure_default_admin() -> None:
    """确保系统至少有一个 admin 角色用户（幂等，供 lifespan 调用）。"""
    from app.models import User

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.role == "admin").limit(1))
        if result.scalar_one_or_none():
            return

        email = settings.ADMIN_DEFAULT_EMAIL
        result = await db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                email=email,
                hashed_password=get_password_hash(settings.ADMIN_DEFAULT_PASSWORD),
                nickname="Administrator",
                role="admin",
            )
            db.add(user)
            await db.flush()
            await db.refresh(user)
            # 与普通注册一致：个人团队 + 积分账户（create_personal_org 不幂等，仅新建时调用）
            from app.services.organization_service import create_personal_org
            await create_personal_org(db, user)
            logger.info(f"已创建默认管理员 {email}（首次启动生成，请尽快登录修改密码）")
        else:
            # 邮箱已存在但不是 admin：仅提升角色，不改密码、不动已有团队
            user.role = "admin"
            logger.info(f"已将现有用户 {email} 提升为 admin")

        await db.commit()
