"""使用事件表 usage_events：产品分析 / AI 可观测性的 append-only 事件日志，喂版本迭代。

Revision ID: 020_usage_events
Revises: 019_payment_plan_name
Create Date: 2026-06-16

记录生成成功/失败、场景、耗时、token 等高价值事件，用于按场景看失败率/点踩率，指导迭代。
刻意无外键（解耦 append-only，不随门店/用户删除级联），不参与租户自动过滤（admin 只做聚合）。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "020_usage_events"
down_revision: Union[str, None] = "019_payment_plan_name"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "usage_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("event", sa.String(length=40), nullable=False),
        sa.Column("store_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "props",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_usage_events_event", "usage_events", ["event"])
    op.create_index("ix_usage_events_store_id", "usage_events", ["store_id"])
    op.create_index("ix_usage_events_created_at", "usage_events", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_usage_events_created_at", table_name="usage_events")
    op.drop_index("ix_usage_events_store_id", table_name="usage_events")
    op.drop_index("ix_usage_events_event", table_name="usage_events")
    op.drop_table("usage_events")
