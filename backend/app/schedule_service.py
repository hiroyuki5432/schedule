"""Schedule-sheet helpers.

開始日 / 完了日 are real `date` columns (so they appear in the column list and can
be reordered / frozen / sorted like any column), identified by a reserved
``config.sched_role`` of ``"start"`` / ``"end"`` rather than by name (the user may
rename them). They are created lazily on first access and existing rows' legacy
``__sched_start`` / ``__sched_end`` values are copied into them (additive — the old
keys are kept, never deleted).
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Column, Row, Sheet

SCHED_ROLE_START = "start"
SCHED_ROLE_END = "end"
# Legacy reserved row.data keys (pre-column span). Still read as a fallback.
LEGACY_START_KEY = "__sched_start"
LEGACY_END_KEY = "__sched_end"


def sched_columns(db: Session, sheet_id: int) -> tuple[Column | None, Column | None]:
    """Return the (start, end) schedule date columns for a sheet, if present."""
    cols = db.execute(select(Column).where(Column.sheet_id == sheet_id)).scalars().all()
    start = end = None
    for c in cols:
        role = (c.config or {}).get("sched_role")
        if role == SCHED_ROLE_START:
            start = c
        elif role == SCHED_ROLE_END:
            end = c
    return start, end


def ensure_schedule_columns(db: Session, sheet: Sheet) -> None:
    """Make sure a week-grid sheet has its 開始日 / 完了日 columns; create them (and
    migrate legacy span values) the first time. Idempotent and commits on change."""
    if not sheet.has_week_grid:
        return
    cols = db.execute(select(Column).where(Column.sheet_id == sheet.id)).scalars().all()
    have = {(c.config or {}).get("sched_role") for c in cols}
    min_order = min((c.order for c in cols), default=0)

    created: dict[str, Column] = {}
    if SCHED_ROLE_START not in have:
        c = Column(
            sheet_id=sheet.id, name="開始日", type="date",
            order=min_order - 2, config={"sched_role": SCHED_ROLE_START},
        )
        db.add(c)
        created[SCHED_ROLE_START] = c
    if SCHED_ROLE_END not in have:
        c = Column(
            sheet_id=sheet.id, name="完了日", type="date",
            order=min_order - 1, config={"sched_role": SCHED_ROLE_END},
        )
        db.add(c)
        created[SCHED_ROLE_END] = c
    if not created:
        return
    db.flush()

    # Additive migration: copy any legacy span value into the new column key.
    start_id = str(created[SCHED_ROLE_START].id) if SCHED_ROLE_START in created else None
    end_id = str(created[SCHED_ROLE_END].id) if SCHED_ROLE_END in created else None
    for r in db.execute(select(Row).where(Row.sheet_id == sheet.id)).scalars():
        data = dict(r.data or {})
        changed = False
        if start_id and data.get(LEGACY_START_KEY) and not data.get(start_id):
            data[start_id] = data[LEGACY_START_KEY]
            changed = True
        if end_id and data.get(LEGACY_END_KEY) and not data.get(end_id):
            data[end_id] = data[LEGACY_END_KEY]
            changed = True
        if changed:
            r.data = data
    db.commit()
