"""add is_deleted to generations

Revision ID: 013_add_generations_is_deleted
Revises: 17f8a2b3c4d5
Create Date: 2026-06-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "013_add_generations_is_deleted"
down_revision: Union[str, None] = "17f8a2b3c4d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "generations",
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("generations", "is_deleted")
