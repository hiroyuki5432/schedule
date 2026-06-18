"""As-of snapshot + change-point diff endpoints."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import User
from app.schemas import ChangeOut, SnapshotOut
from app.security import current_user
from app.snapshot_service import compute_changes, snapshot_as_of
from app.weeks import current_week_start

router = APIRouter(prefix="/api/sheets", tags=["snapshots"])


@router.get("/{sheet_id}/snapshot", response_model=SnapshotOut)
def get_snapshot(
    sheet_id: int,
    week: date | None = Query(default=None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> SnapshotOut:
    sheet = get_sheet_for_user(db, sheet_id, user)
    target_week = week or current_week_start()
    result = snapshot_as_of(db, sheet, target_week)
    return SnapshotOut(rows=result["rows"], effort=result["effort"])


@router.get("/{sheet_id}/changes", response_model=list[ChangeOut])
def get_changes(
    sheet_id: int,
    week: date | None = Query(default=None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[ChangeOut]:
    sheet = get_sheet_for_user(db, sheet_id, user)
    target_week = week or current_week_start()
    changes = compute_changes(db, sheet, target_week)
    return [ChangeOut(**c) for c in changes]
