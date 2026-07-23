"""row_events (変更履歴 / who-what-when audit trail)

Revision ID: 0011_row_events
Revises: 0010_user_active
Create Date: 2026-07-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0011_row_events'
down_revision: Union[str, None] = '0010_user_active'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'row_events',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('sheet_id', sa.Integer(), nullable=False),
        # SET NULL so deleting a task keeps its history readable (row_key holds
        # the id it had at the time).
        sa.Column('row_id', sa.Integer(), nullable=True),
        sa.Column('row_key', sa.String(length=255), nullable=True),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('field_label', sa.String(length=255), nullable=False, server_default=''),
        sa.Column('old_value', sa.Text(), nullable=True),
        sa.Column('new_value', sa.Text(), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['sheet_id'], ['sheets.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['row_id'], ['rows.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_rowevent_row_at', 'row_events', ['row_id', 'created_at'])
    op.create_index('ix_rowevent_sheet_at', 'row_events', ['sheet_id', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_rowevent_sheet_at', table_name='row_events')
    op.drop_index('ix_rowevent_row_at', table_name='row_events')
    op.drop_table('row_events')
