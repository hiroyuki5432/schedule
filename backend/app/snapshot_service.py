"""Snapshot capture + diff logic for the change-point feature.

A snapshot records the sheet's row data and effort entries as of a given week.
On sheet access we lazily create a snapshot for the current ISO week if the
latest stored snapshot is older — so per-week change detection works without cron.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Column, EffortEntry, Organization, Row, Sheet, SheetSnapshot
from app.weeks import current_week_start


def _serialize_state(db: Session, sheet: Sheet) -> dict[str, Any]:
    """Build the JSON state blob captured in a snapshot."""
    columns = list(
        db.execute(select(Column).where(Column.sheet_id == sheet.id).order_by(Column.order)).scalars()
    )
    rows = list(db.execute(select(Row).where(Row.sheet_id == sheet.id)).scalars())
    row_ids = [r.id for r in rows]

    effort_by_row: dict[int, list[dict[str, Any]]] = {rid: [] for rid in row_ids}
    if row_ids:
        entries = db.execute(
            select(EffortEntry).where(EffortEntry.row_id.in_(row_ids))
        ).scalars()
        for e in entries:
            effort_by_row.setdefault(e.row_id, []).append(
                {
                    "week_start": e.week_start.isoformat(),
                    "planned_hours": float(e.planned_hours) if e.planned_hours is not None else None,
                    "actual_hours": float(e.actual_hours) if e.actual_hours is not None else None,
                }
            )

    rows_state: dict[str, Any] = {}
    for r in rows:
        rows_state[str(r.id)] = {
            "id": r.id,
            "key_value": r.key_value,
            "data": r.data or {},
            "version": r.version,
            # Manual progress (手入力進捗%) so week-over-week 進捗 diffs work.
            "progress": r.progress,
            "progress_week": r.progress_week.isoformat() if r.progress_week else None,
            "effort": effort_by_row.get(r.id, []),
        }

    return {
        "columns": [
            {"id": c.id, "name": c.name, "type": c.type, "order": c.order} for c in columns
        ],
        "rows": rows_state,
    }


def _org_week_start_weekday(db: Session, org_id: int) -> int:
    org = db.get(Organization, org_id)
    if org and isinstance(org.settings, dict):
        return int(org.settings.get("week_start_weekday", 1))
    return 1


def latest_snapshot(db: Session, sheet_id: int) -> SheetSnapshot | None:
    return db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.sheet_id == sheet_id)
        .order_by(SheetSnapshot.for_week.desc())
        .limit(1)
    ).scalar_one_or_none()


def ensure_current_snapshot(db: Session, sheet: Sheet, today: date | None = None) -> None:
    """Lazily create a snapshot for the current week if the newest one is older.

    Captures the *current* rows + effort as the state of the current week. This is a
    best-effort approximation: if access gaps span multiple weeks, intermediate weeks
    are collapsed (live state cannot be reconstructed), matching SPEC §4.2.
    """
    wsd = _org_week_start_weekday(db, sheet.org_id)
    this_week = current_week_start(wsd, today)
    newest = latest_snapshot(db, sheet.id)
    if newest is not None and newest.for_week >= this_week:
        return
    state = _serialize_state(db, sheet)
    snap = SheetSnapshot(sheet_id=sheet.id, for_week=this_week, state=state)
    db.add(snap)
    db.commit()


def snapshot_as_of(db: Session, sheet: Sheet, week: date) -> dict[str, Any]:
    """Return {rows, effort} from the nearest snapshot <= week, else current state."""
    snap = db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.sheet_id == sheet.id, SheetSnapshot.for_week <= week)
        .order_by(SheetSnapshot.for_week.desc())
        .limit(1)
    ).scalar_one_or_none()

    state = snap.state if snap is not None else _serialize_state(db, sheet)
    rows_state: dict[str, Any] = state.get("rows", {})

    rows_out: list[dict[str, Any]] = []
    effort_out: list[dict[str, Any]] = []
    for rid_str, rstate in rows_state.items():
        rows_out.append(
            {
                "id": rstate.get("id"),
                "key_value": rstate.get("key_value"),
                "data": rstate.get("data", {}),
                "version": rstate.get("version"),
                "progress": rstate.get("progress"),
                "progress_week": rstate.get("progress_week"),
            }
        )
        for e in rstate.get("effort", []):
            effort_out.append({"row_id": rstate.get("id"), **e})

    return {"rows": rows_out, "effort": effort_out}


# Columns whose value changes are tracked as change-points. Date-type columns are
# always tracked; additionally, status columns and any explicitly-monitored ones.
def _monitored_column_ids(db: Session, sheet: Sheet) -> set[int]:
    cols = db.execute(
        select(Column).where(Column.sheet_id == sheet.id)
    ).scalars()
    monitored: set[int] = set()
    for c in cols:
        if c.type in ("date", "status", "dropdown", "member"):
            monitored.add(c.id)
        if isinstance(c.config, dict) and c.config.get("monitored"):
            monitored.add(c.id)
    return monitored


def compute_changes(db: Session, sheet: Sheet, week: date) -> list[dict[str, Any]]:
    """Diff the snapshot at/just-before ``week`` against the previous snapshot.

    Returns a list of {row_id, field, old, new} for monitored columns and row
    additions. Kept intentionally simple per SPEC §4.2.
    """
    snaps = list(
        db.execute(
            select(SheetSnapshot)
            .where(SheetSnapshot.sheet_id == sheet.id, SheetSnapshot.for_week <= week)
            .order_by(SheetSnapshot.for_week.desc())
            .limit(2)
        ).scalars()
    )
    if not snaps:
        return []
    current_state = snaps[0].state
    if len(snaps) < 2:
        # No prior snapshot: every row is "added".
        prev_rows: dict[str, Any] = {}
    else:
        prev_rows = snaps[1].state.get("rows", {})

    cur_rows: dict[str, Any] = current_state.get("rows", {})
    monitored = _monitored_column_ids(db, sheet)
    monitored_keys = {str(cid) for cid in monitored}

    changes: list[dict[str, Any]] = []
    for rid, rstate in cur_rows.items():
        if rid not in prev_rows:
            changes.append(
                {"row_id": rstate.get("id"), "field": "row", "old": None, "new": "added"}
            )
            continue
        prev_data = prev_rows[rid].get("data", {}) or {}
        cur_data = rstate.get("data", {}) or {}
        for col_key in monitored_keys:
            old_v = prev_data.get(col_key)
            new_v = cur_data.get(col_key)
            if old_v != new_v:
                changes.append(
                    {"row_id": rstate.get("id"), "field": col_key, "old": old_v, "new": new_v}
                )
    return changes
