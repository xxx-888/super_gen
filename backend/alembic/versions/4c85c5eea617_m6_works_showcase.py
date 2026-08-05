"""m6 works showcase

Revision ID: 4c85c5eea617
Revises: 017eede2ca76
Create Date: 2026-08-03 11:32:02.189456

新增表:
- works: 作品(可发布到公开画廊)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '4c85c5eea617'
down_revision: Union[str, None] = '017eede2ca76'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _table_exists(bind, 'works'):
        op.create_table(
            'works',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('org_id', sa.UUID(), nullable=True),
            sa.Column('user_id', sa.UUID(), nullable=False),
            sa.Column('project_id', sa.UUID(), nullable=True),
            sa.Column('episode_id', sa.UUID(), nullable=True),
            sa.Column('title', sa.String(length=255), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('cover_url', sa.Text(), nullable=True),
            sa.Column('video_url', sa.Text(), nullable=True),
            sa.Column('duration', sa.Float(), nullable=True),
            sa.Column('source_type', sa.String(length=30), server_default='project', nullable=False),
            sa.Column('is_public', sa.Boolean(), server_default=sa.text('false'), nullable=False),
            sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('view_count', sa.Integer(), server_default='0', nullable=False),
            sa.Column('like_count', sa.Integer(), server_default='0', nullable=False),
            sa.Column('tags', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
            sa.ForeignKeyConstraint(['episode_id'], ['episodes.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_work_public', 'works', ['is_public', 'published_at'])
        op.create_index('ix_work_user', 'works', ['user_id'])


def downgrade() -> None:
    bind = op.get_bind()
    if _table_exists(bind, 'works'):
        op.drop_index('ix_work_user', table_name='works')
        op.drop_index('ix_work_public', table_name='works')
        op.drop_table('works')
