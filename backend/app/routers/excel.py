"""Excel (.xlsx) export & import for a sheet.

Layout (one worksheet):
    ID | <attribute column names...> | <week_start ISO dates...>
- Weekly-effort columns are only present for week-grid sheets.
- Export renders human-readable values (member → name). Lookup columns are
  computed, so they are exported blank and skipped on import.
- Import upserts by ID (key_value): a matching row is updated, otherwise a new
  row is created. Weekly cells: past weeks write 実績, current/future write 予定
  (the same display rule as the grid / CSV export).
"""
from __future__ import annotations

import io
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import Column, EffortEntry, Row, Sheet, User
from app.security import current_user
from app.weeks import week_start_of
from app.worklog_service import org_week_start_weekday

router = APIRouter(prefix="/api/sheets", tags=["excel"])

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _members_by_id(db: Session, org_id: int) -> dict[str, str]:
    rows = db.execute(select(User).where(User.org_id == org_id)).scalars()
    return {str(u.id): u.name for u in rows}


def _members_by_name(db: Session, org_id: int) -> dict[str, int]:
    rows = db.execute(select(User).where(User.org_id == org_id)).scalars()
    # First match wins on duplicate names.
    out: dict[str, int] = {}
    for u in rows:
        out.setdefault(u.name, u.id)
    return out


def _fmt_num(value) -> float | str:
    if value is None:
        return ""
    f = float(value)
    return int(f) if f == int(f) else f


def _sheet_weeks(db: Session, row_ids: list[int]) -> tuple[list[date], dict[tuple[int, date], EffortEntry]]:
    weeks: list[date] = []
    effort_map: dict[tuple[int, date], EffortEntry] = {}
    if not row_ids:
        return weeks, effort_map
    entries = list(
        db.execute(
            select(EffortEntry)
            .where(EffortEntry.row_id.in_(row_ids))
            .order_by(EffortEntry.week_start)
        ).scalars()
    )
    weeks = sorted({e.week_start for e in entries})
    for e in entries:
        effort_map[(e.row_id, e.week_start)] = e
    return weeks, effort_map


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
@router.get("/{sheet_id}/export.xlsx")
def export_xlsx(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> StreamingResponse:
    from openpyxl import Workbook

    sheet = get_sheet_for_user(db, sheet_id, user)
    columns = list(
        db.execute(
            select(Column).where(Column.sheet_id == sheet.id).order_by(Column.order, Column.id)
        ).scalars()
    )
    rows = list(db.execute(select(Row).where(Row.sheet_id == sheet.id).order_by(Row.id)).scalars())
    row_ids = [r.id for r in rows]

    weeks: list[date] = []
    effort_map: dict[tuple[int, date], EffortEntry] = {}
    if sheet.has_week_grid:
        weeks, effort_map = _sheet_weeks(db, row_ids)

    member_names = _members_by_id(db, user.org_id)

    wb = Workbook()
    ws = wb.active
    ws.title = (sheet.name or "Sheet")[:31]

    ws.append(["ID"] + [c.name for c in columns] + [w.isoformat() for w in weeks])

    today = date.today()
    for r in rows:
        data = r.data or {}
        attr: list = []
        for c in columns:
            v = data.get(str(c.id))
            if c.type == "lookup":
                attr.append("")  # computed — round-trips as blank
            elif c.type == "member":
                attr.append(member_names.get(str(v), "") if v not in (None, "") else "")
            elif c.type == "number":
                attr.append(_fmt_num(v) if v not in (None, "") else "")
            else:
                attr.append("" if v is None else str(v))
        week_vals: list = []
        for w in weeks:
            e = effort_map.get((r.id, w))
            if e is None:
                week_vals.append("")
                continue
            val = e.actual_hours if w < today else e.planned_hours
            week_vals.append(_fmt_num(val))
        ws.append([r.key_value or ""] + attr + week_vals)

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    filename = f"sheet_{sheet.id}.xlsx"
    return StreamingResponse(
        buffer,
        media_type=_XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #
def _coerce_attr(column: Column, raw, members_by_name: dict[str, int]):
    """Convert an Excel cell to the value stored in row.data for this column."""
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        return None
    if column.type == "member":
        return members_by_name.get(str(raw).strip())
    if column.type == "number":
        try:
            f = float(raw)
            return int(f) if f == int(f) else f
        except (TypeError, ValueError):
            return None
    if column.type == "date":
        if isinstance(raw, (datetime, date)):
            return raw.date().isoformat() if isinstance(raw, datetime) else raw.isoformat()
        return str(raw).strip()
    return str(raw).strip()


def _parse_week_header(raw) -> date | None:
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    if isinstance(raw, str):
        try:
            return date.fromisoformat(raw.strip())
        except ValueError:
            return None
    return None


@router.post("/{sheet_id}/import.xlsx")
def import_xlsx(
    sheet_id: int,
    file: UploadFile,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    from openpyxl import load_workbook

    sheet = get_sheet_for_user(db, sheet_id, user)
    try:
        wb = load_workbook(io.BytesIO(file.file.read()), data_only=True, read_only=True)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Excelファイルを読み込めませんでした（.xlsx 形式をご確認ください）",
        )
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    try:
        header = next(rows_iter)
    except StopIteration:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="空のファイルです")

    columns = list(
        db.execute(
            select(Column).where(Column.sheet_id == sheet.id).order_by(Column.order, Column.id)
        ).scalars()
    )
    col_by_name = {c.name: c for c in columns}

    # Map each header position (skipping col 0 = ID) to either an attribute column
    # or a week_start date. Unknown / lookup headers are ignored.
    attr_at: dict[int, Column] = {}
    week_at: dict[int, date] = {}
    week_weekday = org_week_start_weekday(db, user.org_id)
    for idx, name in enumerate(header):
        if idx == 0:
            continue
        if name is None:
            continue
        col = col_by_name.get(str(name).strip())
        if col is not None:
            if col.type != "lookup":
                attr_at[idx] = col
            continue
        if sheet.has_week_grid:
            wk = _parse_week_header(name)
            if wk is not None:
                week_at[idx] = week_start_of(wk, week_weekday)

    members_by_name = _members_by_name(db, user.org_id)

    # Existing rows by key_value (first match wins, matching lookup semantics).
    existing: dict[str, Row] = {}
    for r in db.execute(select(Row).where(Row.sheet_id == sheet.id).order_by(Row.id)).scalars():
        if r.key_value is not None:
            existing.setdefault(r.key_value, r)

    today = date.today()
    created = updated = 0

    for raw_row in rows_iter:
        if raw_row is None:
            continue
        id_cell = raw_row[0] if len(raw_row) > 0 else None
        key_value = None if id_cell is None else str(id_cell).strip()
        # Skip fully empty lines.
        if not any(v not in (None, "") for v in raw_row):
            continue

        row = existing.get(key_value) if key_value else None
        if row is None:
            if not key_value:
                key_value = _gen_key(db, sheet)
            row = Row(
                sheet_id=sheet.id,
                key_value=key_value,
                data={},
                version=1,
                created_by=user.id,
                updated_by=user.id,
            )
            db.add(row)
            db.flush()
            existing[key_value] = row
            created += 1
        else:
            updated += 1

        data = dict(row.data or {})
        for idx, col in attr_at.items():
            if idx >= len(raw_row):
                continue
            data[str(col.id)] = _coerce_attr(col, raw_row[idx], members_by_name)
        row.data = data
        row.version = (row.version or 1) + 1
        row.updated_by = user.id

        # Weekly effort upsert.
        for idx, wk in week_at.items():
            if idx >= len(raw_row):
                continue
            cell = raw_row[idx]
            if cell is None or (isinstance(cell, str) and cell.strip() == ""):
                continue
            try:
                hours = float(cell)
            except (TypeError, ValueError):
                continue
            entry = db.execute(
                select(EffortEntry).where(
                    EffortEntry.row_id == row.id, EffortEntry.week_start == wk
                )
            ).scalar_one_or_none()
            if entry is None:
                entry = EffortEntry(row_id=row.id, week_start=wk, version=1, updated_by=user.id)
                db.add(entry)
            if wk < today:
                entry.actual_hours = hours
            else:
                entry.planned_hours = hours
            entry.updated_by = user.id

    db.commit()
    return {"created": created, "updated": updated}


def _gen_key(db: Session, sheet: Sheet) -> str:
    """Next key_value from the sheet numbering rule (advances next_seq)."""
    rule = dict(sheet.numbering_rule or {})
    prefix = str(rule.get("prefix", ""))
    digits = int(rule.get("digits", 3))
    next_seq = int(rule.get("next_seq", 1))
    key = f"{prefix}{next_seq:0{digits}d}"
    rule["next_seq"] = next_seq + 1
    sheet.numbering_rule = rule
    return key
