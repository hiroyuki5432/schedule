"""Column CRUD."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_column_for_user, get_sheet_for_user
from app.models import Column, Sheet, User
from app.schemas import ColumnCreate, ColumnOut, ColumnUpdate
from app.security import current_user

router = APIRouter(prefix="/api", tags=["columns"])


@router.get("/sheets/{sheet_id}/columns", response_model=list[ColumnOut])
def list_columns(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[Column]:
    get_sheet_for_user(db, sheet_id, user)
    return list(
        db.execute(
            select(Column).where(Column.sheet_id == sheet_id).order_by(Column.order, Column.id)
        ).scalars()
    )


@router.post("/sheets/{sheet_id}/columns", response_model=ColumnOut, status_code=status.HTTP_201_CREATED)
def create_column(
    sheet_id: int,
    payload: ColumnCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Column:
    get_sheet_for_user(db, sheet_id, user)
    order = payload.order
    if order is None:
        order = db.execute(
            select(func.coalesce(func.max(Column.order), -1)).where(Column.sheet_id == sheet_id)
        ).scalar_one() + 1
    column = Column(
        sheet_id=sheet_id,
        name=payload.name,
        type=payload.type,
        order=order,
        is_key=bool(payload.is_key),
        config=payload.config or {},
    )
    db.add(column)
    db.commit()
    db.refresh(column)
    return column


@router.patch("/columns/{column_id}", response_model=ColumnOut)
def update_column(
    column_id: int,
    payload: ColumnUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Column:
    column = get_column_for_user(db, column_id, user)
    fields = payload.model_dump(exclude_unset=True)
    for key, value in fields.items():
        setattr(column, key, value)
    db.commit()
    db.refresh(column)
    return column


@router.delete("/columns/{column_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_column(
    column_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> Response:
    column = get_column_for_user(db, column_id, user)
    # Clear sheet references to this column if set.
    sheet = db.get(Sheet, column.sheet_id)
    if sheet is not None:
        if sheet.key_column_id == column.id:
            sheet.key_column_id = None
        if sheet.color_basis_column_id == column.id:
            sheet.color_basis_column_id = None
    db.delete(column)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
