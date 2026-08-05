"""
Organization Service - 组织/团队 业务逻辑

职责:
- 创建团队(含 personal org 自动初始化)
- 查询用户加入的团队列表
- 切换当前团队
- 成员资格校验辅助
"""
from uuid import UUID
from typing import List, Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    User,
    Organization,
    Membership,
    CreditAccount,
)
from app.core.exceptions import NotFoundException, BadRequestException
from app.services.credit_service import init_credit_account


async def create_personal_org(
    db: AsyncSession,
    user: User,
) -> Organization:
    """为新用户创建个人团队(personal org).

    注册时调用. 个人团队名默认 "{昵称/邮箱} 的团队".
    同时: 创建 owner Membership + 初始化积分账户(赠送初始积分).
    """
    display = user.nickname or user.email.split("@")[0]
    org = Organization(
        name=f"{display} 的团队",
        owner_id=user.id,
        is_personal=True,
    )
    db.add(org)
    await db.flush()

    # owner 成员关系
    db.add(Membership(
        org_id=org.id,
        user_id=user.id,
        role="owner",
        display_name=display,
    ))

    # 积分账户 (personal org 赠送初始积分)
    # 从后台「系统设置」读取自定义初始积分，未配置则用 settings.CREDITS_INITIAL_BALANCE
    from app.services.settings_service import get_setting
    custom_quota = await get_setting(db, "default_user_quota", None)
    await init_credit_account(db, org.id, initial_balance=custom_quota)

    # 默认选中该团队
    user.active_org_id = org.id
    await db.flush()
    return org


async def create_org(
    db: AsyncSession,
    owner: User,
    name: str,
    avatar_url: Optional[str] = None,
) -> Organization:
    """创建真实团队. 不赠送积分(余额为0, 待充值)."""
    org = Organization(
        name=name,
        owner_id=owner.id,
        is_personal=False,
        avatar_url=avatar_url,
    )
    db.add(org)
    await db.flush()

    db.add(Membership(
        org_id=org.id,
        user_id=owner.id,
        role="owner",
        display_name=owner.nickname or owner.email,
    ))

    # 真实团队初始余额 0
    await init_credit_account(db, org.id, initial_balance=0)
    await db.flush()
    return org


async def list_user_orgs(db: AsyncSession, user_id: UUID) -> List[Organization]:
    """查询用户加入的所有团队."""
    result = await db.execute(
        select(Organization)
        .join(Membership, Membership.org_id == Organization.id)
        .where(
            Membership.user_id == user_id,
            Membership.is_active == True,
        )
        .order_by(Organization.created_at.asc())
    )
    return list(result.scalars().all())


async def get_user_role_in_org(
    db: AsyncSession, user_id: UUID, org_id: UUID
) -> Optional[str]:
    """获取用户在某团队的角色(不在则返回 None)."""
    result = await db.execute(
        select(Membership.role).where(
            Membership.org_id == org_id,
            Membership.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


async def switch_active_org(db: AsyncSession, user: User, org_id: UUID) -> Organization:
    """切换用户当前选中的团队(必须是已加入的团队)."""
    role = await get_user_role_in_org(db, user.id, org_id)
    if role is None:
        raise NotFoundException("Organization not found or you are not a member", resource="Organization")

    result = await db.execute(select(Organization).where(Organization.id == org_id))
    org = result.scalar_one_or_none()
    if org is None:
        raise NotFoundException("Organization not found", resource="Organization")

    user.active_org_id = org.id
    await db.flush()
    return org


async def get_personal_org(db: AsyncSession, user_id: UUID) -> Optional[Organization]:
    """获取用户的个人团队(每个用户应有且仅有一个)."""
    result = await db.execute(
        select(Organization).where(
            Organization.owner_id == user_id,
            Organization.is_personal == True,
        )
    )
    return result.scalar_one_or_none()
