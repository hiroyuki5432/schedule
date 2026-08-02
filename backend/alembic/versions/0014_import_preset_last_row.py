"""import_presets.last_row (これ以降を取り込まない、を記憶する)

Separate from 0013 on purpose: 0013 may already be applied, and folding the
column into it would leave those databases without it.

Revision ID: 0014_preset_last_row
Revises: 0013_import_presets
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0014_preset_last_row'
down_revision: Union[str, None] = '0013_import_presets'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 0 = 最後まで, so existing presets keep taking every row.
    op.add_column(
        'import_presets',
        sa.Column('last_row', sa.Integer(), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('import_presets', 'last_row')
