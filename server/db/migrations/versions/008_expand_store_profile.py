"""expand store profile

Revision ID: 008_expand_store_profile
Revises: 007_add_generation_favorite
Create Date: 2026-05-30

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "008_expand_store_profile"
down_revision: Union[str, None] = "007_add_generation_favorite"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 助教资料
    op.add_column(
        "stores",
        sa.Column("coach_count", sa.Integer(), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("coach_service_types", sa.String(500), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("coach_price_range", sa.String(200), nullable=True),
    )

    # 商品定价
    op.add_column(
        "stores",
        sa.Column("beverage_price_range", sa.String(200), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("snack_price_range", sa.String(200), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("cue_price_range", sa.String(200), nullable=True),
    )

    # 设备品牌
    op.add_column(
        "stores",
        sa.Column("table_brands", sa.String(500), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("cue_brands", sa.String(500), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("other_equipment", sa.Text(), nullable=True),
    )

    # 会员体系
    op.add_column(
        "stores",
        sa.Column("membership_types", postgresql.JSONB(), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("recharge_rules", postgresql.JSONB(), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("membership_benefits", postgresql.JSONB(), nullable=True),
    )

    # 营业数据
    op.add_column(
        "stores",
        sa.Column("daily_avg_customers", sa.Integer(), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("peak_hours", sa.String(200), nullable=True),
    )
    op.add_column(
        "stores",
        sa.Column("avg_spend_range", sa.String(200), nullable=True),
    )


def downgrade() -> None:
    # 营业数据
    op.drop_column("stores", "avg_spend_range")
    op.drop_column("stores", "peak_hours")
    op.drop_column("stores", "daily_avg_customers")

    # 会员体系
    op.drop_column("stores", "membership_benefits")
    op.drop_column("stores", "recharge_rules")
    op.drop_column("stores", "membership_types")

    # 设备品牌
    op.drop_column("stores", "other_equipment")
    op.drop_column("stores", "cue_brands")
    op.drop_column("stores", "table_brands")

    # 商品定价
    op.drop_column("stores", "cue_price_range")
    op.drop_column("stores", "snack_price_range")
    op.drop_column("stores", "beverage_price_range")

    # 助教资料
    op.drop_column("stores", "coach_price_range")
    op.drop_column("stores", "coach_service_types")
    op.drop_column("stores", "coach_count")
