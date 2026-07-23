"""Recording and reading the per-task change log (変更履歴).

Every edit that goes through the row / effort endpoints appends one RowEvent per
changed field. Values are stored as already-rendered display strings (member ids
resolved to names, dropdown values as shown) so the history stays readable even
after a column is renamed, retyped or deleted.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Column, Row, RowEvent, User

# Fields that live on the row itself rather than in `data`.
BUILTIN_LABELS = {
    "key_value": "ID",
    "progress": "進捗",
    "depends_on": "先行タスク",
}


def _member_names(db: Session, org_id: int) -> dict[str, str]:
    rows = db.execute(select(User.id, User.name).where(User.org_id == org_id)).all()
    return {str(uid): name for uid, name in rows}


def _fmt(value: Any, column: Column | None, members: dict[str, str]) -> str:
    """Render a stored cell value the way the grid shows it."""
    if value is None or value == "":
        return ""
    if isinstance(value, list):
        return "、".join(str(v) for v in value)
    if column is not None and column.type == "member":
        return members.get(str(value), str(value))
    if isinstance(value, bool):
        return "はい" if value else "いいえ"
    return str(value)


def _label(col_id: str, columns: dict[str, Column]) -> str:
    col = columns.get(str(col_id))
    if col is not None:
        return col.name
    # Internal bookkeeping keys (週次リセットの週スタンプ等) — skip them entirely
    # by returning an empty label; callers drop those entries.
    if str(col_id).startswith("__"):
        return ""
    return str(col_id)


def _columns_by_id(db: Session, sheet_id: int) -> dict[str, Column]:
    cols = db.execute(select(Column).where(Column.sheet_id == sheet_id)).scalars()
    return {str(c.id): c for c in cols}


def record(
    db: Session,
    *,
    user: User,
    row: Row,
    kind: str,
    changes: Iterable[tuple[str, str | None, str | None]],
) -> None:
    """Append one RowEvent per (label, old, new). Does not commit."""
    for label, old, new in changes:
        if not label:
            continue
        db.add(
            RowEvent(
                org_id=user.org_id,
                sheet_id=row.sheet_id,
                row_id=row.id,
                row_key=row.key_value,
                user_id=user.id,
                kind=kind,
                field_label=label[:255],
                old_value=old,
                new_value=new,
            )
        )


def record_row_update(
    db: Session,
    *,
    user: User,
    row: Row,
    new_data: dict[str, Any],
    new_key: str | None,
    new_progress: Any = ...,
    new_depends_on: Any = ...,
) -> None:
    """Diff a row against its incoming update and log every real change.

    Call this BEFORE mutating the row, while `row` still holds the old values.
    """
    columns = _columns_by_id(db, row.sheet_id)
    members = _member_names(db, user.org_id)
    old_data = row.data or {}
    changes: list[tuple[str, str | None, str | None]] = []

    for col_id in set(old_data) | set(new_data):
        before = old_data.get(col_id)
        after = new_data.get(col_id)
        if before == after:
            continue
        label = _label(col_id, columns)
        if not label:
            continue
        col = columns.get(str(col_id))
        changes.append((label, _fmt(before, col, members), _fmt(after, col, members)))

    if new_key is not None and new_key != row.key_value:
        changes.append((BUILTIN_LABELS["key_value"], row.key_value or "", new_key))
    if new_progress is not ... and new_progress != row.progress:
        old_p = "" if row.progress is None else f"{row.progress}%"
        new_p = "" if new_progress is None else f"{new_progress}%"
        changes.append((BUILTIN_LABELS["progress"], old_p, new_p))
    if new_depends_on is not ...:
        before_deps = [str(x) for x in (row.depends_on or [])]
        after_deps = [str(x) for x in (new_depends_on or [])]
        if before_deps != after_deps:
            changes.append(
                (
                    BUILTIN_LABELS["depends_on"],
                    _dep_keys(db, before_deps),
                    _dep_keys(db, after_deps),
                )
            )

    record(db, user=user, row=row, kind="update", changes=changes)


def _dep_keys(db: Session, ids: list[str]) -> str:
    """Render predecessor row ids as their task ids (P26-001 …)."""
    if not ids:
        return ""
    int_ids = [int(x) for x in ids if str(x).isdigit()]
    if not int_ids:
        return "、".join(ids)
    found = db.execute(select(Row.id, Row.key_value).where(Row.id.in_(int_ids))).all()
    by_id = {str(rid): (kv or str(rid)) for rid, kv in found}
    return "、".join(by_id.get(str(i), str(i)) for i in ids)


def record_effort(
    db: Session,
    *,
    user: User,
    row: Row,
    week_start: date,
    field: str,
    old: float | None,
    new: float | None,
) -> None:
    """Log one weekly effort cell change (planned or actual hours)."""
    if _hours(old) == _hours(new):
        return
    what = "予定工数" if field == "planned_hours" else "実績工数"
    record(
        db,
        user=user,
        row=row,
        kind="effort",
        changes=[
            (
                f"{what} {week_start.isoformat()}",
                _hours_text(old),
                _hours_text(new),
            )
        ],
    )


def _hours(v: float | None) -> float:
    return 0.0 if v is None else round(float(v), 2)


def _hours_text(v: float | None) -> str:
    if v is None:
        return ""
    f = float(v)
    return f"{int(f)}h" if f == int(f) else f"{round(f, 2)}h"
