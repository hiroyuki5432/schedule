"""Shared lookup helpers that enforce org-scoping."""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models import Column, Row, Sheet, User


def get_sheet_for_user(db: Session, sheet_id: int, user: User) -> Sheet:
    sheet = db.get(Sheet, sheet_id)
    if sheet is None or sheet.org_id != user.org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sheet not found")
    return sheet


def get_column_for_user(db: Session, column_id: int, user: User) -> Column:
    column = db.get(Column, column_id)
    if column is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Column not found")
    # Ensure the column's sheet belongs to the user's org.
    get_sheet_for_user(db, column.sheet_id, user)
    return column


def get_row_for_user(db: Session, row_id: int, user: User) -> Row:
    row = db.get(Row, row_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Row not found")
    get_sheet_for_user(db, row.sheet_id, user)
    return row
