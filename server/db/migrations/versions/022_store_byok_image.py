"""022 stores 生图 BYOK：门店自带生图模型（加密 key + base_url + model + enabled）

Revision ID: 022_store_byok_image
Revises: 021_store_byok
Create Date: 2026-06-18

文字模型多用 DeepSeek、生图用 OpenAI gpt-image，key/base_url 通常不同，故生图 BYOK 与文字分开存。
未配置则回退平台默认（config.openai_*）。key 同样 Fernet 加密、绝不明文落库。
（桌面 SQLite 走 create_all 自动建此列；本迁移供云端 PostgreSQL。）
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "022_store_byok_image"
down_revision: Union[str, None] = "021_store_byok"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("stores", sa.Column("byok_image_enabled", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("stores", sa.Column("byok_image_base_url", sa.String(length=300), nullable=True))
    op.add_column("stores", sa.Column("byok_image_api_key_enc", sa.Text(), nullable=True))
    op.add_column("stores", sa.Column("byok_image_model", sa.String(length=100), nullable=True))


def downgrade() -> None:
    op.drop_column("stores", "byok_image_model")
    op.drop_column("stores", "byok_image_api_key_enc")
    op.drop_column("stores", "byok_image_base_url")
    op.drop_column("stores", "byok_image_enabled")
