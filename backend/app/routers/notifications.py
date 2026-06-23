"""In-app notifications (ベル). Cron-free: 未入力 reminders are generated when the
caller fetches the list; schedule-derived alerts are registered by the front end."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Notification, User
from app.notification_service import generate_worklog_missing, register_items
from app.schemas import MarkReadRequest, NotificationOut, NotificationRegister
from app.security import current_user

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

# Cap the list so a long-running org doesn't return thousands.
LIST_LIMIT = 100


@router.get("", response_model=list[NotificationOut])
def list_notifications(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[Notification]:
    # Lazily mint any 未入力 reminders this user has earned since last visit.
    generate_worklog_missing(db, user)
    return list(
        db.execute(
            select(Notification)
            .where(Notification.user_id == user.id)
            # Unread first, then newest.
            .order_by(Notification.read_at.is_(None).desc(), Notification.created_at.desc())
            .limit(LIST_LIMIT)
        ).scalars()
    )


@router.post("/register")
def register(
    payload: NotificationRegister,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    """Register schedule-derived alerts (behind / 逆ザヤ / overrun / milestone超過)
    detected on the front end. Idempotent via dedupe_key."""
    created = register_items(db, user.org_id, payload.items)
    return {"created": created}


@router.post("/mark-read")
def mark_read(
    payload: MarkReadRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    stmt = (
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=now)
    )
    if payload.ids:
        stmt = stmt.where(Notification.id.in_(payload.ids))
    result = db.execute(stmt)
    db.commit()
    return {"updated": result.rowcount or 0}
