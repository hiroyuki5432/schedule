"""work_logs.cat3 (分類の段数を増減できるようにする — 3段目)

Revision ID: 0012_worklog_cat3
Revises: 0011_row_events
Create Date: 2026-07-30

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0012_worklog_cat3'
down_revision: Union[str, None] = '0011_row_events'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: existing logs keep their 2 levels; the 3rd is only filled when the
    # org configures a third category level (settings.worklog.category_levels).
    op.add_column('work_logs', sa.Column('cat3', sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column('work_logs', 'cat3')
