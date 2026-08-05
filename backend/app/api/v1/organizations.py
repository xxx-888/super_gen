"""
Organizations API - 团队/组织接口
"""
from uuid import UUID
from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.exceptions import NotFoundException, BadRequestException
from app.api.deps import get_current_org, verify_org_role
from app.models import User, Organization, Membership, CreditAccount
from app.schemas import (
    OrganizationCreate,
    OrganizationUpdate,
    OrganizationResponse,
    CreditAccountResponse,
)
from app.services.organization_service import (
    create_org,
    list_user_orgs,
    switch_active_org,
    get_user_role_in_org,
)
from app.services.credit_service import get_account

router = APIRouter()


def _to_response(org: Organization, role: str = None, balance: int = None) -> OrganizationResponse:
    return OrganizationResponse(
        id=org.id,
        name=org.name,
        avatar_url=org.avatar_url,
        owner_id=org.owner_id,
        is_personal=org.is_personal,
        storage_quota_mb=org.storage_quota_mb,
        storage_used_mb=org.storage_used_mb,
        role=role,
        credit_balance=balance,
        created_at=org.created_at,
    )


@router.get("/mine", response_model=List[OrganizationResponse])
async def list_my_orgs(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """我加入的所有团队"""
    orgs = await list_user_orgs(db, current_user.id)
    result = []
    for org in orgs:
        role = await get_user_role_in_org(db, current_user.id, org.id)
        account = await get_account(db, org.id)
        result.append(_to_response(org, role=role, balance=account.balance))
    return result


@router.get("/current", response_model=OrganizationResponse)
async def get_current_org_info(
    org: Organization = Depends(get_current_org),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """当前选中的团队"""
    role = await get_user_role_in_org(db, current_user.id, org.id)
    account = await get_account(db, org.id)
    return _to_response(org, role=role, balance=account.balance)


@router.post("", response_model=OrganizationResponse, status_code=201)
async def create_new_org(
    body: OrganizationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """创建团队(真实团队, 非个人团队)"""
    org = await create_org(db, current_user, body.name, body.avatar_url)
    account = await get_account(db, org.id)
    return _to_response(org, role="owner", balance=account.balance)


@router.get("/{org_id}", response_model=OrganizationResponse)
async def get_org(
    org_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """团队详情(必须是成员)"""
    role = await get_user_role_in_org(db, current_user.id, org_id)
    if role is None:
        raise NotFoundException("Organization not found", resource="Organization")
    result = await db.execute(select(Organization).where(Organization.id == org_id))
    org = result.scalar_one_or_none()
    if org is None:
        raise NotFoundException("Organization not found", resource="Organization")
    account = await get_account(db, org.id)
    return _to_response(org, role=role, balance=account.balance)


@router.put("/{org_id}", response_model=OrganizationResponse)
async def update_org(
    org_id: UUID,
    body: OrganizationUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新团队(仅 owner/admin)"""
    await verify_org_role(org_id, ["owner", "admin"], db, current_user)
    result = await db.execute(select(Organization).where(Organization.id == org_id))
    org = result.scalar_one_or_none()
    if org is None:
        raise NotFoundException("Organization not found", resource="Organization")

    if body.name is not None:
        org.name = body.name
    if body.avatar_url is not None:
        org.avatar_url = body.avatar_url
    if body.storage_quota_mb is not None:
        org.storage_quota_mb = body.storage_quota_mb
    await db.flush()

    role = await get_user_role_in_org(db, current_user.id, org.id)
    account = await get_account(db, org.id)
    return _to_response(org, role=role, balance=account.balance)


@router.post("/{org_id}/switch", response_model=OrganizationResponse)
async def switch_org(
    org_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """切换当前团队"""
    org = await switch_active_org(db, current_user, org_id)
    role = await get_user_role_in_org(db, current_user.id, org.id)
    account = await get_account(db, org.id)
    return _to_response(org, role=role, balance=account.balance)


@router.get("/{org_id}/credits", response_model=CreditAccountResponse)
async def get_org_credits(
    org_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取团队积分账户(必须是成员)"""
    role = await get_user_role_in_org(db, current_user.id, org_id)
    if role is None:
        raise NotFoundException("Organization not found", resource="Organization")
    return await get_account(db, org_id)
