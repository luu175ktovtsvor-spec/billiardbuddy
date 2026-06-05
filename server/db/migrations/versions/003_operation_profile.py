"""operation_profile

Revision ID: 0003_operation_profile
Revises: 0002_generations
Create Date: 2026-05-13

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0003_operation_profile"
down_revision: Union[str, None] = "0002_generations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "stores",
        sa.Column("operation_profile", postgresql.JSONB),
    )


def downgrade() -> None:
    op.drop_column("stores", "operation_profile")
