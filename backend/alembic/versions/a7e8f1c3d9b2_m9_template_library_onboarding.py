"""M9 模板库 + 新手引导

Revision ID: a7e8f1c3d9b2
Revises: f8d4a6b9c2e1
Create Date: 2026-09-16

- projects: + is_template / template_genre / template_desc / template_sort
  （官方示例项目标记，用户项目列表与看板排除，仅供模板库克隆）
- users: + onboarding JSONB（新手引导状态：tour_done / checklist_dismissed）
- 新表 script_templates（按题材分类的剧本模板）
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision = 'a7e8f1c3d9b2'
down_revision = 'f8d4a6b9c2e1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('is_template', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('projects', sa.Column('template_genre', sa.String(50), nullable=True))
    op.add_column('projects', sa.Column('template_desc', sa.Text(), nullable=True))
    op.add_column('projects', sa.Column('template_sort', sa.Integer(), nullable=False, server_default='0'))
    op.create_index('ix_projects_is_template', 'projects', ['is_template'])

    op.add_column('users', sa.Column('onboarding', JSONB(), nullable=False, server_default='{}'))

    op.create_table(
        'script_templates',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('genre', sa.String(50), nullable=False, index=True),
        sa.Column('title', sa.String(255), nullable=False),
        sa.Column('logline', sa.String(500), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('tags', ARRAY(sa.Text()), nullable=True),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('characters', JSONB(), nullable=True),
        sa.Column('episode_count', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('use_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table('script_templates')
    op.drop_column('users', 'onboarding')
    op.drop_index('ix_projects_is_template', table_name='projects')
    op.drop_column('projects', 'template_sort')
    op.drop_column('projects', 'template_desc')
    op.drop_column('projects', 'template_genre')
    op.drop_column('projects', 'is_template')
