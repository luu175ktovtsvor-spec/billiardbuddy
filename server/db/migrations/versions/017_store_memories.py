"""店脑：store_memories 表（门店 AI 长期记忆）

Revision ID: 017_store_memories
Revises: 016_generation_title
Create Date: 2026-06-13
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "017_store_memories"
down_revision: Union[str, None] = "016_generation_title"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "store_memories",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("store_id", UUID(as_uuid=True), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("type", sa.String(20), nullable=False, server_default="semantic"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("confidence", sa.String(10), nullable=False, server_default="medium"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_store_memories_store_id", "store_memories", ["store_id"])


def downgrade() -> None:
    op.drop_index("ix_store_memories_store_id", table_name="store_memories")
    op.drop_table("store_memories")
