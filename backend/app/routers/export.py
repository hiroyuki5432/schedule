"""CSV export: attribute columns + weekly effort. UTF-8 BOM for Excel."""
from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import Column, EffortEntry, Row, User
from app.security import current_user

router = APIRouter(prefix="/api/sheets", tags=["export"])


@router.get("/{sheet_id}/export.csv")
def export_csv(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> StreamingResponse:
    sheet = get_sheet_for_user(db, sheet_id, user)

    columns = list(
        db.execute(
            select(Column).where(Column.sheet_id == sheet.id).order_by(Column.order, Column.id)
        ).scalars()
    )
    rows = list(db.execute(select(Row).where(Row.sheet_id == sheet.id).order_by(Row.id)).scalars())
    row_ids = [r.id for r in rows]

    # Collect the full set of weeks present across all effort entries (sorted).
    weeks: list[date] = []
    effort_map: dict[tuple[int, date], EffortEntry] = {}
    if row_ids:
        entries = list(
            db.execute(
                select(EffortEntry)
                .where(EffortEntry.row_id.in_(row_ids))
                .order_by(EffortEntry.week_start)
            ).scalars()
        )
        week_set = sorted({e.week_start for e in entries})
        weeks = week_set
        for e in entries:
            effort_map[(e.row_id, e.week_start)] = e

    def iter_csv():
        buffer = io.StringIO()
        writer = csv.writer(buffer)

        header = ["ID"] + [c.name for c in columns] + [w.isoformat() for w in weeks]
        writer.writerow(header)
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)

        today = date.today()
        for r in rows:
            data = r.data or {}
            attr_values = [_render_cell(data.get(str(c.id))) for c in columns]
            week_values = []
            for w in weeks:
                e = effort_map.get((r.id, w))
                if e is None:
                    week_values.append("")
                    continue
                # Past week => actual, current/future => planned (display rule).
                if w < today:
                    val = e.actual_hours
                else:
                    val = e.planned_hours
                week_values.append("" if val is None else _fmt_num(val))
            writer.writerow([r.key_value or ""] + attr_values + week_values)
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    filename = f"sheet_{sheet.id}.csv"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    # Prepend a UTF-8 BOM so Excel detects encoding correctly.
    return StreamingResponse(
        _with_bom(iter_csv()),
        media_type="text/csv; charset=utf-8",
        headers=headers,
    )


def _with_bom(gen):
    yield "﻿"
    yield from gen


def _render_cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        import json

        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _fmt_num(value) -> str:
    f = float(value)
    if f == int(f):
        return str(int(f))
    return str(f)
