"""m2 operation logs and material permissions

Revision ID: 0be0c7f68c6a
Revises: d7bcabe5751e
Create Date: 2026-08-03 10:48:30.647255

新增表:
- operation_logs: 成员管理操作审计日志
- team_material_permissions: 成员对企业素材库的权限矩阵
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0be0c7f68c6a'
down_revision: Union[str, None] = 'd7bcabe5751e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def upgrade() -> None:
    bind = op.get_bind()

    # ==================== operation_logs ====================
    if not _table_exists(bind, 'operation_logs'):
        op.create_table(
            'operation_logs',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('operator_id', sa.UUID(), nullable=True),
            sa.Column('target_user_id', sa.UUID(), nullable=False),
            sa.Column('action', sa.String(length=50), nullable=False),
            sa.Column('detail', sa.Text(), nullable=True),
            sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['operator_id'], ['users.id']),
            sa.ForeignKeyConstraint(['target_user_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_operation_logs_org', 'operation_logs', ['org_id'])
        op.create_index('ix_operation_logs_target', 'operation_logs', ['target_user_id'])

    # ==================== team_material_permissions ====================
    if not _table_exists(bind, 'team_material_permissions'):
        op.create_table(
            'team_material_permissions',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('user_id', sa.UUID(), nullable=False),
            sa.Column('can_view', sa.Boolean(), nullable=False, server_default=sa.text('true')),
            sa.Column('can_upload', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('can_download', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('can_edit', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('can_delete', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('can_invoke', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('org_id', 'user_id', name='uq_material_perm_org_user'),
        )

    # 注: 不删除 ix_projects_org_id (M1 迁移建立, 有用). autogenerate 误报.


def downgrade() -> None:
    bind = op.get_bind()
    if _table_exists(bind, 'team_material_permissions'):
        op.drop_table('team_material_permissions')
    if _table_exists(bind, 'operation_logs'):
        op.drop_index('ix_operation_logs_target', table_name='operation_logs')
        op.drop_index('ix_operation_logs_org', table_name='operation_logs')
        op.drop_table('operation_logs')
