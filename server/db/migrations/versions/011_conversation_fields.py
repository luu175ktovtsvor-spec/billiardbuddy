"""add conversation fields to generations

Revision ID: 011_conversation_fields
Revises: 010_generation_user_id_nullable
Create Date: 2026-06-08
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "011_conversation_fields"
down_revision = "010_generation_user_id_nullable"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "generations",
        sa.Column("conversation_id", UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "generations",
        sa.Column("openai_response_id", sa.String(200), nullable=True),
    )
    op.create_index(
        "ix_generations_conversation_id",
        "generations",
        ["conversation_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_generations_conversation_id", table_name="generations")
    op.drop_column("generations", "openai_response_id")
    op.drop_column("generations", "conversation_id")
