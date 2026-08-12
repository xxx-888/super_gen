"""canvas panel

Revision ID: fc4e54c72fe6
Revises: 9fd1e8141216
Create Date: 2026-08-11 10:30:00.000000

新增表:
- canvases: 画布面板(节点画布编辑器), 项目级, graph_data 用 JSONB 整存整取
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'fc4e54c72fe6'
down_revision: Union[str, None] = '9fd1e8141216'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _table_exists(bind, 'canvases'):
        op.create_table(
            'canvases',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('project_id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=True),
            sa.Column('user_id', sa.UUID(), nullable=False),
            sa.Column('name', sa.String(length=255), nullable=False, server_default='未命名画布'),
            sa.Column('graph_data', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('thumbnail_url', sa.Text(), nullable=True),
            sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_canvas_project', 'canvases', ['project_id'])
        op.create_index('ix_canvas_org', 'canvases', ['org_id'])


def downgrade() -> None:
    bind = op.get_bind()
    if _table_exists(bind, 'canvases'):
        op.drop_index('ix_canvas_org', table_name='canvases')
        op.drop_index('ix_canvas_project', table_name='canvases')
        op.drop_table('canvases')
