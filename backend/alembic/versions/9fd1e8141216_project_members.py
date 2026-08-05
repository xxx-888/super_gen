"""project members

Revision ID: 9fd1e8141216
Revises: 4c85c5eea617
Create Date: 2026-08-03 11:53:27.182536

新增表:
- project_members: 项目成员(项目-用户多对多, 项目内角色)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '9fd1e8141216'
down_revision: Union[str, None] = '4c85c5eea617'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table_name: str) -> bool:
    return bind.dialect.has_table(bind, table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _table_exists(bind, 'project_members'):
        op.create_table(
            'project_members',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('project_id', sa.UUID(), nullable=False),
            sa.Column('user_id', sa.UUID(), nullable=False),
            sa.Column('role', sa.String(length=20), server_default='viewer', nullable=False),
            sa.Column('added_by', sa.UUID(), nullable=True),
            sa.Column('is_active', sa.Boolean(), server_default=sa.text('true'), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.ForeignKeyConstraint(['added_by'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('project_id', 'user_id', name='uq_project_member'),
        )
        op.create_index('ix_project_member_user', 'project_members', ['user_id'])

    # 为存量项目回填: 每个项目的创建者作为 owner
    conn = op.get_bind()
    projects = conn.execute(sa.text("SELECT id, user_id FROM projects")).fetchall()
    import uuid as _uuid
    for p in projects:
        pid, uid = p
        # 检查是否已有
        exists = conn.execute(sa.text(
            "SELECT 1 FROM project_members WHERE project_id=:pid AND user_id=:uid"
        ), {"pid": str(pid), "uid": str(uid)}).fetchone()
        if not exists:
            conn.execute(sa.text(
                "INSERT INTO project_members (id, project_id, user_id, role, is_active) "
                "VALUES (:id, :pid, :uid, 'owner', true)"
            ), {"id": str(_uuid.uuid4()), "pid": str(pid), "uid": str(uid)})


def downgrade() -> None:
    bind = op.get_bind()
    if _table_exists(bind, 'project_members'):
        op.drop_index('ix_project_member_user', table_name='project_members')
        op.drop_table('project_members')
