"""rows.progress_week — week the manual progress applies to (weekly reset)

Revision ID: 0007_progress_week
Revises: 0006_progress_deps
Create Date: 2026-06-21
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0007_progress_week'
down_revision: Union[str, None] = '0006_progress_deps'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('rows', sa.Column('progress_week', sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column('rows', 'progress_week')
