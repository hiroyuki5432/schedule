"""Sheet CRUD + bundled detail fetch."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import Column, Row, Sheet, User
from app.schemas import SheetCreate, SheetDetailOut, SheetOut, SheetUpdate
from app.security import current_user, require_admin
from app.snapshot_service import ensure_current_snapshot

router = APIRouter(prefix="/api/sheets", tags=["sheets"])


@router.get("", response_model=list[SheetOut])
def list_sheets(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[Sheet]:
    return list(
        db.execute(
            select(Sheet).where(Sheet.org_id == user.org_id).order_by(Sheet.order, Sheet.id)
        ).scalars()
    )


@router.post("", response_model=SheetOut, status_code=status.HTTP_201_CREATED)
def create_sheet(
    payload: SheetCreate, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> Sheet:
    max_order = db.execute(
        select(func.coalesce(func.max(Sheet.order), -1)).where(Sheet.org_id == user.org_id)
    ).scalar_one()
    sheet = Sheet(
        org_id=user.org_id,
        name=payload.name,
        has_week_grid=payload.has_week_grid,
        order=max_order + 1,
        numbering_rule={"prefix": "", "digits": 3, "next_seq": 1},
    )
    db.add(sheet)
    db.commit()
    db.refresh(sheet)
    return sheet


@router.get("/{sheet_id}", response_model=SheetDetailOut)
def get_sheet(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> SheetDetailOut:
    sheet = get_sheet_for_user(db, sheet_id, user)
    # Lazily snapshot the current week on access (change-point support).
    ensure_current_snapshot(db, sheet)

    columns = list(
        db.execute(
            select(Column).where(Column.sheet_id == sheet.id).order_by(Column.order, Column.id)
        ).scalars()
    )
    rows = list(
        db.execute(
            select(Row).where(Row.sheet_id == sheet.id).order_by(Row.id)
        ).scalars()
    )
    return SheetDetailOut(
        sheet=SheetOut.model_validate(sheet),
        columns=[c for c in columns],  # type: ignore[misc]
        rows=[r for r in rows],  # type: ignore[misc]
    )


@router.patch("/{sheet_id}", response_model=SheetOut)
def update_sheet(
    sheet_id: int,
    payload: SheetUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Sheet:
    sheet = get_sheet_for_user(db, sheet_id, user)
    fields = payload.model_dump(exclude_unset=True)
    for key, value in fields.items():
        setattr(sheet, key, value)
    db.commit()
    db.refresh(sheet)
    return sheet


@router.delete("/{sheet_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sheet(
    sheet_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)
) -> Response:
    sheet = get_sheet_for_user(db, sheet_id, admin)
    db.delete(sheet)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
