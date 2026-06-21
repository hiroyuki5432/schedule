"""Daily work-log (日報) → weekly actual rollup.

Each WorkLog line contributes its hours to the linked task's weekly EffortEntry
actual_hours. After any worklog create/update/delete the caller recomputes the
affected (row_id, week_start) totals so the schedule's 実績 stays in sync.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import EffortEntry, Organization, WorkLog
from app.weeks import week_start_of


def org_week_start_weekday(db: Session, org_id: int) -> int:
    org = db.get(Organization, org_id)
    if org and isinstance(org.settings, dict):
        return int(org.settings.get("week_start_weekday", 1))
    return 1


def week_start_for(db: Session, org_id: int, work_date: date) -> date:
    """ISO week start (org-anchored) for a calendar day."""
    return week_start_of(work_date, org_week_start_weekday(db, org_id))


def recompute_actual(db: Session, row_id: int, week_start: date) -> None:
    """Set EffortEntry.actual_hours for (row_id, week_start) = SUM of that week's
    work-log hours. Never touches planned_hours; does not bump version (avoids
    spurious optimistic-lock conflicts on the gantt). Flushes; caller commits.
    """
    week_end = week_start + timedelta(days=7)
    total = db.execute(
        select(func.coalesce(func.sum(WorkLog.hours), 0)).where(
            WorkLog.row_id == row_id,
            WorkLog.work_date >= week_start,
            WorkLog.work_date < week_end,
        )
    ).scalar_one()
    # No (or zero) logs left this week -> clear the derived actual back to None.
    new_actual = total if total else None

    entry = db.execute(
        select(EffortEntry).where(
            EffortEntry.row_id == row_id, EffortEntry.week_start == week_start
        )
    ).scalar_one_or_none()

    if entry is None:
        if new_actual is None:
            return
        db.add(
            EffortEntry(
                row_id=row_id,
                week_start=week_start,
                planned_hours=None,
                actual_hours=new_actual,
                version=1,
            )
        )
    else:
        entry.actual_hours = new_actual
    db.flush()
