"""データベース側に置く仕掛け（トリガ）。

ここに置くのは「アプリのどの入口から書いても必ず効いてほしいもの」だけ。行を作る・
変える入口は、画面の編集・一括置換・Excel 取り込み（3経路）・バックアップの復元・
ゴミ箱からの復元・seed と多い。アプリ側で1か所ずつ手当てすると、どれか1つの付け忘れが
「黙って違う結果」になる（CLAUDE.md §4-4）。DB のトリガなら入口を選ばない。

1. ``rows_fill_sort_order`` — 並び順を指定せずに行を INSERT したら、そのシートの
   末尾の番号を振る（= 従来どおり「追加した順」に並ぶ）。
2. ``app_notify_change`` — 行・列・シート・工数・マイルストン・メモ・ゴミ箱・日報が
   変わったら ``pg_notify('app_change', …)`` を出す。リアルタイム更新（app.realtime）
   がこれを LISTEN して、開いている画面へ「このシートが変わった」と伝える。
   通知はコミットされたときにだけ届き、同じトランザクション内の同じ内容は1通に
   まとまる（Postgres の仕様）ので、1000行の取り込みでも通知は1通で済む。

Alembic のマイグレーション（0018）は、この SQL と同じものを自分の中に持っている
（マイグレーションは「その時点の定義」で固定しておくもののため）。ここを変えるときは
新しいマイグレーションで CREATE OR REPLACE し直すこと。
"""
from __future__ import annotations

from sqlalchemy import event

from app.db import Base

#: 通知のチャンネル名。app.realtime が LISTEN する。
CHANNEL = "app_change"

#: 変更通知を出すテーブル。週次スナップショットは入れない — 画面を開いたときに
#: 自動で作られるもので、それを合図に他の画面が再読み込みすると、その再読み込みが
#: また…という連鎖の種になりうるため（実際には1週1件なので止まるが、入れる理由が無い）。
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

SORT_ORDER_TRIGGER = [
    "DROP TRIGGER IF EXISTS rows_fill_sort_order ON rows",
    "CREATE TRIGGER rows_fill_sort_order BEFORE INSERT ON rows "
    "FOR EACH ROW EXECUTE FUNCTION rows_fill_sort_order()",
]

# 送る中身は「どのグループの・どのシートが・どの種類で変わったか」と、変えた人
# （app.user_id）と画面（app.client_id）。値そのものは送らない — 受け取った画面は
# いつもの API で読み直すので、権限の確認もいつもの経路を通る。
# app.user_id / app.client_id は、リクエストごとにトランザクションの中で設定される
# （app.realtime.tag_session）。設定されていない書き込み（seed 等）は空のまま。
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
  -- 親ごと消えた（シートや行の削除に巻き込まれた）ものは、親の側の通知に任せる。
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


def notify_trigger_statements() -> list[str]:
    out: list[str] = []
    for t in NOTIFY_TABLES:
        out.append(f"DROP TRIGGER IF EXISTS {t}_notify_change ON {t}")
        out.append(
            f"CREATE TRIGGER {t}_notify_change AFTER INSERT OR UPDATE OR DELETE ON {t} "
            f"FOR EACH ROW EXECUTE FUNCTION app_notify_change()"
        )
    return out


def all_statements() -> list[str]:
    return [SORT_ORDER_FUNCTION, *SORT_ORDER_TRIGGER, NOTIFY_FUNCTION, *notify_trigger_statements()]


@event.listens_for(Base.metadata, "after_create")
def _install(target, connection, **kw) -> None:  # pragma: no cover - exercised by tests' create_all
    # exec_driver_sql with no parameters: the SQL is sent as-is (no % formatting).
    for stmt in all_statements():
        connection.exec_driver_sql(stmt)
