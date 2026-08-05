"""m4 episode snippet management

Revision ID: 017eede2ca76
Revises: 75737a776278
Create Date: 2026-08-03 11:13:46.336462

新增表:
- episodes: 集(剧集的一集, 状态机: asset->pending_submit->video_editing->completed)

修改表:
- scenes: 加 episode_id / shot_type / creation_mode (Scene 下沉为片段, 归属 Episode)
- generation_tasks: 加 episode_id / credits_consumed (一键成片任务关联与积分统计)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '017eede2ca76'
down_revision: Union[str, None] = '75737a776278'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def _column_exists(bind, table_name: str, column_name: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table_name):
        return False
    return column_name in [c['name'] for c in insp.get_columns(table_name)]


def upgrade() -> None:
    bind = op.get_bind()

    # ==================== episodes 表 ====================
    if not _table_exists(bind, 'episodes'):
        op.create_table(
            'episodes',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('project_id', sa.UUID(), nullable=False),
            sa.Column('script_id', sa.UUID(), nullable=True),
            sa.Column('number', sa.Integer(), nullable=False),
            sa.Column('title', sa.String(length=255), nullable=True),
            sa.Column('status', sa.String(length=30), nullable=False, server_default='asset'),
            sa.Column('stop_after_step', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('smart_review', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('cover_image_url', sa.Text(), nullable=True),
            sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
            sa.ForeignKeyConstraint(['script_id'], ['scripts.id']),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('project_id', 'number', name='uq_episode_project_number'),
        )
        op.create_index('ix_episode_project_sort', 'episodes', ['project_id', 'sort_order'])

    # ==================== scenes 新列 ====================
    if not _column_exists(bind, 'scenes', 'episode_id'):
        op.add_column('scenes', sa.Column('episode_id', sa.UUID(), nullable=True))
        op.create_index(op.f('ix_scenes_episode_id'), 'scenes', ['episode_id'], unique=False)
        op.create_foreign_key('fk_scenes_episode', 'scenes', 'episodes', ['episode_id'], ['id'])
    if not _column_exists(bind, 'scenes', 'shot_type'):
        op.add_column('scenes', sa.Column('shot_type', sa.String(length=50), nullable=True))
    if not _column_exists(bind, 'scenes', 'creation_mode'):
        op.add_column('scenes', sa.Column('creation_mode', sa.String(length=30), nullable=True))

    # ==================== generation_tasks 新列 ====================
    if not _column_exists(bind, 'generation_tasks', 'episode_id'):
        op.add_column('generation_tasks', sa.Column('episode_id', sa.UUID(), nullable=True))
        op.create_foreign_key('fk_gentask_episode', 'generation_tasks', 'episodes', ['episode_id'], ['id'])
    if not _column_exists(bind, 'generation_tasks', 'credits_consumed'):
        op.add_column('generation_tasks',
                      sa.Column('credits_consumed', sa.Integer(), nullable=False, server_default='0'))


def downgrade() -> None:
    bind = op.get_bind()
    if _column_exists(bind, 'generation_tasks', 'credits_consumed'):
        op.drop_column('generation_tasks', 'credits_consumed')
    if _column_exists(bind, 'generation_tasks', 'episode_id'):
        op.drop_constraint('fk_gentask_episode', 'generation_tasks', type_='foreignkey')
        op.drop_column('generation_tasks', 'episode_id')
    if _column_exists(bind, 'scenes', 'creation_mode'):
        op.drop_column('scenes', 'creation_mode')
    if _column_exists(bind, 'scenes', 'shot_type'):
        op.drop_column('scenes', 'shot_type')
    if _column_exists(bind, 'scenes', 'episode_id'):
        op.drop_constraint('fk_scenes_episode', 'scenes', type_='foreignkey')
        op.drop_index(op.f('ix_scenes_episode_id'), table_name='scenes')
        op.drop_column('scenes', 'episode_id')
    if _table_exists(bind, 'episodes'):
        op.drop_index('ix_episode_project_sort', table_name='episodes')
        op.drop_table('episodes')
