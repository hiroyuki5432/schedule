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
import json
from datetime import date, datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, select
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


def _span_weeks(
    rows: list[Row], columns: list[Column], week_weekday: int
) -> list[date]:
    """Week columns to OUTPUT so 工数 can be entered even before any effort exists.

    Spans the rows' 開始日〜完了日 (sched_role columns). With no dated rows, falls back
    to a window around today so a fresh sheet still exports fillable week columns.
    Without this, export derives weeks only from existing EffortEntry rows, so an
    empty sheet has no week columns and 工数 can never be imported (要望: 工数Excel取込)."""
    start_col = next((c for c in columns if (c.config or {}).get("sched_role") == "start"), None)
    end_col = next((c for c in columns if (c.config or {}).get("sched_role") == "end"), None)
    dates: list[date] = []
    for r in rows:
        data = r.data or {}
        for col in (start_col, end_col):
            if col is None:
                continue
            d = _coerce_date_obj(data.get(str(col.id)))
            if d is not None:
                dates.append(d)
    today = date.today()
    if dates:
        lo, hi = min(dates), max(dates)
    else:
        lo, hi = today - timedelta(weeks=4), today + timedelta(weeks=12)
    w = week_start_of(lo, week_weekday)
    end = week_start_of(hi, week_weekday)
    out: list[date] = []
    while w <= end:
        out.append(w)
        w += timedelta(days=7)
    return out


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
        # Always export a fillable week range (spanning rows' 開始日〜完了日), unioned
        # with the weeks that already hold effort — so 工数 can be entered & imported
        # even on a sheet with no effort yet.
        week_weekday = org_week_start_weekday(db, user.org_id)
        weeks = sorted(set(weeks) | set(_span_weeks(rows, columns, week_weekday)))

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


def _load_active_sheet(file: UploadFile):
    """Read an uploaded .xlsx and return (worksheet, header tuple, row iterator)."""
    from openpyxl import load_workbook

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
    return ws, header, rows_iter


@router.post("/{sheet_id}/import.xlsx")
def import_xlsx(
    sheet_id: int,
    file: UploadFile,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    sheet = get_sheet_for_user(db, sheet_id, user)
    ensure_schedule_columns(db, sheet)
    _ws, header, rows_iter = _load_active_sheet(file)
    return _import_rows(db, user, sheet, header, rows_iter)


def _import_rows(db: Session, user: User, sheet: Sheet, header, rows_iter) -> dict:
    """Upsert rows (by ID) from an already-opened worksheet into `sheet`."""
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


# --------------------------------------------------------------------------- #
# Import as a NEW sheet (シートごとExcelから取り込む)
# --------------------------------------------------------------------------- #
_DROPDOWN_MAX_OPTIONS = 20
# Palette reused from the dropdown options editor, so inferred lists look native.
_SWATCHES = [
    "#E3EFEA", "#EFEDE4", "#FAE6E0", "#E6F0DB",
    "#CBD9EE", "#F1DBAC", "#E7DDEA", "#DCE6EA",
]


_PREVIEW_ROWS = 30          # raw rows returned for the 見出し行 picker
_HEADER_SCAN_ROWS = 10      # how far down we look for the header row
_SAMPLE_LIMIT = 4           # sample values shown per column
_INFER_ROWS = 200           # rows sampled for type inference
_MAX_DROPDOWN_FORCED = 50   # cap when the user forces a dropdown by hand
_IMPORTABLE_TYPES = {"text", "number", "date", "dropdown", "member"}


def _open_workbook(file: UploadFile):
    from openpyxl import load_workbook

    try:
        return load_workbook(io.BytesIO(file.file.read()), data_only=True, read_only=True)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Excelファイルを読み込めませんでした（.xlsx 形式をご確認ください）",
        )


def _pick_worksheet(wb, sheet_name: str):
    nm = (sheet_name or "").strip()
    if not nm:
        return wb.active
    if nm not in wb.sheetnames:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"ワークシート「{nm}」が見つかりません",
        )
    return wb[nm]


def _grid(ws) -> list[tuple]:
    return list(ws.iter_rows(values_only=True))


def _is_blank(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def _auto_header_row(grid: list[tuple]) -> int:
    """1-based guess at the header row: the topmost of the first rows with the most
    filled cells — files often open with a title line or a blank row or two."""
    best_i, best_n = 1, -1
    for i, row in enumerate(grid[:_HEADER_SCAN_ROWS], start=1):
        n = sum(0 if _is_blank(v) else 1 for v in row)
        if n > best_n:
            best_i, best_n = i, n
    return best_i


def _split_grid(grid: list[tuple], header_row: int) -> tuple[tuple, list[tuple]]:
    """(header tuple, data rows below it) — fully empty data lines dropped."""
    header = grid[header_row - 1] if 0 < header_row <= len(grid) else ()
    body = [r for r in grid[header_row:] if r is not None and any(not _is_blank(v) for v in r)]
    return header, body


def _cell_text(v) -> str:
    """Display text for a preview cell."""
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.date().isoformat() if (v.hour, v.minute, v.second) == (0, 0, 0) else v.isoformat(sep=" ")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v).strip() if isinstance(v, str) else str(v)


def _header_role(raw_name, has_week_grid: bool) -> str:
    """What a header means on a schedule sheet: attr / week / progress / deps /
    milestone. Only 'attr' (and an explicitly selected 'milestone') becomes a column;
    the rest are handled by the row importer under their reserved names."""
    if not has_week_grid:
        return "attr"
    nm = str(raw_name).strip()
    if nm == PROGRESS_HEADER:
        return "progress"
    if nm == DEPS_HEADER:
        return "deps"
    if _parse_week_header(raw_name) is not None:
        return "week"
    if nm.endswith("（予定）") or nm.endswith("（実績）"):
        return "milestone"
    return "attr"


def _column_values(data_rows: list[tuple], idx: int, limit: int = _INFER_ROWS) -> list:
    return [r[idx] if idx < len(r) else None for r in data_rows[:limit]]


def _looks_numeric(v) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    try:
        float(str(v).strip())
        return True
    except (TypeError, ValueError):
        return False


def _infer_type(values: list, member_names: set[str]) -> tuple[str, dict]:
    """Guess a column type from its sample values. Returns (type, config)."""
    vals = [v for v in values if v is not None and str(v).strip() != ""]
    if not vals:
        return "text", {}
    strs = [str(v).strip() for v in vals]

    if all(_coerce_date_obj(v) is not None for v in vals):
        return "date", {}
    if all(_looks_numeric(v) for v in vals):
        return "number", {}
    # Every value naming an org member → 担当者 column.
    if member_names and all(s in member_names for s in strs):
        return "member", {}

    distinct = sorted(set(strs))
    # A short, repeating set of labels is a pick-list, not free text: at most 20
    # distinct values, and they must cover no more than 2/3 of the rows (so a
    # column of mostly-unique free text stays text).
    if 1 < len(distinct) <= _DROPDOWN_MAX_OPTIONS and len(distinct) * 3 <= len(strs) * 2:
        options = [
            {"id": uuid4().hex, "value": v, "color": _SWATCHES[i % len(_SWATCHES)]}
            for i, v in enumerate(distinct)
        ]
        return "dropdown", {"options": options}
    return "text", {}


def _dropdown_config(values: list) -> dict:
    """Options for a column the user explicitly typed as プルダウン."""
    distinct = sorted({str(v).strip() for v in values if not _is_blank(v)})[:_MAX_DROPDOWN_FORCED]
    return {
        "options": [
            {"id": uuid4().hex, "value": v, "color": _SWATCHES[i % len(_SWATCHES)]}
            for i, v in enumerate(distinct)
        ]
    }


def _parse_selection(raw: str) -> list[dict] | None:
    """`columns` form field → [{index, name, type}] (None when not supplied)."""
    if not (raw or "").strip():
        return None
    try:
        items = json.loads(raw)
    except ValueError:
        items = None
    if not isinstance(items, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="取り込む列の指定を読み取れませんでした"
        )
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            idx = int(it.get("index"))
        except (TypeError, ValueError):
            continue
        out.append(
            {
                "index": idx,
                "name": str(it.get("name") or "").strip(),
                "type": str(it.get("type") or "").strip(),
            }
        )
    return out


def _default_selection(
    header: tuple, data_rows: list[tuple], id_column: int, has_week_grid: bool, member_names: set[str]
) -> list[dict]:
    """What the wizard proposes (and what an unattended import uses): every named
    column except the ID one, with its type inferred. ◇予定/◇実績 are left out —
    a brand-new sheet has no milestone template to hang them on."""
    sel: list[dict] = []
    for idx, raw_name in enumerate(header):
        if idx == id_column or _is_blank(raw_name):
            continue
        nm = str(raw_name).strip()
        role = _header_role(raw_name, has_week_grid)
        if role == "milestone":
            continue
        ctype = ""
        if role == "attr":
            ctype, _cfg = _infer_type(_column_values(data_rows, idx), member_names)
        sel.append({"index": idx, "name": nm, "type": ctype})
    return sel


def _invalid_values(values: list, role: str, ctype: str, member_names: set[str]) -> list[str]:
    """Cells that would be dropped or blanked on import, given the effective type."""
    bad: list[str] = []
    for v in values:
        if _is_blank(v):
            continue
        ok = True
        if role in ("week", "progress"):
            ok = _looks_numeric(v)
        elif role == "attr" or role == "milestone":
            if ctype == "date":
                ok = _coerce_date_obj(v) is not None
            elif ctype == "number":
                ok = _looks_numeric(v)
            elif ctype == "member":
                ok = str(v).strip() in member_names
        if not ok:
            bad.append(_cell_text(v))
    return bad


@router.post("/import.xlsx/inspect")
def inspect_import_xlsx(
    file: UploadFile,
    sheet_name: str = Form(default=""),
    header_row: int = Form(default=0),
    id_column: int = Form(default=0),
    has_week_grid: bool = Form(default=True),
    columns: str = Form(default=""),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Analyse an .xlsx without writing anything — the 取り込みウィザード's data source.

    Returns the workbook's worksheets, a raw preview of the chosen one (for picking
    the 見出し行 / ID列), and one entry per header column: its role on a schedule
    sheet, the guessed type, sample values and how many cells would NOT survive the
    conversion. Pass `columns` (the same JSON the import takes) to re-check the
    counts against the user's own choices before committing.
    """
    wb = _open_workbook(file)
    ws = _pick_worksheet(wb, sheet_name)
    grid = _grid(ws)
    if not grid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="空のファイルです")

    suggested = _auto_header_row(grid)
    hr = header_row if header_row > 0 else suggested
    hr = min(hr, len(grid))
    header, data_rows = _split_grid(grid, hr)

    member_names = set(_members_by_name(db, user.org_id).keys())
    chosen = _parse_selection(columns)
    by_index = {it["index"]: it for it in (chosen or [])}

    cols: list[dict] = []
    for idx, raw_name in enumerate(header):
        nm = _cell_text(raw_name)
        role = _header_role(raw_name, has_week_grid) if nm else "attr"
        values = _column_values(data_rows, idx)
        picked = by_index.get(idx)
        if role == "attr" or (picked and role == "milestone"):
            inferred, cfg = _infer_type(values, member_names)
        else:
            inferred, cfg = "", {}
        ctype = (picked or {}).get("type") or inferred
        if ctype not in _IMPORTABLE_TYPES:
            ctype = inferred
        filled = [v for v in values if not _is_blank(v)]
        bad = _invalid_values(values, role, ctype, member_names)
        selected = (
            idx in by_index
            if chosen is not None
            else (idx != id_column and bool(nm) and role != "milestone")
        )
        cols.append(
            {
                "index": idx,
                "header": nm,
                "role": role,
                "type": ctype,
                "selected": selected and idx != id_column,
                "filled": len(filled),
                "samples": [_cell_text(v) for v in filled[:_SAMPLE_LIMIT]],
                "options": [o["value"] for o in (cfg.get("options") or [])],
                "invalid": len(bad),
                "invalid_samples": bad[:_SAMPLE_LIMIT],
            }
        )

    ids = [
        _cell_text(r[id_column]) if 0 <= id_column < len(r) else "" for r in data_rows
    ] if id_column >= 0 else []
    seen: set[str] = set()
    duplicate_ids = 0
    for k in ids:
        if not k:
            continue
        if k in seen:
            duplicate_ids += 1
        seen.add(k)

    return {
        "worksheets": [
            {"name": s.title, "rows": s.max_row or 0, "columns": s.max_column or 0}
            for s in wb.worksheets
        ],
        "sheet_name": ws.title,
        "header_row": hr,
        "suggested_header_row": suggested,
        "id_column": id_column,
        "total_rows": len(data_rows),
        "preview": [
            {"row": i, "cells": [_cell_text(v) for v in row]}
            for i, row in enumerate(grid[:_PREVIEW_ROWS], start=1)
        ],
        "columns": cols,
        "blank_ids": sum(1 for k in ids if not k),
        "duplicate_ids": duplicate_ids,
    }


@router.post("/import.xlsx", status_code=status.HTTP_201_CREATED)
def import_new_sheet_xlsx(
    file: UploadFile,
    name: str = Form(default=""),
    has_week_grid: bool = Form(default=True),
    sheet_name: str = Form(default=""),
    header_row: int = Form(default=0),
    id_column: int = Form(default=0),
    columns: str = Form(default=""),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Create a NEW sheet from an .xlsx and fill it (要望: シートもexcelから取り込める).

    `sheet_name` picks the worksheet (default: the active one), `header_row` the
    1-based 見出し行 (default: auto-detected), `id_column` the 0-based ID column
    (-1 → auto-numbered keys) and `columns` the JSON list of columns to take:
    ``[{"index": 1, "name": "件名", "type": "text"}]``. With `columns` omitted every
    named column is taken with its type guessed from the values (日付 / 数値 /
    メンバー / プルダウン / 自由入力).

    On a schedule sheet the reserved headers — 進捗(%), 先行タスク(ID) and ISO-date
    week columns — keep their normal meaning and do NOT become attribute columns;
    ◇予定/◇実績 are skipped unless explicitly selected (then they land as ordinary
    date columns, since a new sheet has no milestone template yet).
    """
    wb = _open_workbook(file)
    ws = _pick_worksheet(wb, sheet_name)
    grid = _grid(ws)
    if not grid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="空のファイルです")
    hr = min(header_row if header_row > 0 else _auto_header_row(grid), len(grid))
    header, data_rows = _split_grid(grid, hr)
    if not any(not _is_blank(v) for v in header):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="見出し行が空です（見出し行の指定をご確認ください）"
        )

    member_names = set(_members_by_name(db, user.org_id).keys())
    selection = _parse_selection(columns)
    if selection is None:
        selection = _default_selection(header, data_rows, id_column, has_week_grid, member_names)
    selection = [it for it in selection if it["index"] != id_column and 0 <= it["index"] < len(header)]

    new_name = (name or "").strip() or str(ws.title or "").strip() or "取り込みシート"
    max_order = db.execute(
        select(func.coalesce(func.max(Sheet.order), -1)).where(Sheet.org_id == user.org_id)
    ).scalar_one()
    sheet = Sheet(
        org_id=user.org_id,
        name=new_name[:80],
        has_week_grid=has_week_grid,
        order=max_order + 1,
        numbering_rule={"prefix": "", "digits": 3, "next_seq": 1},
    )
    db.add(sheet)
    db.flush()
    # Schedule sheets get their 開始日/完了日 columns before inference, so those
    # headers bind to the real columns instead of creating duplicates.
    ensure_schedule_columns(db, sheet)

    existing_names = {
        c.name
        for c in db.execute(select(Column).where(Column.sheet_id == sheet.id)).scalars()
    }
    # Resolve each pick to its final column name once — the created columns and the
    # synthesized header the row importer sees must line up exactly.
    kept = [
        {**it, "label": ((it["name"] or _cell_text(header[it["index"]])).strip())[:80].strip()}
        for it in selection
    ]
    kept = [it for it in kept if it["label"]]

    created_cols = 0
    order = len(existing_names)
    for it in kept:
        idx, nm = it["index"], it["label"]
        role = _header_role(header[idx], has_week_grid)
        # 週次工数 / 進捗 / 先行タスク are imported by name, not as attribute columns.
        if role in ("week", "progress", "deps") or nm in existing_names:
            continue
        values = _column_values(data_rows, idx)
        ctype = it["type"] if it["type"] in _IMPORTABLE_TYPES else ""
        if not ctype:
            ctype, config = _infer_type(values, member_names)
        else:
            config = _dropdown_config(values) if ctype == "dropdown" else {}
        db.add(
            Column(
                sheet_id=sheet.id,
                name=nm,
                type=ctype,
                order=order,
                is_key=False,
                config=config,
            )
        )
        existing_names.add(nm)
        order += 1
        created_cols += 1
    db.flush()

    # Feed the row importer a grid of exactly the chosen columns, ID first.
    def _cell(row: tuple, i: int):
        return row[i] if 0 <= i < len(row) else None

    out_header: list = ["ID"] + [it["label"] for it in kept]
    out_rows = [
        [_cell(r, id_column) if id_column >= 0 else None]
        + [_cell(r, it["index"]) for it in kept]
        for r in data_rows
    ]

    result = _import_rows(db, user, sheet, out_header, iter(out_rows))
    return {
        "sheet_id": sheet.id,
        "name": sheet.name,
        "columns": created_cols,
        **result,
    }


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
