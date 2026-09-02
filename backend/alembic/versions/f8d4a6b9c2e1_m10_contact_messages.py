"""m10 contact messages (公开联系我们页面)

Revision ID: f8d4a6b9c2e1
Revises: e5c1a9d7f3b2
Create Date: 2026-09-02

新增:
- contact_messages 表：公开留言（称呼/联系方式/类型/内容/IP/处理标记/备注）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = 'f8d4a6b9c2e1'
down_revision: Union[str, None] = 'e5c1a9d7f3b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    exists = bind.execute(sa.text(
        "SELECT 1 FROM information_schema.tables WHERE table_name='contact_messages'"
    )).fetchone()
    if not exists:
        op.create_table(
            "contact_messages",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("name", sa.String(100)),
            sa.Column("contact", sa.String(255)),
            sa.Column("msg_type", sa.String(20), nullable=False, server_default="suggestion"),
            sa.Column("content", sa.Text, nullable=False),
            sa.Column("ip", sa.String(64)),
            sa.Column("is_handled", sa.Boolean, nullable=False, server_default=sa.text("false")),
            sa.Column("admin_note", sa.Text),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        )
        op.create_index("ix_contact_messages_created_at", "contact_messages", ["created_at"])
        op.create_index("ix_contact_messages_is_handled", "contact_messages", ["is_handled"])


def downgrade() -> None:
    op.drop_index("ix_contact_messages_is_handled", table_name="contact_messages")
    op.drop_index("ix_contact_messages_created_at", table_name="contact_messages")
    op.drop_table("contact_messages")
