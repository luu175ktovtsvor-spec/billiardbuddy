"""收款流水加 plan_name：记录每笔缴费当时的档位，供后台展示客户会员历史

Revision ID: 019_payment_plan_name
Revises: 018_usage_quota_posters
Create Date: 2026-06-14

subscription_payments 加 plan_name(可空)。新缴费由 activate/renew 写入当时档位名；
旧数据为空（展示时以金额推断或显示"—"）。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "019_payment_plan_name"
down_revision: Union[str, None] = "018_usage_quota_posters"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("subscription_payments", sa.Column("plan_name", sa.String(100), nullable=True))


def downgrade() -> None:
    op.drop_column("subscription_payments", "plan_name")
