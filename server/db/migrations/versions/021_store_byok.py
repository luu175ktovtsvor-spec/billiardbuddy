"""021 stores BYOK：门店自带大模型 Key（加密）+ base_url + model + enabled

Revision ID: 021_store_byok
Revises: 020_usage_events
Create Date: 2026-06-17

BYOK（Bring Your Own Key）：让门店接入自己的大模型 API Key，token 成本与并发自担，
解决"全员共用平台单 key"的并发瓶颈 + 成本不可持续。key 经 core/crypto 加密存 byok_api_key_enc，
绝不明文落库；base_url/model 支持任意 OpenAI 兼容模型（MiMo / deepseek-v4-pro / …）。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "021_store_byok"
down_revision: Union[str, None] = "020_usage_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("stores", sa.Column("byok_enabled", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("stores", sa.Column("byok_base_url", sa.String(length=300), nullable=True))
    op.add_column("stores", sa.Column("byok_api_key_enc", sa.Text(), nullable=True))
    op.add_column("stores", sa.Column("byok_model", sa.String(length=100), nullable=True))


def downgrade() -> None:
    op.drop_column("stores", "byok_model")
    op.drop_column("stores", "byok_api_key_enc")
    op.drop_column("stores", "byok_base_url")
    op.drop_column("stores", "byok_enabled")
