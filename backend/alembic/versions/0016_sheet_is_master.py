"""sheets.is_master (マスタシート — 一覧に出さない参照用シート)

Revision ID: 0016_sheet_is_master
Revises: 0015_backups
Create Date: 2026-08-03

要望: マスタ設定みたいなのもできるといい。ある意味 LOOKUP でできるが、マスタ
シートがたくさん見えると使いにくいので、表には見えないテーブルが欲しい。

既存シートはすべて通常シート（false）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0016_sheet_is_master'
down_revision: Union[str, None] = '0015_backups'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'sheets',
        sa.Column('is_master', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('sheets', 'is_master')
