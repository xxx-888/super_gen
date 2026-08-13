"""project delete cascade FKs

Revision ID: b8e1f4d02a7c
Revises: fc4e54c72fe6
Create Date: 2026-08-13 11:00:00.000000

把删除项目相关的外键改成 DB 原生级联，让 `DELETE FROM projects` 一条语句
由 Postgres 自动清理/置空所有子表，彻底不依赖 ORM 级联的删除顺序：

- 归属型子表(*.project_id, scenes.script_id, scenes.episode_id) → ON DELETE CASCADE
- 保留型表(credit_transactions / works)的 project_id / task_id / episode_id → ON DELETE SET NULL
  （积分流水与已发布作品保留记录，只断开引用）

注：episodes.script_id 维持默认 NO ACTION——删项目时 scripts 与 episodes 在同一条
级联语句里删除，NO ACTION 的检查延迟到语句末尾，此时双方都已删除，不会违约；
同时保留"独立删 script 时若被 episode 引用则阻止"的现有语义。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b8e1f4d02a7c'
down_revision: Union[str, None] = 'fc4e54c72fe6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (表, 列, 引用表, 引用列, ondelete)
_FKS = [
    # —— 归属型：删项目时一并删 ——
    ("scripts",            "project_id", "projects",          "id", "CASCADE"),
    ("episodes",           "project_id", "projects",          "id", "CASCADE"),
    ("characters",         "project_id", "projects",          "id", "CASCADE"),
    ("scene_backgrounds",  "project_id", "projects",          "id", "CASCADE"),
    ("props",              "project_id", "projects",          "id", "CASCADE"),
    ("audio_assets",       "project_id", "projects",          "id", "CASCADE"),
    ("generation_tasks",   "project_id", "projects",          "id", "CASCADE"),
    ("project_members",    "project_id", "projects",          "id", "CASCADE"),
    ("canvases",           "project_id", "projects",          "id", "CASCADE"),
    ("material_sync_logs", "project_id", "projects",          "id", "CASCADE"),
    ("scenes",             "script_id",  "scripts",           "id", "CASCADE"),
    ("scenes",             "episode_id", "episodes",          "id", "CASCADE"),
    # —— 保留型：删项目/任务/集时只置空引用，记录保留 ——
    ("credit_transactions", "project_id", "projects",         "id", "SET NULL"),
    ("credit_transactions", "task_id",    "generation_tasks", "id", "SET NULL"),
    ("works",               "project_id", "projects",         "id", "SET NULL"),
    ("works",               "episode_id", "episodes",         "id", "SET NULL"),
]


def _find_fk_constraint(bind, table_name: str, column_name: str):
    """返回 table_name.column_name 上的单列外键约束名；没有则 None。"""
    result = bind.execute(sa.text("""
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class cls ON cls.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f'
          AND cls.relname = :table
          AND a.attname = :col
          AND array_length(c.conkey, 1) = 1
        LIMIT 1
    """), {"table": table_name, "col": column_name})
    row = result.fetchone()
    return row[0] if row else None


def _apply(bind, ondelete_map=None):
    """ondelete_map=None 表示去掉 ondelete（降级用）；否则按 _FKS 里的值设置。"""
    for table, column, ref_table, ref_column, action in _FKS:
        target = action if ondelete_map is None else ondelete_map.get(action, None)
        name = _find_fk_constraint(bind, table, column)
        if name is None:
            # 该列无外键（环境差异），跳过，保持幂等
            continue
        op.drop_constraint(name, table, type_='foreignkey')
        if target is None:
            op.create_foreign_key(name, table, ref_table, [column], [ref_column])
        else:
            op.create_foreign_key(
                name, table, ref_table, [column], [ref_column], ondelete=target,
            )


def upgrade() -> None:
    bind = op.get_bind()
    _apply(bind, ondelete_map=None)  # None → 直接用 _FKS 里每个 FK 自带的 action


def downgrade() -> None:
    bind = op.get_bind()
    # 还原为默认（无 ondelete）
    _apply(bind, ondelete_map={a: None for a in ("CASCADE", "SET NULL")})
