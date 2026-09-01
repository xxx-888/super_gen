"""m9 user phone (SMS verification)

Revision ID: e5c1a9d7f3b2
Revises: c9d5e2b7a4f1
Create Date: 2026-09-01

新增:
- users.phone: 手机号(注册短信验证码绑定/忘记密码找回), 可空+唯一+索引
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5c1a9d7f3b2'
down_revision: Union[str, None] = 'c9d5e2b7a4f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(bind, table: str, column: str) -> bool:
    rows = bind.execute(sa.text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name=:t AND column_name=:c"
    ), {"t": table, "c": column}).fetchone()
    return rows is not None


def _index_exists(bind, index: str) -> bool:
    rows = bind.execute(sa.text(
        "SELECT 1 FROM pg_indexes WHERE indexname=:i"
    ), {"i": index}).fetchone()
    return rows is not None


def upgrade() -> None:
    bind = op.get_bind()
    if not _column_exists(bind, "users", "phone"):
        op.add_column("users", sa.Column("phone", sa.String(20), nullable=True))
    if not _index_exists(bind, "ix_users_phone"):
        # 唯一索引: Postgres 下多个 NULL 不冲突(历史用户无手机号不冲突)
        op.create_index("ix_users_phone", "users", ["phone"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    if _index_exists(bind, "ix_users_phone"):
        op.drop_index("ix_users_phone", table_name="users")
    if _column_exists(bind, "users", "phone"):
        op.drop_column("users", "phone")
