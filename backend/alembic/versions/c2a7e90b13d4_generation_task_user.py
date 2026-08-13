"""generation_task user_id

Revision ID: c2a7e90b13d4
Revises: b8e1f4d02a7c
Create Date: 2026-08-13 12:00:00.000000

给 generation_tasks 加 user_id，记录"是谁创建/触发了这个生成任务"，
便于后台任务队列展示创建人、按用户审计模型调用与积分消耗。

- user_id 可空（兼容存量任务；删除用户时置空，不级联删任务）
- 加索引 ix_generation_tasks_user_id，方便后台按用户筛任务
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c2a7e90b13d4'
down_revision: Union[str, None] = 'b8e1f4d02a7c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(bind, table: str, column: str) -> bool:
    result = bind.execute(sa.text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = :t AND column_name = :c LIMIT 1"
    ), {"t": table, "c": column})
    return result.fetchone() is not None


def _has_index(bind, index_name: str) -> bool:
    result = bind.execute(sa.text(
        "SELECT 1 FROM pg_indexes WHERE indexname = :n LIMIT 1"
    ), {"n": index_name})
    return result.fetchone() is not None


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "generation_tasks", "user_id"):
        op.add_column(
            "generation_tasks",
            sa.Column("user_id", sa.UUID(), nullable=True),
        )
        op.create_foreign_key(
            "generation_tasks_user_id_fkey",
            "generation_tasks", "users",
            ["user_id"], ["id"],
            ondelete="SET NULL",
        )
    if not _has_index(bind, "ix_generation_tasks_user_id"):
        op.create_index(
            "ix_generation_tasks_user_id", "generation_tasks", ["user_id"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, "ix_generation_tasks_user_id"):
        op.drop_index("ix_generation_tasks_user_id", table_name="generation_tasks")
    if _has_column(bind, "generation_tasks", "user_id"):
        op.drop_constraint("generation_tasks_user_id_fkey", "generation_tasks", type_="foreignkey")
        op.drop_column("generation_tasks", "user_id")
