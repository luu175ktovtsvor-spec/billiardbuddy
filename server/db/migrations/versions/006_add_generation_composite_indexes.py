"""Add composite indexes to generations table

Revision ID: 006_add_generation_composite_indexes
Revises: 005_add_user_id_idx
Create Date: 2024-01-01

"""
from alembic import op

# revision identifiers, used by Alembic.
revision = '006_add_generation_composite_indexes'
down_revision = '005_add_user_id_idx'
branch_labels = None
depends_on = None


def upgrade():
    op.create_index('ix_generations_store_type', 'generations', ['store_id', 'type'])
    op.create_index('ix_generations_store_created', 'generations', ['store_id', 'created_at'])


def downgrade():
    op.drop_index('ix_generations_store_created', table_name='generations')
    op.drop_index('ix_generations_store_type', table_name='generations')
