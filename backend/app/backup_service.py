"""グループ単位のバックアップ / リストア。

A backup is every org-scoped table dumped verbatim — **primary keys included** —
and a restore puts those same ids back.

Why the ids are kept instead of being re-allocated: this app stores ids inside
JSONB all over the place.

  * ``rows.data`` is keyed by column id,
  * a 参照(LOOKUP) column's ``config`` names a target sheet / match / return column,
  * ``sheets.settings.worklog_task_columns`` is a list of column ids,
  * ``sheets.key_column_id`` / ``color_basis_column_id`` are column ids,
  * status rules hold ``col_id`` per condition,
  * 完了とみなす条件 (``done_filter``) holds column ids.

Re-numbering on restore would mean rewriting every one of those, and anything
missed corrupts a setting *silently* — the sheet still loads, it just quietly
looks at the wrong column. Keeping the ids removes that whole class of bug and is
what makes 「完全にその時の状態に戻す」 actually true.

That choice has one hard consequence, enforced below: a backup can only be
restored into the **same group it came from**. Ids are allocated from global
sequences, so writing them into a different group could collide with rows that
group already owns.
"""
from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, insert, select, text
from sqlalchemy.orm import Session

from app import models

#: Payload layout. Bump when the set of tables or their meaning changes; a
#: restore refuses anything it does not recognise rather than half-applying it.
FORMAT_VERSION = 1

#: Tables in dependency order: a parent is always listed before anything that
#: points at it. Restore inserts in this order and deletes in reverse.
#:
#: `notifications` is excluded on purpose — it is derived state (the bell
#: regenerates 未入力 / 遅延 alerts on next view) and restoring stale unread flags
#: is noise, not history. `backups` is excluded because a restore must not wipe
#: the list of backups you would need to undo it.
TABLE_ORDER: list[str] = [
    "users",
    "sheets",
    "columns",
    "rows",
    "effort_entries",
    "row_milestones",
    "sheet_snapshots",
    "work_logs",
    "row_events",
    "import_presets",
]

_MODELS = {
    "users": models.User,
    "sheets": models.Sheet,
    "columns": models.Column,
    "rows": models.Row,
    "effort_entries": models.EffortEntry,
    "row_milestones": models.RowMilestone,
    "sheet_snapshots": models.SheetSnapshot,
    "work_logs": models.WorkLog,
    "row_events": models.RowEvent,
    "import_presets": models.ImportPreset,
}


def _json_safe(v: Any) -> Any:
    """Values Postgres hands back that JSON cannot hold as-is.

    The fallback matters: the payload is stored as JSONB and measured with
    json.dumps, so a single unconvertible value anywhere would fail the whole
    backup. Anything unexpected degrades to its string form rather than blowing
    up — a column type we did not anticipate should not cost the user a backup.
    """
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).decode("utf-8", "replace")
    if isinstance(v, dict):
        return {str(k): _json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_json_safe(x) for x in v]
    return str(v)


def _scope(name: str, org_id: int):
    """WHERE clause selecting one org's slice of a table.

    Some tables carry `org_id` directly; the rest are reached through their
    sheet or row, so the whole graph is org-scoped even where the column is not.
    """
    sheets = select(models.Sheet.id).where(models.Sheet.org_id == org_id).scalar_subquery()
    rows = (
        select(models.Row.id)
        .where(models.Row.sheet_id.in_(sheets))
        .scalar_subquery()
    )
    m = _MODELS[name]
    if name in ("users", "sheets", "work_logs", "row_events", "import_presets"):
        return m.org_id == org_id
    if name in ("columns", "sheet_snapshots"):
        return m.sheet_id.in_(sheets)
    if name in ("rows",):
        return m.sheet_id.in_(sheets)
    if name in ("effort_entries", "row_milestones"):
        return m.row_id.in_(rows)
    raise KeyError(name)  # pragma: no cover - guarded by TABLE_ORDER


class BackupError(Exception):
    """A backup that could not be taken. The message is shown to the user."""


def _read_failure_message(table: str, exc: Exception) -> str:
    """Turn a read failure into something the reader can act on.

    A missing table means the database is behind the code — the usual shape of
    this is a container whose source was updated in place (bind mount) but never
    restarted, so the entrypoint's `alembic upgrade head` never ran. Reporting
    the raw psycopg error leaves the user to work that out; naming the fix does
    not. A backup must NOT quietly skip the table instead: a backup that claims
    to be complete but is not is worse than no backup at all.
    """
    if "UndefinedTable" in type(exc).__name__ or "does not exist" in str(exc):
        return (
            f"データベースの更新（マイグレーション）が完了していないため、"
            f"バックアップを取れません。テーブル「{table}」がありません。\n"
            f"backend を再起動すると自動で適用されます："
            f"docker compose restart backend"
            f"（手動なら docker compose exec backend alembic upgrade head）。\n"
            f"※ 不完全なバックアップを作ると復元時にデータを失うため、"
            f"あえて中断しています。"
        )
    return f"「{table}」の読み出しに失敗しました: {type(exc).__name__}: {exc}"


class RestoreError(Exception):
    """A backup that cannot be applied. The message is shown to the user."""


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
def export_org(db: Session, org_id: int) -> dict:
    """Everything needed to rebuild this group, keyed by table name."""
    org = db.get(models.Organization, org_id)
    if org is None:
        raise ValueError("Organization not found")

    tables: dict[str, list[dict]] = {}
    for name in TABLE_ORDER:
        t = _MODELS[name].__table__
        # Keys are taken from the table definition, not from the result mapping,
        # so they are guaranteed to be plain strings — a non-string key would
        # make the payload unserialisable as JSON and fail the whole backup.
        keys = [c.name for c in t.columns]
        try:
            result = db.execute(select(t).where(_scope(name, org_id))).all()
        except Exception as exc:  # pragma: no cover - surfaced to the user
            db.rollback()  # the failed statement poisons the transaction
            raise BackupError(_read_failure_message(name, exc)) from exc
        tables[name] = [
            {k: _json_safe(v) for k, v in zip(keys, row)} for row in result
        ]

    return {
        "format_version": FORMAT_VERSION,
        "created_at": datetime.now().astimezone().isoformat(),
        # The group this came from. A restore checks it — see the module docstring.
        "org_id": org_id,
        "org": {
            "name": org.name,
            "slug": org.slug,
            "settings": org.settings or {},
        },
        "tables": tables,
    }


def summarize(payload: dict) -> dict:
    """Row counts per table, for showing what a backup holds without loading it."""
    tables = payload.get("tables") or {}
    out = {name: len(tables.get(name) or []) for name in TABLE_ORDER}
    out["members"] = out.get("users", 0)
    return out


def payload_size(payload: dict) -> int:
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def _coerce_for_insert(table, row: dict) -> dict:
    """Turn a payload row back into values the columns actually accept.

    Export flattens dates and timestamps to ISO strings so the payload is JSON.
    Feeding those strings straight back into a Date / DateTime column relies on
    the driver silently casting text, which is not something to depend on — so
    they are parsed back into real date/datetime objects here.
    """
    out = dict(row)
    for col in table.columns:
        v = out.get(col.name)
        if not isinstance(v, str) or v == "":
            continue
        py = None
        try:
            py = col.type.python_type
        except NotImplementedError:  # JSONB and friends have no python_type
            continue
        try:
            if py is datetime:
                out[col.name] = datetime.fromisoformat(v)
            elif py is date:
                out[col.name] = date.fromisoformat(v)
        except ValueError:
            # Leave it as-is and let the database complain with a real message
            # rather than guessing at a value.
            pass
    return out


# --------------------------------------------------------------------------- #
# Restore
# --------------------------------------------------------------------------- #
def validate(payload: dict, org_id: int) -> None:
    """Refuse anything that would apply partially or land in the wrong group."""
    if not isinstance(payload, dict) or "tables" not in payload:
        raise RestoreError("バックアップファイルの形式が正しくありません")
    version = payload.get("format_version")
    if version != FORMAT_VERSION:
        raise RestoreError(
            f"このバックアップの形式（v{version}）はこのバージョンでは復元できません"
            f"（対応: v{FORMAT_VERSION}）"
        )
    if payload.get("org_id") != org_id:
        raise RestoreError(
            "別のグループで作成されたバックアップは復元できません"
            "（IDをそのまま書き戻すため、他グループのデータと衝突します）"
        )
    tables = payload["tables"]
    missing = [t for t in TABLE_ORDER if t not in tables]
    if missing:
        raise RestoreError(f"バックアップに含まれていないデータがあります：{'、'.join(missing)}")
    # An org with no admin can never be managed again — including taking the next
    # backup or undoing this restore.
    if not any(u.get("role") == "admin" for u in tables.get("users") or []):
        raise RestoreError("このバックアップには管理者アカウントが含まれていないため復元できません")


def restore_org(db: Session, org_id: int, payload: dict) -> dict:
    """Replace this group's data with the backup's, keeping the original ids.

    Does NOT commit — the caller owns the transaction, so a failure anywhere
    leaves the group exactly as it was.
    """
    validate(payload, org_id)
    tables = payload["tables"]

    # 1. Clear the group. Children first, mirroring TABLE_ORDER.
    #    Notifications are not in the payload but DO reference users, so they are
    #    dropped here; the bell rebuilds them on next view.
    db.execute(delete(models.Notification).where(models.Notification.org_id == org_id))
    for name in reversed(TABLE_ORDER):
        db.execute(delete(_MODELS[name].__table__).where(_scope(name, org_id)))
    db.flush()

    # 2. The org row itself is updated in place (its id is the scope key).
    org = db.get(models.Organization, org_id)
    if org is not None:
        info = payload.get("org") or {}
        org.name = info.get("name", org.name)
        org.settings = info.get("settings") or {}

    # 3. Re-insert with the original primary keys.
    counts: dict[str, int] = {}
    for name in TABLE_ORDER:
        t = _MODELS[name].__table__
        data = [_coerce_for_insert(t, r) for r in (tables.get(name) or [])]
        counts[name] = len(data)
        if not data:
            continue
        if name == "rows":
            # rows.parent_row_id is a self-FK checked per row, so a subtask must
            # not be inserted before its parent.
            data.sort(key=lambda r: (r.get("parent_row_id") is not None, r.get("id") or 0))
        try:
            db.execute(insert(t), data)
        except Exception as exc:
            raise RestoreError(f"「{name}」の復元に失敗しました: {type(exc).__name__}: {exc}") from exc
    db.flush()

    # 4. Move each sequence past the ids we just wrote, or the next INSERT would
    #    hand out an id that already exists.
    for name in TABLE_ORDER:
        _resync_sequence(db, name)

    # The ORM still holds pre-delete copies of rows we just replaced.
    db.expunge_all()
    return counts


def _resync_sequence(db: Session, table: str) -> None:
    """Point `table`'s id sequence at max(id)+1 across the WHOLE table.

    Not just this group's rows: ids come from one global sequence shared by every
    group, so it has to clear the highest id that exists anywhere.
    """
    db.execute(
        text(
            f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
            f"(SELECT COALESCE(MAX(id), 0) + 1 FROM {table}), false)"
        )
    )
