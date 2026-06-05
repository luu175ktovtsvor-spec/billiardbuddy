"""make generation user_id nullable

Revision ID: 010_generation_user_id_nullable
Revises: 009_usage_quotas
Create Date: 2026-06-05
"""

from alembic import op
import sqlalchemy as sa

revision = "010_generation_user_id_nullable"
down_revision = "0009_usage_quotas"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "generations",
        "user_id",
        existing_type=sa.UUID(as_uuid=True),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "generations",
        "user_id",
        existing_type=sa.UUID(as_uuid=True),
        nullable=False,
    )
