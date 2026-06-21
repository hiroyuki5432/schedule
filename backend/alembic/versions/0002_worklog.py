"""work_logs table (daily work-log → weekly actual rollup)

Revision ID: 0002_worklog
Revises: a1b2c3d4e5f6
Create Date: 2026-06-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0002_worklog'
down_revision: Union[str, None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'work_logs',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('work_date', sa.Date(), nullable=False),
        sa.Column('row_id', sa.Integer(), nullable=True),
        sa.Column('cat1', sa.String(255), nullable=True),
        sa.Column('cat2', sa.String(255), nullable=True),
        sa.Column('memo', sa.Text(), nullable=True),
        sa.Column('hours', sa.Numeric(8, 2), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['row_id'], ['rows.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_worklog_row_date', 'work_logs', ['row_id', 'work_date'])
    op.create_index('ix_worklog_org_user_date', 'work_logs', ['org_id', 'user_id', 'work_date'])


def downgrade() -> None:
    op.drop_index('ix_worklog_org_user_date', table_name='work_logs')
    op.drop_index('ix_worklog_row_date', table_name='work_logs')
    op.drop_table('work_logs')
