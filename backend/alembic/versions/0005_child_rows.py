"""child rows (rows.parent_row_id) — subtasks become real tasks; drop checklist

Revision ID: 0005_child_rows
Revises: 0004_subtasks
Create Date: 2026-06-21

Subtasks are no longer a separate checklist table; a subtask is a Row with a
parent_row_id. The parent aggregates its children's weekly effort. This drops
the (uncommitted, prod-unapplied) subtasks table created in 0004.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0005_child_rows'
down_revision: Union[str, None] = '0004_subtasks'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('rows', sa.Column('parent_row_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_rows_parent_row', 'rows', 'rows',
        ['parent_row_id'], ['id'], ondelete='CASCADE',
    )
    op.create_index('ix_rows_parent_row_id', 'rows', ['parent_row_id'])

    # Replace the checklist-style subtasks table (0004) with child rows.
    op.drop_index('ix_subtasks_row', table_name='subtasks')
    op.drop_table('subtasks')


def downgrade() -> None:
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

    op.drop_index('ix_rows_parent_row_id', table_name='rows')
    op.drop_constraint('fk_rows_parent_row', 'rows', type_='foreignkey')
    op.drop_column('rows', 'parent_row_id')
