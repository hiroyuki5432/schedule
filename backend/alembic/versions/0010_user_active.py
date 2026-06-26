"""users.is_active (account freeze / 凍結)

Revision ID: 0010_user_active
Revises: 0009_notifications
Create Date: 2026-06-26

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0010_user_active'
down_revision: Union[str, None] = '0009_notifications'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Frozen accounts keep all data/history but cannot log in. Default true so all
    # existing users stay active.
    op.add_column(
        'users',
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column('users', 'is_active')
