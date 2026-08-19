"""work likes

Revision ID: 8802a1f6e374
Revises: a7f3d92c4e18
Create Date: 2026-08-19 10:00:00.000000

新增表:
- work_likes: 作品点赞记录 (work_id + user_id 唯一, 防重复点赞)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '8802a1f6e374'
down_revision: Union[str, None] = 'a7f3d92c4e18'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _table_exists(bind, 'work_likes'):
        op.create_table(
            'work_likes',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('work_id', sa.UUID(), nullable=False),
            sa.Column('user_id', sa.UUID(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['work_id'], ['works.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('work_id', 'user_id', name='uq_work_like_user'),
        )
        op.create_index('ix_work_like_user', 'work_likes', ['user_id'])


def downgrade() -> None:
    bind = op.get_bind()
    if _table_exists(bind, 'work_likes'):
        op.drop_index('ix_work_like_user', table_name='work_likes')
        op.drop_table('work_likes')
