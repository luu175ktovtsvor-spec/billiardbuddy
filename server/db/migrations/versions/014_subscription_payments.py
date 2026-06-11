"""订阅收款流水表 + generations 软删除部分索引

- subscription_payments：每笔开通/续费一条流水，收入统计以此为准
  （此前续费直接覆盖 store_subscriptions.payment_amount，历史收款丢失、统计失真）
- 回填：把既有订阅的最近一笔收款导入流水
- generations 部分索引：优化 is_deleted = false 的高频过滤查询

Revision ID: 014_subscription_payments
Revises: 013_add_generations_is_deleted
Create Date: 2026-06-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "014_subscription_payments"
down_revision: Union[str, None] = "013_add_generations_is_deleted"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "subscription_payments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "subscription_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("store_subscriptions.id"),
            nullable=False,
        ),
        sa.Column("amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(500)),
        sa.Column("kind", sa.String(20), nullable=False, server_default="new"),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_subscription_payments_subscription_id",
        "subscription_payments",
        ["subscription_id"],
    )

    # 回填既有订阅的最近一笔收款（PG14 自带 gen_random_uuid）
    op.execute(
        """
        INSERT INTO subscription_payments (id, subscription_id, amount, note, kind, created_by, created_at)
        SELECT gen_random_uuid(), id, payment_amount, payment_note, 'new', activated_by, created_at
        FROM store_subscriptions
        WHERE payment_amount IS NOT NULL AND payment_amount > 0
        """
    )

    # 软删除过滤的部分索引
    op.create_index(
        "ix_generations_store_id_active",
        "generations",
        ["store_id"],
        postgresql_where=sa.text("is_deleted = false"),
    )


def downgrade() -> None:
    op.drop_index("ix_generations_store_id_active", table_name="generations")
    op.drop_index(
        "ix_subscription_payments_subscription_id", table_name="subscription_payments"
    )
    op.drop_table("subscription_payments")
