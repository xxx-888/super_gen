"""m7 video edit configs

Revision ID: b7e4c9a1f2d3
Revises: 8802a1f6e374
Create Date: 2026-08-24

新增表:
- video_edit_configs: 视频在线剪辑配置（每集一条 JSONB 草稿 + 导出状态）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'b7e4c9a1f2d3'
down_revision: Union[str, None] = '8802a1f6e374'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if _table_exists(bind, "video_edit_configs"):
        return
    op.create_table(
        "video_edit_configs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("episode_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("episodes.id", ondelete="CASCADE"),
                  unique=True, nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("config", postgresql.JSONB(), nullable=True, server_default="{}"),
        sa.Column("last_output_url", sa.Text(), nullable=True),
        sa.Column("last_render_task_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("generation_tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("rendering", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_video_edit_configs_episode_id", "video_edit_configs", ["episode_id"])
    op.create_index("ix_video_edit_configs_project_id", "video_edit_configs", ["project_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if not _table_exists(bind, "video_edit_configs"):
        return
    op.drop_index("ix_video_edit_configs_project_id", table_name="video_edit_configs")
    op.drop_index("ix_video_edit_configs_episode_id", table_name="video_edit_configs")
    op.drop_table("video_edit_configs")
