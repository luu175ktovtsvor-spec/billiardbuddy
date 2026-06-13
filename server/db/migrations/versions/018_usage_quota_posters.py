"""海报独立额度池：usage_quotas 加 monthly_poster_limit / monthly_posters_used

Revision ID: 018_usage_quota_posters
Revises: 017_store_memories
Create Date: 2026-06-14

新增两列让海报有独立月额度（生图比文案贵得多，不再共用文案池）。
存量数据：新列 server_default 让试用店默认 3 张/月；已开通套餐的店从其
active 套餐的 poster_limit 回填，避免被默认值错误压低。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "018_usage_quota_posters"
down_revision: Union[str, None] = "017_store_memories"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "usage_quotas",
        sa.Column("monthly_poster_limit", sa.Integer(), nullable=False, server_default="3"),
    )
    op.add_column(
        "usage_quotas",
        sa.Column("monthly_posters_used", sa.Integer(), nullable=False, server_default="0"),
    )
    # 回填：已开通套餐的店用其 active 套餐的 poster_limit（试用店保留默认 3）
    op.execute(
        """
        UPDATE usage_quotas uq
        SET monthly_poster_limit = p.poster_limit
        FROM store_subscriptions ss
        JOIN plans p ON p.id = ss.plan_id
        WHERE ss.store_id = uq.store_id AND ss.status = 'active'
        """
    )


def downgrade() -> None:
    op.drop_column("usage_quotas", "monthly_posters_used")
    op.drop_column("usage_quotas", "monthly_poster_limit")
