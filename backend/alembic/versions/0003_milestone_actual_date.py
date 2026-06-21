"""row_milestones.actual_date (milestone planned vs actual)

Revision ID: 0003_msactual
Revises: 0002_worklog
Create Date: 2026-06-21

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0003_msactual'
down_revision: Union[str, None] = '0002_worklog'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('row_milestones', sa.Column('actual_date', sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column('row_milestones', 'actual_date')
