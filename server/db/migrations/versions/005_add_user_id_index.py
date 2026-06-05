"""Add user_id index to generations table

Revision ID: 005_user_id_index
Revises: 004
Create Date: 2024-01-01

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '005_add_user_id_idx'
down_revision = '004_user_is_active'  # adjust to last revision
branch_labels = None
depends_on = None

def upgrade():
    op.create_index('ix_generations_user_id', 'generations', ['user_id'])

def downgrade():
    op.drop_index('ix_generations_user_id')