"""Weekly effort entries: range read + per-cell upsert with optimistic locking."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import history_service
from app.db import get_db
from app.deps import get_row_for_user, get_sheet_for_user
from app.models import EffortEntry, Row, User
from app.schemas import EffortBulkRequest, EffortOut, EffortUpsert
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
    row = get_row_for_user(db, row_id, user)
    entry = db.execute(
        select(EffortEntry).where(
            EffortEntry.row_id == row_id, EffortEntry.week_start == week_start
        )
    ).scalar_one_or_none()

    provided_fields = payload.model_dump(exclude_unset=True)

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
        for field in ("planned_hours", "actual_hours"):
            if field in provided_fields:
                history_service.record_effort(
                    db,
                    user=user,
                    row=row,
                    week_start=week_start,
                    field=field,
                    old=None,
                    new=provided_fields[field],
                )
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
    for field in ("planned_hours", "actual_hours"):
        if field not in provided_fields:
            continue
        history_service.record_effort(
            db,
            user=user,
            row=row,
            week_start=week_start,
            field=field,
            old=getattr(entry, field),
            new=provided_fields[field],
        )
        setattr(entry, field, provided_fields[field])
    entry.version = entry.version + 1
    entry.updated_by = user.id
    db.commit()
    db.refresh(entry)
    return EffortOut.model_validate(entry)


@router.put("/effort/bulk", response_model=list[EffortOut])
def bulk_upsert_effort(
    payload: EffortBulkRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[EffortOut]:
    """Write many weekly cells at once — one request for a pasted or cleared range.

    Last-write-wins (no per-cell version check): a range paste is a deliberate
    overwrite, and asking the user to resolve 200 individual conflicts would be
    worse than the rare lost concurrent edit. Every cell is still logged to the
    change history so an overwrite can be traced.
    """
    if not payload.items:
        return []
    # Authorize every row once, up front, so a bad id can't write anything.
    rows: dict[int, Row] = {}
    for item in payload.items:
        if item.row_id not in rows:
            rows[item.row_id] = get_row_for_user(db, item.row_id, user)

    keys = {(i.row_id, i.week_start) for i in payload.items}
    existing = {
        (e.row_id, e.week_start): e
        for e in db.execute(
            select(EffortEntry).where(EffortEntry.row_id.in_(rows.keys()))
        ).scalars()
        if (e.row_id, e.week_start) in keys
    }

    out: list[EffortEntry] = []
    for item in payload.items:
        provided = item.model_dump(exclude_unset=True)
        entry = existing.get((item.row_id, item.week_start))
        if entry is None:
            entry = EffortEntry(
                row_id=item.row_id,
                week_start=item.week_start,
                version=1,
                updated_by=user.id,
            )
            db.add(entry)
            existing[(item.row_id, item.week_start)] = entry
        else:
            entry.version = entry.version + 1
            entry.updated_by = user.id
        for field in ("planned_hours", "actual_hours"):
            if field not in provided:
                continue
            history_service.record_effort(
                db,
                user=user,
                row=rows[item.row_id],
                week_start=item.week_start,
                field=field,
                old=getattr(entry, field),
                new=provided[field],
            )
            setattr(entry, field, provided[field])
        out.append(entry)

    db.commit()
    for e in out:
        db.refresh(e)
    return [EffortOut.model_validate(e) for e in out]
