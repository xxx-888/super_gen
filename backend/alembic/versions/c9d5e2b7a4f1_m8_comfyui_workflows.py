"""m8 comfyui workflows

Revision ID: c9d5e2b7a4f1
Revises: b7e4c9a1f2d3
Create Date: 2026-08-25

新增表:
- comfyui_workflows: ComfyUI 工作流库（导入的 UI/API 格式 JSON + 解析元信息）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'c9d5e2b7a4f1'
down_revision: Union[str, None] = 'b7e4c9a1f2d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if _table_exists(bind, "comfyui_workflows"):
        return
    op.create_table(
        "comfyui_workflows",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("format", sa.String(8), nullable=False, server_default="ui"),
        sa.Column("graph", postgresql.JSONB(), nullable=False),
        sa.Column("meta", postgresql.JSONB(), nullable=True),
        sa.Column("node_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_comfyui_workflows_created_at", "comfyui_workflows", ["created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    if not _table_exists(bind, "comfyui_workflows"):
        return
    op.drop_index("ix_comfyui_workflows_created_at", table_name="comfyui_workflows")
    op.drop_table("comfyui_workflows")
