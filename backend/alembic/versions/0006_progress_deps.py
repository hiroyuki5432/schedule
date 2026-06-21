"""rows.progress (manual %) + rows.depends_on (predecessor task ids)

Revision ID: 0006_progress_deps
Revises: 0005_child_rows
Create Date: 2026-06-21
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = '0006_progress_deps'
down_revision: Union[str, None] = '0005_child_rows'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('rows', sa.Column('progress', sa.Integer(), nullable=True))
    op.add_column(
        'rows',
        sa.Column(
            'depends_on',
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column('rows', 'depends_on')
    op.drop_column('rows', 'progress')
