"""notifications table + users.worklog_required

Revision ID: 0009_notifications
Revises: 0008_milestone_kind
Create Date: 2026-06-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0009_notifications'
down_revision: Union[str, None] = '0008_milestone_kind'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Whether a user is expected to file a daily work-log. Admins/外注 can be
    # excluded so they never get 未入力 reminders. Default true (most members log).
    op.add_column(
        'users',
        sa.Column('worklog_required', sa.Boolean(), nullable=False, server_default=sa.true()),
    )

    op.create_table(
        'notifications',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('org_id', sa.Integer(), sa.ForeignKey('organizations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        # 'behind' | 'dep' | 'overrun' | 'milestone' | 'worklog_missing'
        sa.Column('type', sa.String(32), nullable=False),
        sa.Column('title', sa.String(255), nullable=False),
        sa.Column('body', sa.Text(), nullable=True),
        # Where it points (for a click-through): 'row' / 'worklog_day' + the id.
        sa.Column('ref_kind', sa.String(16), nullable=True),
        sa.Column('ref_id', sa.String(64), nullable=True),
        # One notification per condition-occurrence (e.g. "behind:row:5:2026-06-22").
        # Unique with user_id so re-detection on every page view never duplicates.
        sa.Column('dedupe_key', sa.String(255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint('user_id', 'dedupe_key', name='uq_notif_user_dedupe'),
    )
    op.create_index(
        'ix_notif_user_unread', 'notifications', ['user_id', 'read_at', 'created_at']
    )


def downgrade() -> None:
    op.drop_index('ix_notif_user_unread', table_name='notifications')
    op.drop_table('notifications')
    op.drop_column('users', 'worklog_required')
