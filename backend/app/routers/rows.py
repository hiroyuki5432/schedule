"""Row CRUD with auto-numbering and optimistic locking."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_row_for_user, get_sheet_for_user
from app.models import Row, Sheet, User
from app.schemas import RowCreate, RowOut, RowUpdate
from app.security import current_user

router = APIRouter(prefix="/api", tags=["rows"])


def _next_key_value(db: Session, sheet: Sheet) -> str:
    """Generate the next key_value from the sheet numbering rule and advance next_seq."""
    rule = dict(sheet.numbering_rule or {})
    prefix = str(rule.get("prefix", ""))
    digits = int(rule.get("digits", 3))
    next_seq = int(rule.get("next_seq", 1))
    key = f"{prefix}{next_seq:0{digits}d}"
    rule["next_seq"] = next_seq + 1
    sheet.numbering_rule = rule
    return key


@router.get("/sheets/{sheet_id}/rows", response_model=list[RowOut])
def list_rows(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[Row]:
    get_sheet_for_user(db, sheet_id, user)
    return list(
        db.execute(select(Row).where(Row.sheet_id == sheet_id).order_by(Row.id)).scalars()
    )


@router.post("/sheets/{sheet_id}/rows", response_model=RowOut, status_code=status.HTTP_201_CREATED)
def create_row(
    sheet_id: int,
    payload: RowCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Row:
    sheet = get_sheet_for_user(db, sheet_id, user)
    key_value = payload.key_value
    if key_value is None or key_value == "":
        key_value = _next_key_value(db, sheet)

    row = Row(
        sheet_id=sheet_id,
        key_value=key_value,
        data=payload.data or {},
        version=1,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"key_value '{key_value}' already exists in this sheet",
        )
    db.refresh(row)
    return row


@router.patch("/rows/{row_id}")
def update_row(
    row_id: int,
    payload: RowUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    row = get_row_for_user(db, row_id, user)
    if payload.version != row.version:
        # Optimistic-lock conflict: return {detail, current} per API contract.
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=jsonable_encoder(
                {
                    "detail": "Version conflict",
                    "current": RowOut.model_validate(row),
                }
            ),
        )
    if payload.key_value is not None and payload.key_value != row.key_value:
        row.key_value = payload.key_value
    row.data = payload.data
    row.version = row.version + 1
    row.updated_by = user.id
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"detail": f"key_value '{payload.key_value}' already exists in this sheet"},
        )
    db.refresh(row)
    return RowOut.model_validate(row)


@router.delete("/rows/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_row(
    row_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> Response:
    row = get_row_for_user(db, row_id, user)
    db.delete(row)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
