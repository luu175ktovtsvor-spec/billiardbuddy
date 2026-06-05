"""users, stores, store_members

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-10

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("phone", sa.String(20), unique=True, nullable=False, index=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("name", sa.String(100)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "stores",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("city", sa.String(100)),
        sa.Column("district", sa.String(100)),
        sa.Column("address", sa.String(500)),
        sa.Column("phone", sa.String(50)),
        sa.Column("business_hours", sa.String(200)),
        sa.Column("table_count", sa.Integer),
        sa.Column("table_types", sa.String(500)),
        sa.Column("pricing", postgresql.JSONB),
        sa.Column("member_cards", postgresql.JSONB),
        sa.Column("logo_url", sa.String(500)),
        sa.Column("qrcode_url", sa.String(500)),
        sa.Column("has_private_room", sa.Boolean, server_default=sa.text("false")),
        sa.Column("has_coaching", sa.Boolean, server_default=sa.text("false")),
        sa.Column("has_tournament", sa.Boolean, server_default=sa.text("false")),
        sa.Column("has_parking", sa.Boolean, server_default=sa.text("false")),
        sa.Column("target_customers", sa.String(500)),
        sa.Column("style", sa.String(200)),
        sa.Column("advantages", sa.Text),
        sa.Column("common_activities", sa.Text),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "store_members",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "store_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stores.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("store_id", "user_id", name="uq_store_member"),
    )


def downgrade() -> None:
    op.drop_table("store_members")
    op.drop_table("stores")
    op.drop_table("users")
