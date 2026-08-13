"""import_presets.match_mode（取り込みの行の照合のしかた）

Revision ID: 0017_import_match_mode
Revises: 0016_sheet_is_master
Create Date: 2026-08-13

要望: 1列目が被るとID重複とみなされて1行にまとまってしまう。基本1行まとめはしない
でほしい。行の照合を明示的に選べるようにする（照合しない / IDで照合 / 入れ替え）。

既存のプリセットは空文字のまま = 「記録が無い」。読むときに ID列の有無から従来の
意味（ID列あり → 'id'）へ解決するので、これまでの一括取り込みは同じ動きを続ける。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0017_import_match_mode'
down_revision: Union[str, None] = '0016_sheet_is_master'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'import_presets',
        sa.Column('match_mode', sa.String(length=16), nullable=False, server_default=''),
    )


def downgrade() -> None:
    op.drop_column('import_presets', 'match_mode')
