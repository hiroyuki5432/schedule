"""Excel (.xlsx) export & import for a sheet.

Layout (one worksheet), schedule sheets:
    ID | <attribute columns…(incl 開始日/完了日)> | 進捗(%) | 先行タスク(ID)
       | <◇予定/◇実績 per template milestone…> | <week_start ISO dates…>

- 開始日/完了日 are now real date columns, so they round-trip as ordinary
  attribute columns. Phases are NOT exported — their boundary is derived from the
  ◇ dates + 開始日 on import. Only the sheet's TEMPLATE milestones (既定マイルストン)
  get 予定/実績 columns.
- 進捗 / 先行タスク round-trip too (先行タスク by ID/key_value, resolved after all
  rows are imported, so a clear → re-import fully restores the schedule).
- Export renders human-readable values (member → name). Lookup columns are
  computed, so they export blank and are skipped on import.
- Import upserts by ID (key_value). Weekly cells: past weeks write 実績,
  current/future write 予定 (the same display rule as the grid / CSV export).
"""
from __future__ import annotations

import io
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import Column, EffortEntry, Row, RowMilestone, Sheet, User
from app.schedule_service import ensure_schedule_columns, sched_columns
from app.security import current_user
from app.weeks import current_week_start, week_start_of
from app.worklog_service import org_week_start_weekday

router = APIRouter(prefix="/api/sheets", tags=["excel"])

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

PROGRESS_HEADER = "進捗(%)"
DEPS_HEADER = "先行タスク(ID)"


# --------------------------------------------------------------------------- #
# Template milestone columns
# --------------------------------------------------------------------------- #
def _template_items(sheet: Sheet) -> list[dict]:
    """The sheet's ordered phase/milestone template (既定マイルストン)."""
    return list((sheet.settings or {}).get("default_milestones") or [])


def _template_milestone_cols(sheet: Sheet) -> list[tuple[int, str, str, str]]:
    """For each ◇ in the template: (template_index, name, 予定_header, 実績_header).
    Duplicate names get a ``#N`` suffix so headers stay unique."""
    out: list[tuple[int, str, str, str]] = []
    seen: dict[str, int] = {}
    for i, it in enumerate(_template_items(sheet)):
        if (it.get("kind") or "phase") != "milestone":
            continue
        name = (it.get("name") or "").strip() or f"◇{i + 1}"
        seen[name] = seen.get(name, 0) + 1
        label = name if seen[name] == 1 else f"{name} #{seen[name]}"
        out.append((i, name, f"{label}（予定）", f"{label}（実績）"))
    return out


def _coerce_date_obj(raw) -> date | None:
    """Excel cell → date object, or None."""
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    try:
        return date.fromisoformat(str(raw).strip())
    except ValueError:
        return None


def _reconstruct_milestones(
    items: list[dict],
    predicted: dict[int, date],
    actual: dict[int, date],
    start_iso: str | None,
) -> list[dict]:
    """Rebuild a row's milestones from the template + the imported ◇ dates.
    Phases are recreated with boundaries derived from the preceding ◇ (first → 開始日)."""
    parsed: list[dict] = []
    for i, it in enumerate(items):
        kind = it.get("kind") or "phase"
        name = (it.get("name") or "").strip()
        if kind == "milestone":
            pred = predicted.get(i)
            if pred is None:
                continue  # no planned date for this ◇ → omit it
            parsed.append(
                {
                    "kind": "milestone",
                    "name": name,
                    "boundary_date": pred,
                    "actual_date": actual.get(i),
                    "done": actual.get(i) is not None,
                    "order": i,
                }
            )
        else:
            parsed.append(
                {"kind": "phase", "name": name, "boundary_date": None, "done": False, "actual_date": None, "order": i}
            )

    # Derive phase boundaries: forward-fill from the preceding ◇ (seeded with 開始日),
    # then back-fill any leading phases from the next dated entry.
    try:
        last = date.fromisoformat(start_iso) if start_iso else None
    except ValueError:
        last = None
    for p in parsed:
        if p["kind"] == "milestone":
            last = p["boundary_date"]
        elif p["boundary_date"] is None:
            p["boundary_date"] = last
    nxt = None
    for p in reversed(parsed):
        if p["boundary_date"] is None:
            p["boundary_date"] = nxt
        else:
            nxt = p["boundary_date"]
    return [p for p in parsed if p["boundary_date"] is not None]


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


def _milestones_by_row(db: Session, row_ids: list[int]) -> dict[int, list[RowMilestone]]:
    out: dict[int, list[RowMilestone]] = {}
    if not row_ids:
        return out
    rows = db.execute(
        select(RowMilestone)
        .where(RowMilestone.row_id.in_(row_ids))
        .order_by(RowMilestone.row_id, RowMilestone.order, RowMilestone.boundary_date)
    ).scalars()
    for m in rows:
        out.setdefault(m.row_id, []).append(m)
    return out


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
@router.get("/{sheet_id}/export.xlsx")
def export_xlsx(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> StreamingResponse:
    from openpyxl import Workbook

    sheet = get_sheet_for_user(db, sheet_id, user)
    ensure_schedule_columns(db, sheet)
    columns = list(
        db.execute(
            select(Column).where(Column.sheet_id == sheet.id).order_by(Column.order, Column.id)
        ).scalars()
    )
    rows = list(db.execute(select(Row).where(Row.sheet_id == sheet.id).order_by(Row.id)).scalars())
    row_ids = [r.id for r in rows]
    keyval_by_id = {r.id: (r.key_value or "") for r in rows}

    weeks: list[date] = []
    effort_map: dict[tuple[int, date], EffortEntry] = {}
    milestones_map: dict[int, list[RowMilestone]] = {}
    ms_cols: list[tuple[int, str, str, str]] = []
    if sheet.has_week_grid:
        weeks, effort_map = _sheet_weeks(db, row_ids)
        milestones_map = _milestones_by_row(db, row_ids)
        ms_cols = _template_milestone_cols(sheet)

    member_names = _members_by_id(db, user.org_id)

    wb = Workbook()
    ws = wb.active
    ws.title = (sheet.name or "Sheet")[:31]

    # 進捗 / 先行タスク + one 予定/実績 pair per template ◇ — between attributes and weeks.
    extra_headers: list[str] = []
    if sheet.has_week_grid:
        extra_headers = [PROGRESS_HEADER, DEPS_HEADER]
        for _, _, ph, ah in ms_cols:
            extra_headers += [ph, ah]
    ws.append(
        ["ID"]
        + [c.name for c in columns]
        + extra_headers
        + [w.isoformat() for w in weeks]
    )

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

        extra_vals: list = []
        if sheet.has_week_grid:
            deps_keys = ",".join(
                keyval_by_id.get(pid, "") for pid in (r.depends_on or []) if keyval_by_id.get(pid)
            )
            extra_vals = [r.progress if r.progress is not None else "", deps_keys]
            # Match each template ◇ to the row's milestone of the same name (in order).
            by_name: dict[str, list[RowMilestone]] = {}
            for m in milestones_map.get(r.id, []):
                if m.kind == "milestone":
                    by_name.setdefault(m.name or "", []).append(m)
            for _, name, _ph, _ah in ms_cols:
                queue = by_name.get(name)
                m = queue.pop(0) if queue else None
                extra_vals += [
                    m.boundary_date.isoformat() if m and m.boundary_date else "",
                    m.actual_date.isoformat() if m and m.actual_date else "",
                ]

        week_vals: list = []
        for w in weeks:
            e = effort_map.get((r.id, w))
            if e is None:
                week_vals.append("")
                continue
            val = e.actual_hours if w < today else e.planned_hours
            week_vals.append(_fmt_num(val))
        ws.append([r.key_value or ""] + attr + extra_vals + week_vals)

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
    ensure_schedule_columns(db, sheet)
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
    start_col, _ = sched_columns(db, sheet.id)
    start_col_id = str(start_col.id) if start_col else None
    template_items = _template_items(sheet)

    # Reserved schedule headers → template index + 予定/実績 role.
    ms_label_map: dict[str, tuple[str, int]] = {}
    for ti, _name, ph, ah in _template_milestone_cols(sheet):
        ms_label_map[ph] = ("pred", ti)
        ms_label_map[ah] = ("act", ti)

    # Map each header position (skipping col 0 = ID) to an attribute column, a
    # week_start date, or a reserved schedule column. Unknown/lookup are ignored.
    attr_at: dict[int, Column] = {}
    week_at: dict[int, date] = {}
    ms_pred_at: dict[int, int] = {}  # header idx -> template index (予定)
    ms_act_at: dict[int, int] = {}   # header idx -> template index (実績)
    prog_idx: int | None = None
    deps_idx: int | None = None
    week_weekday = org_week_start_weekday(db, user.org_id)
    for idx, name in enumerate(header):
        if idx == 0 or name is None:
            continue
        nm = str(name).strip()
        col = col_by_name.get(nm)
        if col is not None:
            if col.type != "lookup":
                attr_at[idx] = col
            continue
        if sheet.has_week_grid:
            if nm == PROGRESS_HEADER:
                prog_idx = idx
                continue
            if nm == DEPS_HEADER:
                deps_idx = idx
                continue
            if nm in ms_label_map:
                role, ti = ms_label_map[nm]
                (ms_pred_at if role == "pred" else ms_act_at)[idx] = ti
                continue
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
    cur_week = current_week_start(week_weekday)
    created = updated = 0
    deps_to_resolve: list[tuple[Row, list[str]]] = []

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

        # 進捗(%)
        if prog_idx is not None and prog_idx < len(raw_row):
            pv = raw_row[prog_idx]
            if pv is not None and str(pv).strip() != "":
                try:
                    row.progress = max(0, min(100, int(float(pv))))
                    row.progress_week = cur_week
                except (TypeError, ValueError):
                    pass

        # 先行タスク(ID) — resolved to row ids after all rows exist.
        if deps_idx is not None and deps_idx < len(raw_row):
            dv = raw_row[deps_idx]
            if dv is not None and str(dv).strip() != "":
                deps_to_resolve.append(
                    (row, [s.strip() for s in str(dv).split(",") if s.strip()])
                )

        # ◇予定/◇実績 → rebuild this row's milestones from the template.
        predicted: dict[int, date] = {}
        actual: dict[int, date] = {}
        for idx, ti in ms_pred_at.items():
            if idx < len(raw_row):
                d = _coerce_date_obj(raw_row[idx])
                if d:
                    predicted[ti] = d
        for idx, ti in ms_act_at.items():
            if idx < len(raw_row):
                d = _coerce_date_obj(raw_row[idx])
                if d:
                    actual[ti] = d
        if predicted or actual:
            db.execute(delete(RowMilestone).where(RowMilestone.row_id == row.id))
            db.flush()
            start_iso = data.get(start_col_id) if start_col_id else None
            for kw in _reconstruct_milestones(template_items, predicted, actual, start_iso):
                db.add(RowMilestone(row_id=row.id, **kw))

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

    # Resolve 先行タスク (key_value → row id, first match in the sheet).
    if deps_to_resolve:
        db.flush()
        keymap: dict[str, int] = {}
        for r in db.execute(
            select(Row).where(Row.sheet_id == sheet.id).order_by(Row.id)
        ).scalars():
            if r.key_value is not None:
                keymap.setdefault(r.key_value, r.id)
        for r, keys in deps_to_resolve:
            r.depends_on = [keymap[k] for k in keys if k in keymap]

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
