"""add usage_quotas table

Revision ID: 0009_usage_quotas
Revises: 0008_expand_store_profile
Create Date: 2024-01-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0009_usage_quotas"
down_revision = "008_expand_store_profile"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "usage_quotas",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "store_id",
            UUID(as_uuid=True),
            sa.ForeignKey("stores.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("monthly_generation_limit", sa.Integer(), server_default="100", nullable=False),
        sa.Column("monthly_tokens_limit", sa.Integer(), server_default="500000", nullable=False),
        sa.Column("monthly_generations_used", sa.Integer(), server_default="0", nullable=False),
        sa.Column("monthly_tokens_used", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "current_period_start",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("usage_quotas")
