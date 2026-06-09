"""add conversations plans subscriptions generation fields brand_style

Revision ID: 17f8a2b3c4d5
Revises: 012_store_invitations
Create Date: 2026-06-09

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '17f8a2b3c4d5'
down_revision: Union[str, None] = '012_store_invitations'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # conversations 表
    op.create_table(
        'conversations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('store_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('stores.id'), nullable=False, index=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True, index=True),
        sa.Column('type', sa.String(50), nullable=False),
        sa.Column('title', sa.String(200), nullable=True),
        sa.Column('status', sa.String(20), server_default='active'),
        sa.Column('message_count', sa.Integer, server_default='0'),
        sa.Column('last_message_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # conversation_messages 表
    op.create_table(
        'conversation_messages',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('role', sa.String(20), nullable=False),
        sa.Column('content', sa.Text, nullable=True),
        sa.Column('generation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('generations.id'), nullable=True),
        sa.Column('token_count', sa.Integer, nullable=True),
        sa.Column('model_used', sa.String(100), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # plans 表
    op.create_table(
        'plans',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('slug', sa.String(50), unique=True, nullable=False),
        sa.Column('price_monthly', sa.Integer, server_default='0'),
        sa.Column('price_yearly', sa.Integer, server_default='0'),
        sa.Column('generation_limit', sa.Integer, server_default='20'),
        sa.Column('token_limit', sa.Integer, server_default='100000'),
        sa.Column('poster_limit', sa.Integer, server_default='5'),
        sa.Column('max_members', sa.Integer, server_default='1'),
        sa.Column('features', postgresql.JSONB, nullable=True),
        sa.Column('is_active', sa.Boolean, server_default=sa.text('true')),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # store_subscriptions 表
    op.create_table(
        'store_subscriptions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('store_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('stores.id'), unique=True, nullable=False, index=True),
        sa.Column('plan_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('plans.id'), nullable=False),
        sa.Column('status', sa.String(20), server_default='active'),
        sa.Column('current_period_start', sa.DateTime(timezone=True), nullable=False),
        sa.Column('current_period_end', sa.DateTime(timezone=True), nullable=False),
        sa.Column('activated_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('payment_note', sa.String(500), nullable=True),
        sa.Column('payment_amount', sa.Integer, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # generations 表新增字段
    op.add_column('generations', sa.Column('effect_rating', sa.String(20), nullable=True))
    op.add_column('generations', sa.Column('effect_note', sa.String(500), nullable=True))
    op.add_column('generations', sa.Column('rated_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('generations', sa.Column('quality_used', sa.String(20), nullable=True))
    op.add_column('generations', sa.Column('image_size', sa.String(20), nullable=True))

    # users 表新增 is_admin
    op.add_column('users', sa.Column('is_admin', sa.Boolean, server_default=sa.text('false')))

    # stores 表新增 brand_style
    op.add_column('stores', sa.Column('brand_style', sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column('stores', 'brand_style')
    op.drop_column('users', 'is_admin')
    op.drop_column('generations', 'image_size')
    op.drop_column('generations', 'quality_used')
    op.drop_column('generations', 'rated_at')
    op.drop_column('generations', 'effect_note')
    op.drop_column('generations', 'effect_rating')
    op.drop_table('store_subscriptions')
    op.drop_table('plans')
    op.drop_table('conversation_messages')
    op.drop_table('conversations')
