"""add generation favorite

Revision ID: 007_add_generation_favorite
Revises: 006_add_generation_composite_indexes
Create Date: 2026-05-29
"""

from alembic import op
import sqlalchemy as sa

revision = "007_add_generation_favorite"
down_revision = "006_add_generation_composite_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "generations",
        sa.Column("is_favorite", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("generations", "is_favorite")
