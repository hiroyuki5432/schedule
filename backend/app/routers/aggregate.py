"""Pivot aggregation: group rows by a column value, sum planned/actual hours."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import Column, EffortEntry, Row, User
from app.schemas import AggregateRow
from app.security import current_user

router = APIRouter(prefix="/api/sheets", tags=["aggregate"])


@router.get("/{sheet_id}/aggregate", response_model=list[AggregateRow])
def aggregate(
    sheet_id: int,
    group_by: int = Query(..., description="column id to group rows by"),
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None, alias="to"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[AggregateRow]:
    sheet = get_sheet_for_user(db, sheet_id, user)

    group_col = db.get(Column, group_by)
    if group_col is None or group_col.sheet_id != sheet.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="group_by column not found")
    col_key = str(group_col.id)

    rows = list(db.execute(select(Row).where(Row.sheet_id == sheet.id)).scalars())
    row_by_id = {r.id: r for r in rows}
    row_ids = list(row_by_id.keys())

    # Sum effort per row over the optional week range.
    planned_by_row: dict[int, float] = {rid: 0.0 for rid in row_ids}
    actual_by_row: dict[int, float] = {rid: 0.0 for rid in row_ids}
    if row_ids:
        stmt = select(EffortEntry).where(EffortEntry.row_id.in_(row_ids))
        if from_ is not None:
            stmt = stmt.where(EffortEntry.week_start >= from_)
        if to is not None:
            stmt = stmt.where(EffortEntry.week_start <= to)
        for e in db.execute(stmt).scalars():
            planned_by_row[e.row_id] += float(e.planned_hours or 0)
            actual_by_row[e.row_id] += float(e.actual_hours or 0)

    # Group by the column value found in row.data[col_key].
    groups: dict[str, dict[str, float | int]] = {}
    order: list[str] = []
    for r in rows:
        raw = (r.data or {}).get(col_key)
        group_key = "" if raw is None else str(raw)
        if group_key not in groups:
            groups[group_key] = {"planned_sum": 0.0, "actual_sum": 0.0, "count": 0}
            order.append(group_key)
        g = groups[group_key]
        g["planned_sum"] += planned_by_row.get(r.id, 0.0)
        g["actual_sum"] += actual_by_row.get(r.id, 0.0)
        g["count"] = int(g["count"]) + 1

    return [
        AggregateRow(
            group=key if key != "" else None,
            planned_sum=round(float(groups[key]["planned_sum"]), 2),
            actual_sum=round(float(groups[key]["actual_sum"]), 2),
            count=int(groups[key]["count"]),
        )
        for key in order
    ]
