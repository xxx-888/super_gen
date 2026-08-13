"""generation_task soft delete

Revision ID: b3e8f7a2c6d1
Revises: f4d9c2b6a8e1
Create Date: 2026-08-13 17:10:00.000000

给 generation_tasks 加 deleted_at 软删除标记：
- 用户侧（视频预览等）删除任务 = 软删除（写 deleted_at，用户列表不再显示）
- 后台任务队列仍能看到全部记录（审计底账），仅后台可硬删除
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b3e8f7a2c6d1'
down_revision: Union[str, None] = 'f4d9c2b6a8e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(bind, table: str, column: str) -> bool:
    r = bind.execute(sa.text(
        "SELECT 1 FROM information_schema.columns WHERE table_name = :t AND column_name = :c LIMIT 1"
    ), {"t": table, "c": column})
    return r.fetchone() is not None


def _has_index(bind, name: str) -> bool:
    r = bind.execute(sa.text("SELECT 1 FROM pg_indexes WHERE indexname = :n LIMIT 1"), {"n": name})
    return r.fetchone() is not None


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "generation_tasks", "deleted_at"):
        op.add_column("generation_tasks",
                      sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    if not _has_index(bind, "ix_generation_tasks_deleted_at"):
        op.create_index("ix_generation_tasks_deleted_at", "generation_tasks", ["deleted_at"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, "ix_generation_tasks_deleted_at"):
        op.drop_index("ix_generation_tasks_deleted_at", table_name="generation_tasks")
    if _has_column(bind, "generation_tasks", "deleted_at"):
        op.drop_column("generation_tasks", "deleted_at")
