"""m3 team material library

Revision ID: 75737a776278
Revises: 0be0c7f68c6a
Create Date: 2026-08-03 11:01:03.235510

新增表:
- team_folders: 素材目录树
- team_materials: 团队素材(图片/视频/音频)
- material_sync_logs: 企业素材->项目库 同步记录
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '75737a776278'
down_revision: Union[str, None] = '0be0c7f68c6a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def upgrade() -> None:
    bind = op.get_bind()

    # ==================== team_folders ====================
    if not _table_exists(bind, 'team_folders'):
        op.create_table(
            'team_folders',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('class_type', sa.String(length=20), nullable=False),
            sa.Column('name', sa.String(length=255), nullable=False),
            sa.Column('parent_id', sa.UUID(), nullable=True),
            sa.Column('item_count', sa.Integer(), server_default='0', nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['parent_id'], ['team_folders.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_team_folder_org_class', 'team_folders', ['org_id', 'class_type'])

    # ==================== team_materials ====================
    if not _table_exists(bind, 'team_materials'):
        op.create_table(
            'team_materials',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('category', sa.String(length=20), nullable=False),
            sa.Column('class_type', sa.String(length=20), nullable=True),
            sa.Column('folder_id', sa.UUID(), nullable=True),
            sa.Column('name', sa.String(length=255), nullable=False),
            sa.Column('url', sa.Text(), nullable=False),
            sa.Column('thumbnail_url', sa.Text(), nullable=True),
            sa.Column('size_bytes', sa.Integer(), server_default='0', nullable=False),
            sa.Column('mime_type', sa.String(length=100), nullable=True),
            sa.Column('width', sa.Integer(), nullable=True),
            sa.Column('height', sa.Integer(), nullable=True),
            sa.Column('duration', sa.Float(), nullable=True),
            sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('uploaded_by', sa.UUID(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['folder_id'], ['team_folders.id']),
            sa.ForeignKeyConstraint(['uploaded_by'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_team_material_org_cat', 'team_materials', ['org_id', 'category'])
        op.create_index('ix_team_material_folder', 'team_materials', ['folder_id'])

    # ==================== material_sync_logs ====================
    if not _table_exists(bind, 'material_sync_logs'):
        op.create_table(
            'material_sync_logs',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=False),
            sa.Column('material_id', sa.UUID(), nullable=False),
            sa.Column('project_id', sa.UUID(), nullable=False),
            sa.Column('target_type', sa.String(length=20), nullable=False),
            sa.Column('target_id', sa.UUID(), nullable=False),
            sa.Column('synced_by', sa.UUID(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['material_id'], ['team_materials.id']),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
            sa.ForeignKeyConstraint(['synced_by'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('material_id', 'project_id', 'target_type', name='uq_sync_material_project_type'),
        )
        op.create_index('ix_sync_log_org_project', 'material_sync_logs', ['org_id', 'project_id'])


def downgrade() -> None:
    bind = op.get_bind()
    if _table_exists(bind, 'material_sync_logs'):
        op.drop_index('ix_sync_log_org_project', table_name='material_sync_logs')
        op.drop_table('material_sync_logs')
    if _table_exists(bind, 'team_materials'):
        op.drop_index('ix_team_material_folder', table_name='team_materials')
        op.drop_index('ix_team_material_org_cat', table_name='team_materials')
        op.drop_table('team_materials')
    if _table_exists(bind, 'team_folders'):
        op.drop_index('ix_team_folder_org_class', table_name='team_folders')
        op.drop_table('team_folders')
