"""credit_pricing

Revision ID: d5b2c0841ea6
Revises: c2a7e90b13d4
Create Date: 2026-08-13 13:00:00.000000

积分计价规则表：按「模型? + 任务类型 + 分辨率? + 尺寸?」维度配置单价。
- ai_model_id 为 NULL 表示该 task_type 的全局默认规则
- resolution / size 为 NULL 表示通配（任意）
- billing_mode: fixed(单次) / per_second(视频按秒，credits=每秒单价)
- 算价时取最具体（非空维度最多 + priority 最高）的命中规则；无命中则回退 _get_cost

种入默认规则，对齐当前定价（图片1/图生视频按分辨率每秒/TTS1/对口型2），开箱即用。
"""
from typing import Sequence, Union
from uuid import uuid4

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'd5b2c0841ea6'
down_revision: Union[str, None] = 'c2a7e90b13d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if not bind.dialect.has_table(bind, "credit_pricing"):
        op.create_table(
            "credit_pricing",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("ai_model_id", sa.String(length=64), nullable=True),
            sa.Column("task_type", sa.String(length=30), nullable=False),
            sa.Column("resolution", sa.String(length=20), nullable=True),
            sa.Column("size", sa.String(length=20), nullable=True),
            sa.Column("billing_mode", sa.String(length=10), nullable=False, server_default="fixed"),
            sa.Column("credits", sa.Integer(), nullable=False),
            sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("note", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.ForeignKeyConstraint(["ai_model_id"], ["ai_models.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_credit_pricing_model", "credit_pricing", ["ai_model_id"])
        op.create_index("ix_credit_pricing_task_type", "credit_pricing", ["task_type"])

    # 种入默认规则（仅在表为空时，保持幂等）
    cnt = bind.execute(sa.text("SELECT count(*) FROM credit_pricing")).scalar()
    if cnt == 0:
        defaults = [
            # task_type, resolution, size, billing_mode, credits, note
            ("image",          None,   None, "fixed",      1, "文生图默认"),
            ("image_edit",      None,   None, "fixed",      1, "图片编辑默认"),
            ("tts",             None,   None, "fixed",      1, "TTS 默认"),
            ("lip_sync",        None,   None, "fixed",      2, "对口型默认"),
            ("image_to_video",  None,   None, "per_second", 1, "图生视频 768p/720p"),
            ("image_to_video",  "2k",   None, "per_second", 2, "图生视频 1080p/2K"),
            ("first_last_frame", None,  None, "per_second", 1, "首尾帧 768p/720p"),
            ("first_last_frame", "2k",  None, "per_second", 2, "首尾帧 1080p/2K"),
            ("fusion",          None,   None, "per_second", 1, "融生 768p/720p"),
            ("fusion",          "2k",   None, "per_second", 2, "融生 1080p/2K"),
        ]
        rows = [
            {
                "id": str(uuid4()),
                "ai_model_id": None,
                "task_type": t,
                "resolution": r,
                "size": s,
                "billing_mode": bm,
                "credits": c,
                "priority": 0,
                "is_enabled": True,
                "note": n,
            }
            for (t, r, s, bm, c, n) in defaults
        ]
        bind.execute(
            sa.text(
                "INSERT INTO credit_pricing "
                "(id, ai_model_id, task_type, resolution, size, billing_mode, credits, priority, is_enabled, note) "
                "VALUES (:id, :ai_model_id, :task_type, :resolution, :size, :billing_mode, :credits, :priority, :is_enabled, :note)"
            ),
            rows,
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.has_table(bind, "credit_pricing"):
        op.drop_index("ix_credit_pricing_task_type", table_name="credit_pricing")
        op.drop_index("ix_credit_pricing_model", table_name="credit_pricing")
        op.drop_table("credit_pricing")
