"""generations 加 title:用户可命名(尤其海报),历史页不再显示无意义编码

Revision ID: 016_generation_title
Revises: 015_collab_tasks
Create Date: 2026-06-13
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "016_generation_title"
down_revision: Union[str, None] = "015_collab_tasks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("generations", sa.Column("title", sa.String(80), nullable=True))


def downgrade() -> None:
    op.drop_column("generations", "title")
