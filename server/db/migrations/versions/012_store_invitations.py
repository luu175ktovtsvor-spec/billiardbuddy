"""create store_invitations table

Revision ID: 012_store_invitations
Revises: 011_conversation_fields
Create Date: 2026-06-08
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "012_store_invitations"
down_revision = "011_conversation_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "store_invitations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("store_id", UUID(as_uuid=True), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("code", sa.String(8), nullable=False, unique=True, index=True),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("use_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("store_invitations")
