"""m1 org credits upload

Revision ID: d7bcabe5751e
Revises:
Create Date: 2026-08-03 10:32:11.093893

引入多租户(Organization/Membership)与积分(Credit)系统 + 预留成员组/权限组表.

注意: 本项目历史数据通过 create_all 建表, 无 alembic 版本记录.
对已有库请执行 `alembic stamp head` 标记对齐, 无需重跑建表.
对全新库可正常 `alembic upgrade head` (会建本迁移涉及的 7 张新表与 2 个新列;
其余历史表仍由 DEBUG 模式 create_all 负责, 后续会补 baseline 迁移).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'd7bcabe5751e'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    """检查表是否已存在(幂等用)."""
    return bind.dialect.has_table(bind, table_name)


def _column_exists(bind, table_name: str, column_name: str) -> bool:
    """检查列是否已存在(幂等用)."""
    insp = sa.inspect(bind)
    if not insp.has_table(table_name):
        return False
    cols = [c['name'] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade() -> None:
    bind = op.get_bind()

    # ==================== 1. organizations 表 ====================
    if not _table_exists(bind, 'organizations'):
        op.create_table(
            'organizations',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('name', sa.String(length=255), nullable=False),
            sa.Column('avatar_url', sa.Text(), nullable=True),
            sa.Column('owner_id', sa.UUID(), nullable=False),
            sa.Column('is_personal', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('storage_quota_mb', sa.Integer(), nullable=False, server_default='10240'),
            sa.Column('storage_used_mb', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['owner_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_organizations_owner_id', 'organizations', ['owner_id'])

    # ==================== 2. memberships 表 ====================
    if not _table_exists(bind, 'memberships'):
        op.create_table(
            'memberships',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('user_id', sa.UUID(), nullable=False),
            sa.Column('role', sa.String(length=20), nullable=False, server_default='member'),
            sa.Column('display_name', sa.String(length=100), nullable=True),
            sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.text('true')),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('org_id', 'user_id', name='uq_membership_org_user'),
        )
        op.create_index('ix_membership_user', 'memberships', ['user_id'])

    # ==================== 3. member_groups 表 (M2 预留) ====================
    if not _table_exists(bind, 'member_groups'):
        op.create_table(
            'member_groups',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('name', sa.String(length=255), nullable=False),
            sa.Column('leader_id', sa.UUID(), nullable=True),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('member_ids', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['leader_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
        )

    # ==================== 4. permission_groups 表 (M2 预留) ====================
    if not _table_exists(bind, 'permission_groups'):
        op.create_table(
            'permission_groups',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('name', sa.String(length=255), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('permissions', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.PrimaryKeyConstraint('id'),
        )

    # ==================== 5. credit_accounts 表 ====================
    if not _table_exists(bind, 'credit_accounts'):
        op.create_table(
            'credit_accounts',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('balance', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('allocated', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('total_recharged', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('total_consumed', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('org_id'),
        )

    # ==================== 6. credit_transactions 表 ====================
    if not _table_exists(bind, 'credit_transactions'):
        op.create_table(
            'credit_transactions',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('user_id', sa.UUID(), nullable=True),
            sa.Column('project_id', sa.UUID(), nullable=True),
            sa.Column('task_id', sa.UUID(), nullable=True),
            sa.Column('type', sa.String(length=20), nullable=False),
            sa.Column('amount', sa.Integer(), nullable=False),
            sa.Column('balance_after', sa.Integer(), nullable=False),
            sa.Column('model', sa.String(length=50), nullable=True),
            sa.Column('remark', sa.String(length=255), nullable=True),
            sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
            sa.ForeignKeyConstraint(['task_id'], ['generation_tasks.id']),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_credit_tx_org_created', 'credit_transactions', ['org_id', 'created_at'])
        op.create_index('ix_credit_tx_type', 'credit_transactions', ['type'])
        op.create_index('ix_credit_tx_project', 'credit_transactions', ['project_id'])

    # ==================== 7. credit_allocations 表 ====================
    if not _table_exists(bind, 'credit_allocations'):
        op.create_table(
            'credit_allocations',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('user_id', sa.UUID(), nullable=False),
            sa.Column('quota', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('used', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('org_id', 'user_id', name='uq_credit_alloc_org_user'),
        )

    # ==================== 8. users.active_org_id 列 ====================
    if not _column_exists(bind, 'users', 'active_org_id'):
        op.add_column('users', sa.Column('active_org_id', sa.UUID(), nullable=True))
        op.create_foreign_key('fk_users_active_org', 'users', 'organizations', ['active_org_id'], ['id'])

    # ==================== 9. projects.org_id 列 ====================
    if not _column_exists(bind, 'projects', 'org_id'):
        op.add_column('projects', sa.Column('org_id', sa.UUID(), nullable=True))
        op.create_foreign_key('fk_projects_org', 'projects', 'organizations', ['org_id'], ['id'])
        op.create_index('ix_projects_org_id', 'projects', ['org_id'])

    # ==================== 10. 存量数据回填 ====================
    # 为每个没有 personal org 的用户创建一个, 并把其项目关联过去.
    # 用 raw SQL 处理, 避免依赖 ORM 循环.
    _backfill_existing_data(bind)


def _backfill_existing_data(bind):
    """为存量用户补建 personal org + credit account, 并回填 project.org_id."""
    result = bind.execute(sa.text(
        "SELECT id, nickname, email FROM users "
        "WHERE id NOT IN (SELECT owner_id FROM organizations WHERE is_personal = true)"
    ))
    users = result.fetchall()

    import uuid as _uuid
    for u in users:
        user_id, nickname, email = u
        display = (nickname or (email.split('@')[0] if email else 'user'))
        org_id = str(_uuid.uuid4())
        bind.execute(sa.text(
            "INSERT INTO organizations (id, name, owner_id, is_personal, storage_quota_mb, "
            "storage_used_mb, settings, created_at, updated_at) "
            "VALUES (:oid, :name, :uid, true, 10240, 0, '{}'::jsonb, now(), now())"
        ), {"oid": org_id, "name": f"{display} 的团队", "uid": str(user_id)})

        bind.execute(sa.text(
            "INSERT INTO memberships (id, org_id, user_id, role, display_name, is_active, created_at, updated_at) "
            "VALUES (:mid, :oid, :uid, 'owner', :dn, true, now(), now())"
        ), {"mid": str(_uuid.uuid4()), "oid": org_id, "uid": str(user_id), "dn": display})

        bind.execute(sa.text(
            "INSERT INTO credit_accounts (id, org_id, balance, allocated, total_recharged, total_consumed, created_at, updated_at) "
            "VALUES (:aid, :oid, :bal, 0, :bal, 0, now(), now())"
        ), {"aid": str(_uuid.uuid4()), "oid": org_id, "bal": 1000})

        bind.execute(sa.text(
            "INSERT INTO credit_transactions (id, org_id, type, amount, balance_after, remark, created_at, updated_at) "
            "VALUES (:tid, :oid, 'recharge', 1000, 1000, '存量数据迁移赠送', now(), now())"
        ), {"tid": str(_uuid.uuid4()), "oid": org_id})

        # 设置 active_org_id
        bind.execute(sa.text(
            "UPDATE users SET active_org_id = :oid WHERE id = :uid"
        ), {"oid": org_id, "uid": str(user_id)})

        # 回填 project.org_id
        bind.execute(sa.text(
            "UPDATE projects SET org_id = :oid WHERE user_id = :uid AND org_id IS NULL"
        ), {"oid": org_id, "uid": str(user_id)})


def downgrade() -> None:
    bind = op.get_bind()
    # 列
    if _column_exists(bind, 'projects', 'org_id'):
        op.drop_index('ix_projects_org_id', table_name='projects')
        op.drop_constraint('fk_projects_org', 'projects', type_='foreignkey')
        op.drop_column('projects', 'org_id')
    if _column_exists(bind, 'users', 'active_org_id'):
        op.drop_constraint('fk_users_active_org', 'users', type_='foreignkey')
        op.drop_column('users', 'active_org_id')
    # 表 (反序)
    for tbl in ['credit_allocations', 'credit_transactions', 'credit_accounts',
                'permission_groups', 'member_groups', 'memberships', 'organizations']:
        if _table_exists(bind, tbl):
            op.drop_table(tbl)
