"""Weekly effort entries: range read + per-cell upsert with optimistic locking."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_row_for_user, get_sheet_for_user
from app.models import EffortEntry, Row, User
from app.schemas import EffortOut, EffortUpsert
from app.security import current_user

router = APIRouter(prefix="/api", tags=["effort"])


@router.get("/sheets/{sheet_id}/effort", response_model=list[EffortOut])
def list_effort(
    sheet_id: int,
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None, alias="to"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[EffortEntry]:
    get_sheet_for_user(db, sheet_id, user)
    row_ids = list(
        db.execute(select(Row.id).where(Row.sheet_id == sheet_id)).scalars()
    )
    if not row_ids:
        return []
    stmt = select(EffortEntry).where(EffortEntry.row_id.in_(row_ids))
    if from_ is not None:
        stmt = stmt.where(EffortEntry.week_start >= from_)
    if to is not None:
        stmt = stmt.where(EffortEntry.week_start <= to)
    stmt = stmt.order_by(EffortEntry.row_id, EffortEntry.week_start)
    return list(db.execute(stmt).scalars())


@router.put("/rows/{row_id}/effort/{week_start}")
def upsert_effort(
    row_id: int,
    week_start: date,
    payload: EffortUpsert,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    get_row_for_user(db, row_id, user)
    entry = db.execute(
        select(EffortEntry).where(
            EffortEntry.row_id == row_id, EffortEntry.week_start == week_start
        )
    ).scalar_one_or_none()

    if entry is None:
        # Create. A provided version is ignored for the create case (treated as new).
        entry = EffortEntry(
            row_id=row_id,
            week_start=week_start,
            planned_hours=payload.planned_hours,
            actual_hours=payload.actual_hours,
            version=1,
            updated_by=user.id,
        )
        db.add(entry)
        db.commit()
        db.refresh(entry)
        return EffortOut.model_validate(entry)

    # Update existing: optimistic lock if a version was supplied.
    if payload.version is not None and payload.version != entry.version:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=jsonable_encoder(
                {"detail": "Version conflict", "current": EffortOut.model_validate(entry)}
            ),
        )
    # Only overwrite fields that were explicitly provided.
    provided = payload.model_dump(exclude_unset=True)
    if "planned_hours" in provided:
        entry.planned_hours = payload.planned_hours
    if "actual_hours" in provided:
        entry.actual_hours = payload.actual_hours
    entry.version = entry.version + 1
    entry.updated_by = user.id
    db.commit()
    db.refresh(entry)
    return EffortOut.model_validate(entry)
