"""generation_task scene_id

Revision ID: f4d9c2b6a8e1
Revises: e9c3a17b5d20
Create Date: 2026-08-13 16:30:00.000000

给 generation_tasks 加 scene_id 真实列（此前只埋在 input_data JSON 里，无法可靠关联）：
- 任务队列/视频预览可按 剧本/集数/分镜 追溯每条生成记录
- ON DELETE SET NULL：分镜删除后任务保留，仅解除关联
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'f4d9c2b6a8e1'
down_revision: Union[str, None] = 'e9c3a17b5d20'
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


def _has_fk(bind, name: str) -> bool:
    r = bind.execute(sa.text(
        "SELECT 1 FROM pg_constraint WHERE conname = :n AND contype = 'f' LIMIT 1"
    ), {"n": name})
    return r.fetchone() is not None


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "generation_tasks", "scene_id"):
        op.add_column("generation_tasks", sa.Column("scene_id", postgresql.UUID(as_uuid=True), nullable=True))
    if not _has_fk(bind, "generation_tasks_scene_id_fkey"):
        op.create_foreign_key(
            "generation_tasks_scene_id_fkey", "generation_tasks", "scenes",
            ["scene_id"], ["id"], ondelete="SET NULL",
        )
    if not _has_index(bind, "ix_generation_tasks_scene_id"):
        op.create_index("ix_generation_tasks_scene_id", "generation_tasks", ["scene_id"])
    # 回填：把埋在 input_data.scene_id 里的历史关联迁到新列
    bind.execute(sa.text(
        "UPDATE generation_tasks SET scene_id = (input_data->>'scene_id')::uuid "
        "WHERE scene_id IS NULL AND input_data ? 'scene_id' "
        "AND (input_data->>'scene_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"
    ))
    # 顺带回填缺失的 episode_id（能从分镜推出来的）
    bind.execute(sa.text(
        "UPDATE generation_tasks t SET episode_id = s.episode_id "
        "FROM scenes s WHERE t.scene_id = s.id AND t.episode_id IS NULL AND s.episode_id IS NOT NULL"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, "ix_generation_tasks_scene_id"):
        op.drop_index("ix_generation_tasks_scene_id", table_name="generation_tasks")
    if _has_fk(bind, "generation_tasks_scene_id_fkey"):
        op.drop_constraint("generation_tasks_scene_id_fkey", "generation_tasks", type_="foreignkey")
    if _has_column(bind, "generation_tasks", "scene_id"):
        op.drop_column("generation_tasks", "scene_id")
