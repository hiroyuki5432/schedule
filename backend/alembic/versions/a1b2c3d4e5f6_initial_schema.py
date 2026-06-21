"""initial schema

Revision ID: a1b2c3d4e5f6
Revises:
Create Date: 2026-06-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('organizations',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('slug', sa.String(255), nullable=False),
        sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('slug'),
    )
    op.create_table('users',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('email', sa.String(255), nullable=False),
        sa.Column('password_hash', sa.String(255), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('role', sa.String(16), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('email'),
    )
    op.create_table('sheets',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('order', sa.Integer(), nullable=False),
        sa.Column('has_week_grid', sa.Boolean(), nullable=False),
        sa.Column('key_column_id', sa.Integer(), nullable=True),
        sa.Column('color_basis_column_id', sa.Integer(), nullable=True),
        sa.Column('numbering_rule', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table('columns',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('sheet_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('order', sa.Integer(), nullable=False),
        sa.Column('type', sa.String(32), nullable=False),
        sa.Column('is_key', sa.Boolean(), nullable=False),
        sa.Column('config', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(['sheet_id'], ['sheets.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table('rows',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('sheet_id', sa.Integer(), nullable=False),
        sa.Column('key_value', sa.String(255), nullable=True),
        sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('created_by', sa.Integer(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_by', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['sheet_id'], ['sheets.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table('effort_entries',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('row_id', sa.Integer(), nullable=False),
        sa.Column('week_start', sa.Date(), nullable=False),
        sa.Column('planned_hours', sa.Numeric(8, 2), nullable=True),
        sa.Column('actual_hours', sa.Numeric(8, 2), nullable=True),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_by', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['row_id'], ['rows.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('row_id', 'week_start', name='uq_effort_row_week'),
    )
    op.create_table('row_milestones',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('row_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('boundary_date', sa.Date(), nullable=False),
        sa.Column('color', sa.String(64), nullable=True),
        sa.Column('order', sa.Integer(), nullable=False),
        sa.Column('done', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['row_id'], ['rows.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table('sheet_snapshots',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('sheet_id', sa.Integer(), nullable=False),
        sa.Column('for_week', sa.Date(), nullable=False),
        sa.Column('state', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['sheet_id'], ['sheets.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('sheet_id', 'for_week', name='uq_snapshot_sheet_week'),
    )


def downgrade() -> None:
    op.drop_table('sheet_snapshots')
    op.drop_table('row_milestones')
    op.drop_table('effort_entries')
    op.drop_table('rows')
    op.drop_table('columns')
    op.drop_table('sheets')
    op.drop_table('users')
    op.drop_table('organizations')
