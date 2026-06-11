"""协作任务状态表 collab_tasks

多 Agent 协作任务的状态从进程内存改为落库，解决 2 worker 下查询/取消 404。

Revision ID: 015_collab_tasks
Revises: 014_subscription_payments
Create Date: 2026-06-12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "015_collab_tasks"
down_revision: Union[str, None] = "014_subscription_payments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "collab_tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("store_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("task_type", sa.String(50), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="running"),
        sa.Column("framework", sa.Text()),
        sa.Column("agents", postgresql.JSONB(), server_default="[]"),
        sa.Column("summary", sa.Text()),
        sa.Column("generation_id", postgresql.UUID(as_uuid=True)),
        sa.Column("tokens_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("ix_collab_tasks_store_id", "collab_tasks", ["store_id"])
    op.create_index("ix_collab_tasks_status", "collab_tasks", ["status"])
    # 每店同时只允许一个运行中任务：部分唯一索引在数据库层兜底并发竞态
    op.create_index(
        "ux_collab_tasks_store_running",
        "collab_tasks",
        ["store_id"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
    )


def downgrade() -> None:
    op.drop_index("ux_collab_tasks_store_running", table_name="collab_tasks")
    op.drop_index("ix_collab_tasks_status", table_name="collab_tasks")
    op.drop_index("ix_collab_tasks_store_id", table_name="collab_tasks")
    op.drop_table("collab_tasks")
