"""Sheet CRUD + bundled detail fetch."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import (
    Column,
    EffortEntry,
    Row,
    RowMilestone,
    Sheet,
    SheetSnapshot,
    User,
    WorkLog,
)
from app.schedule_service import ensure_schedule_columns
from app.schemas import SheetCreate, SheetDetailOut, SheetOut, SheetUpdate
from app.security import current_user, require_admin
from app.snapshot_service import ensure_current_snapshot

router = APIRouter(prefix="/api/sheets", tags=["sheets"])


def clear_sheet_rows(db: Session, sheet: Sheet) -> int:
    """Delete every row of a sheet (and its weekly effort, milestones and weekly
    snapshots) while KEEPING the sheet, its columns and all settings. Resets the
    auto-numbering counter to 1 so re-imports start fresh.

    Children are removed explicitly (not via DB cascade) so the behaviour is the
    same regardless of FK-cascade enforcement. Work-log rows are kept but their
    task link is nulled (実績の履歴は残す). Returns the number of rows deleted.

    Does NOT commit — the caller commits (so the org-wide clear is one transaction).
    """
    row_ids_subq = select(Row.id).where(Row.sheet_id == sheet.id).scalar_subquery()
    deleted = db.execute(
        select(func.count()).select_from(Row).where(Row.sheet_id == sheet.id)
    ).scalar_one()

    db.execute(delete(EffortEntry).where(EffortEntry.row_id.in_(row_ids_subq)))
    db.execute(delete(RowMilestone).where(RowMilestone.row_id.in_(row_ids_subq)))
    db.execute(
        update(WorkLog)
        .where(WorkLog.row_id.in_(row_ids_subq))
        .values(row_id=None)
    )
    db.execute(delete(SheetSnapshot).where(SheetSnapshot.sheet_id == sheet.id))
    db.execute(delete(Row).where(Row.sheet_id == sheet.id))

    rule = dict(sheet.numbering_rule or {})
    rule["next_seq"] = 1
    sheet.numbering_rule = rule
    return deleted


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
        is_master=payload.is_master,
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
    # Ensure the 開始日/完了日 date columns exist (created + migrated on first access).
    ensure_schedule_columns(db, sheet)
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


@router.delete("/{sheet_id}/rows")
def clear_sheet_data(
    sheet_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)
) -> dict:
    """Admin-only. Empty this sheet's data (rows / 工数 / マイルストン / スナップショット)
    while keeping the sheet, its columns and all settings. For repeated import
    testing — the 採番 counter resets to 1."""
    sheet = get_sheet_for_user(db, sheet_id, admin)
    deleted = clear_sheet_rows(db, sheet)
    db.commit()
    return {"deleted": deleted}
