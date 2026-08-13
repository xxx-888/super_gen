"""credit_pricing credits float

Revision ID: e9c3a17b5d20
Revises: d5b2c0841ea6
Create Date: 2026-08-13 14:20:00.000000

credit_pricing.credits 由 Integer 改为 Float，允许配置小数单价（如视频 1.5 积分/秒）。
实际扣费时由 pricing_service.resolve_cost 向上取整为整数积分（余额仍为整数）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e9c3a17b5d20'
down_revision: Union[str, None] = 'd5b2c0841ea6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "credit_pricing", "credits",
        existing_type=sa.Integer(),
        type_=sa.Float(),
        postgresql_using="credits::double precision",
    )


def downgrade() -> None:
    op.alter_column(
        "credit_pricing", "credits",
        existing_type=sa.Float(),
        type_=sa.Integer(),
        postgresql_using="credits::integer",
    )
