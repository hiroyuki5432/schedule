"""行の並び順・セルのメモ・ゴミ箱・リアルタイム更新のトリガ

Revision ID: 0018_order_notes_trash_rt
Revises: 0017_import_match_mode
Create Date: 2026-10-03

要望（Excel からの置き換えで比較される点）:
  * 行を途中に挿入したい → rows.sort_order（既存の行は今の並び = ID順で埋める）
  * セルにメモを残したい → cell_notes
  * 行の削除を取り消したい → deleted_rows（ゴミ箱）
  * 他の人の更新がすぐ画面に出てほしい → 変更通知トリガ（pg_notify）

トリガの SQL は app/db_triggers.py と同じもの。マイグレーションは「この時点の定義」で
固定しておくため、import せずにここへ写してある。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0018_order_notes_trash_rt'
down_revision: Union[str, None] = '0017_import_match_mode'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOTIFY_TABLES = (
    "sheets",
    "columns",
    "rows",
    "effort_entries",
    "row_milestones",
    "cell_notes",
    "deleted_rows",
    "work_logs",
)

SORT_ORDER_FUNCTION = """
CREATE OR REPLACE FUNCTION rows_fill_sort_order() RETURNS trigger AS $$
BEGIN
  IF NEW.sort_order IS NULL THEN
    SELECT COALESCE(MAX(r.sort_order), 0) + 1 INTO NEW.sort_order
      FROM rows r WHERE r.sheet_id = NEW.sheet_id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql
"""

NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION app_notify_change() RETURNS trigger AS $$
DECLARE
  rec record;
  sid integer;
  oid integer;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  IF TG_TABLE_NAME = 'sheets' THEN
    sid := rec.id;
    oid := rec.org_id;
  ELSIF TG_TABLE_NAME IN ('rows', 'columns', 'cell_notes') THEN
    sid := rec.sheet_id;
  ELSIF TG_TABLE_NAME = 'deleted_rows' THEN
    sid := rec.sheet_id;
    oid := rec.org_id;
  ELSIF TG_TABLE_NAME IN ('effort_entries', 'row_milestones') THEN
    SELECT r.sheet_id INTO sid FROM rows r WHERE r.id = rec.row_id;
  ELSIF TG_TABLE_NAME = 'work_logs' THEN
    oid := rec.org_id;
  END IF;
  IF oid IS NULL AND sid IS NOT NULL THEN
    SELECT s.org_id INTO oid FROM sheets s WHERE s.id = sid;
  END IF;
  IF oid IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('app_change', json_build_object(
    'o', oid,
    's', sid,
    't', TG_TABLE_NAME,
    'u', NULLIF(current_setting('app.user_id', true), ''),
    'c', NULLIF(current_setting('app.client_id', true), '')
  )::text);
  RETURN NULL;
END
$$ LANGUAGE plpgsql
"""


def upgrade() -> None:
    # ---- rows.sort_order ----
    op.add_column('rows', sa.Column('sort_order', sa.BigInteger(), nullable=True))
    # 既存の行は今の見え方（ID順）のまま番号を振る。
    op.execute(
        """
        UPDATE rows r SET sort_order = x.n
          FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY sheet_id ORDER BY id) AS n
                  FROM rows) x
         WHERE r.id = x.id
        """
    )
    op.create_index('ix_rows_sheet_order', 'rows', ['sheet_id', 'sort_order'])
    op.execute(SORT_ORDER_FUNCTION)
    op.execute("DROP TRIGGER IF EXISTS rows_fill_sort_order ON rows")
    op.execute(
        "CREATE TRIGGER rows_fill_sort_order BEFORE INSERT ON rows "
        "FOR EACH ROW EXECUTE FUNCTION rows_fill_sort_order()"
    )

    # ---- cell_notes ----
    op.create_table(
        'cell_notes',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('sheet_id', sa.Integer(), nullable=False),
        sa.Column('row_id', sa.Integer(), nullable=False),
        sa.Column('cell_key', sa.String(length=64), nullable=False),
        sa.Column('text', sa.Text(), nullable=False, server_default=''),
        sa.Column('updated_by', sa.Integer(), nullable=True),
        sa.Column('updated_by_name', sa.String(length=255), nullable=False, server_default=''),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.ForeignKeyConstraint(['sheet_id'], ['sheets.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['row_id'], ['rows.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('row_id', 'cell_key', name='uq_cell_note_row_key'),
    )
    op.create_index('ix_cell_note_sheet', 'cell_notes', ['sheet_id'])

    # ---- deleted_rows (ゴミ箱) ----
    op.create_table(
        'deleted_rows',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('sheet_id', sa.Integer(), nullable=False),
        sa.Column('row_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('row_keys', sa.Text(), nullable=False, server_default=''),
        sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False,
                  server_default='{}'),
        sa.Column('deleted_by', sa.Integer(), nullable=True),
        sa.Column('deleted_by_name', sa.String(length=255), nullable=False, server_default=''),
        sa.Column('deleted_at', sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['sheet_id'], ['sheets.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_deleted_rows_sheet_at', 'deleted_rows', ['sheet_id', 'deleted_at'])

    # ---- 変更通知（リアルタイム更新） ----
    op.execute(NOTIFY_FUNCTION)
    for t in NOTIFY_TABLES:
        op.execute(f"DROP TRIGGER IF EXISTS {t}_notify_change ON {t}")
        op.execute(
            f"CREATE TRIGGER {t}_notify_change AFTER INSERT OR UPDATE OR DELETE ON {t} "
            f"FOR EACH ROW EXECUTE FUNCTION app_notify_change()"
        )


def downgrade() -> None:
    for t in NOTIFY_TABLES:
        op.execute(f"DROP TRIGGER IF EXISTS {t}_notify_change ON {t}")
    op.execute("DROP FUNCTION IF EXISTS app_notify_change()")
    op.drop_index('ix_deleted_rows_sheet_at', table_name='deleted_rows')
    op.drop_table('deleted_rows')
    op.drop_index('ix_cell_note_sheet', table_name='cell_notes')
    op.drop_table('cell_notes')
    op.execute("DROP TRIGGER IF EXISTS rows_fill_sort_order ON rows")
    op.execute("DROP FUNCTION IF EXISTS rows_fill_sort_order()")
    op.drop_index('ix_rows_sheet_order', table_name='rows')
    op.drop_column('rows', 'sort_order')
