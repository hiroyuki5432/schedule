"""backups (グループ単位のバックアップ / リストア)

Revision ID: 0015_backups
Revises: 0014_preset_last_row
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0015_backups'
down_revision: Union[str, None] = '0014_preset_last_row'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'backups',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('label', sa.String(length=255), nullable=False, server_default=''),
        sa.Column('format_version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('summary', postgresql.JSONB(astext_type=sa.Text()), nullable=False,
                  server_default='{}'),
        sa.Column('size_bytes', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column('created_by', sa.Integer(), nullable=True),
        sa.Column('created_by_name', sa.String(length=255), nullable=False, server_default=''),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_backup_org_at', 'backups', ['org_id', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_backup_org_at', table_name='backups')
    op.drop_table('backups')
