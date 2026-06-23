"""In-app notifications (ベル) — created lazily on access, no cron.

Two sources:
- register_items(): behind / 逆ザヤ / overrun / milestone超過 detected by the front
  end while rendering the schedule, addressed to the task assignee.
- generate_worklog_missing(): for the caller, past business days with no 日報
  (only when the user has worklog_required). Runs on every GET so the reminder
  appears the next time they open the app.

Idempotency: every notification carries a `dedupe_key` unique per user, so
re-running detection never duplicates an existing alert.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from sqlalchemy.orm import Session

from app.models import Notification, User, WorkLog

# How many calendar days back to check for 未入力 (weekdays only are flagged).
WORKLOG_MISSING_LOOKBACK_DAYS = 7


def _upsert(db: Session, rows: list[dict]) -> int:
    """Insert notifications, skipping any whose (user_id, dedupe_key) already
    exists. Returns the number actually created.

    Uses RETURNING to count real inserts: with ON CONFLICT DO NOTHING, psycopg's
    `rowcount` is unreliable (often -1), so we check whether a row came back."""
    if not rows:
        return 0
    created = 0
    for r in rows:
        stmt = (
            pg_insert(Notification)
            .values(**r)
            .on_conflict_do_nothing(constraint="uq_notif_user_dedupe")
            .returning(Notification.id)
        )
        if db.execute(stmt).first() is not None:
            created += 1
    return created


def register_items(db: Session, org_id: int, items: list) -> int:
    """Persist schedule-derived alerts (NotificationItem). Recipients must be in
    the same org. Returns count created (dups skipped)."""
    if not items:
        return 0
    member_ids = {
        u for (u,) in db.execute(select(User.id).where(User.org_id == org_id))
    }
    rows: list[dict] = []
    for it in items:
        if it.target_user_id not in member_ids:
            continue
        rows.append(
            {
                "org_id": org_id,
                "user_id": it.target_user_id,
                "type": it.type,
                "title": it.title,
                "body": it.body,
                "ref_kind": it.ref_kind,
                "ref_id": it.ref_id,
                "dedupe_key": it.dedupe_key,
            }
        )
    n = _upsert(db, rows)
    if n:
        db.commit()
    return n


def generate_worklog_missing(db: Session, user: User, today: date | None = None) -> int:
    """Create 未入力 reminders for the given user's missed past business days.
    No-op when the user isn't worklog_required. Returns count created."""
    if not user.worklog_required:
        return 0
    today = today or date.today()

    start = today - timedelta(days=WORKLOG_MISSING_LOOKBACK_DAYS)
    # Past business days (Mon-Fri) strictly before today (today isn't "missed"
    # yet — they may still log it).
    days: list[date] = []
    d = start
    while d < today:
        if d.weekday() < 5:  # 0=Mon .. 4=Fri
            days.append(d)
        d += timedelta(days=1)
    if not days:
        return 0

    logged = {
        wd
        for (wd,) in db.execute(
            select(WorkLog.work_date).where(
                WorkLog.user_id == user.id,
                WorkLog.work_date >= start,
                WorkLog.work_date < today,
            )
        )
    }
    rows: list[dict] = []
    for d in days:
        if d in logged:
            continue
        iso = d.isoformat()
        rows.append(
            {
                "org_id": user.org_id,
                "user_id": user.id,
                "type": "worklog_missing",
                "title": "日報が未入力です",
                "body": f"{iso} の実績入力がありません。",
                "ref_kind": "worklog_day",
                "ref_id": iso,
                "dedupe_key": f"worklog_missing:{iso}",
            }
        )
    n = _upsert(db, rows)
    if n:
        db.commit()
    return n
