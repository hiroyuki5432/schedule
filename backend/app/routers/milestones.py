"""Row milestones (phase boundaries). GET list + PUT full-replace."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_row_for_user, get_sheet_for_user
from app.models import Row, RowMilestone, User
from app.schemas import MilestoneIn, MilestoneOut
from app.security import current_user

router = APIRouter(prefix="/api", tags=["milestones"])


@router.get("/sheets/{sheet_id}/milestones", response_model=list[MilestoneOut])
def list_sheet_milestones(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[RowMilestone]:
    """All milestones for every row in a sheet, in one query (avoids the N+1
    per-row fetch the schedule used to do — big load-time win)."""
    get_sheet_for_user(db, sheet_id, user)
    return list(
        db.execute(
            select(RowMilestone)
            .join(Row, Row.id == RowMilestone.row_id)
            .where(Row.sheet_id == sheet_id)
            .order_by(RowMilestone.row_id, RowMilestone.order, RowMilestone.boundary_date)
        ).scalars()
    )


@router.get("/rows/{row_id}/milestones", response_model=list[MilestoneOut])
def list_milestones(
    row_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[RowMilestone]:
    get_row_for_user(db, row_id, user)
    return list(
        db.execute(
            select(RowMilestone)
            .where(RowMilestone.row_id == row_id)
            .order_by(RowMilestone.order, RowMilestone.boundary_date)
        ).scalars()
    )


@router.put("/rows/{row_id}/milestones", response_model=list[MilestoneOut])
def replace_milestones(
    row_id: int,
    payload: list[MilestoneIn],
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[RowMilestone]:
    get_row_for_user(db, row_id, user)
    # Full replace.
    existing = db.execute(
        select(RowMilestone).where(RowMilestone.row_id == row_id)
    ).scalars()
    for m in existing:
        db.delete(m)
    db.flush()

    created: list[RowMilestone] = []
    for idx, item in enumerate(payload):
        m = RowMilestone(
            row_id=row_id,
            name=item.name,
            kind=item.kind,
            boundary_date=item.boundary_date,
            color=item.color,
            order=item.order if item.order is not None else idx,
            done=item.done,
            actual_date=item.actual_date,
        )
        db.add(m)
        created.append(m)
    db.commit()
    for m in created:
        db.refresh(m)
    created.sort(key=lambda x: (x.order, x.boundary_date))
    return created
