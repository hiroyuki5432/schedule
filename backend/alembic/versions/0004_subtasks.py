"""subtasks (collapsible per-task checklist)

Revision ID: 0004_subtasks
Revises: 0003_msactual
Create Date: 2026-06-21

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0004_subtasks'
down_revision: Union[str, None] = '0003_msactual'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'subtasks',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('row_id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(500), nullable=False),
        sa.Column('done', sa.Boolean(), nullable=False),
        sa.Column('order', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['row_id'], ['rows.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_subtasks_row', 'subtasks', ['row_id'])


def downgrade() -> None:
    op.drop_index('ix_subtasks_row', table_name='subtasks')
    op.drop_table('subtasks')
