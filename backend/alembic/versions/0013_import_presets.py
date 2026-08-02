"""import_presets (取り込み設定を記憶して一括取り込みできるようにする)

Revision ID: 0013_import_presets
Revises: 0012_worklog_cat3
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0013_import_presets'
down_revision: Union[str, None] = '0012_worklog_cat3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'import_presets',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('worksheet_name', sa.String(length=255), nullable=False),
        sa.Column('workbook_name', sa.String(length=255), nullable=False, server_default=''),
        # SET NULL: a preset for a deleted sheet degrades into 新規作成 instead of
        # vanishing with the sheet.
        sa.Column('target_sheet_id', sa.Integer(), nullable=True),
        sa.Column('target_sheet_name', sa.String(length=255), nullable=False, server_default=''),
        sa.Column('has_week_grid', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('header_row', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('id_column', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('mapping', postgresql.JSONB(astext_type=sa.Text()), nullable=False,
                  server_default='[]'),
        sa.Column('created_by', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['target_sheet_id'], ['sheets.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', 'worksheet_name', name='uq_import_preset_org_ws'),
    )


def downgrade() -> None:
    op.drop_table('import_presets')
