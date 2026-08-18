"""add video_assets table

Revision ID: a7f3d92c4e18
Revises: b3e8f7a2c6d1
Create Date: 2026-08-18 11:30:00.000000

新增项目级视频资产表（参考视频素材）：
- 资源管理「视频管理」Tab 的存储
- @视频引用 / MiniMax H3 reference_video 参考生成
- 素材库 video 分类素材可同步为本表记录
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7f3d92c4e18'
down_revision: Union[str, None] = 'b3e8f7a2c6d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(bind, table: str) -> bool:
    r = bind.execute(sa.text(
        "SELECT 1 FROM information_schema.tables WHERE table_name = :t LIMIT 1"
    ), {"t": table})
    return r.fetchone() is not None


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "video_assets"):
        return
    op.create_table(
        "video_assets",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", sa.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("type", sa.String(20), nullable=False, server_default="reference"),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("thumbnail_url", sa.Text(), nullable=True),
        sa.Column("duration", sa.Float(), nullable=True),
        sa.Column("meta", sa.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_video_assets_project_id", "video_assets", ["project_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "video_assets"):
        return
    op.drop_index("ix_video_assets_project_id", table_name="video_assets")
    op.drop_table("video_assets")
