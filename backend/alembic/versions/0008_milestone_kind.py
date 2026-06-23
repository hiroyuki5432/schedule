"""row_milestones.kind (phase vs milestone)

Revision ID: 0008_milestone_kind
Revises: 0007_progress_week
Create Date: 2026-06-22

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0008_milestone_kind'
down_revision: Union[str, None] = '0007_progress_week'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'row_milestones',
        sa.Column('kind', sa.String(16), nullable=False, server_default='phase'),
    )


def downgrade() -> None:
    op.drop_column('row_milestones', 'kind')
