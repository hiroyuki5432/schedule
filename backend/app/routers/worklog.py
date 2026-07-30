"""Daily work-log (日報) CRUD. Hours roll up into the linked task's weekly
EffortEntry.actual_hours via app.worklog_service.recompute_actual."""
from __future__ import annotations

import io
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_row_for_user
from app.models import Column, Organization, Row, Sheet, User, WorkLog
from app.schemas import (
    TaskOption,
    UserDayWorkLog,
    WorkLogCreate,
    WorkLogOut,
    WorkLogUpdate,
)
from app.security import current_user, require_admin
from app.weeks import current_week_start
from app.worklog_service import org_week_start_weekday, recompute_actual, week_start_for

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
# Fixed part of the みんなの入力一覧 Excel export/import; the category columns in
# between come from the org's category levels (既定: 大分類 / 中分類).
_WL_HEAD = ["日付", "ユーザー", "タスクID"]
_WL_TAIL = ["メモ", "時間"]
DEFAULT_CATEGORY_LEVELS = ["大分類", "中分類"]
#: Category columns on WorkLog, in level order. The org may use fewer (or rename
#: them) — never more.
CAT_FIELDS = ["cat1", "cat2", "cat3"]
#: Sentinel in a sheet's worklog_task_columns meaning "the task ID (key_value)".
ID_KEY = "__id__"

router = APIRouter(prefix="/api/worklog", tags=["worklog"])


def category_levels(db: Session, org_id: int) -> list[str]:
    """The org's category level names (実績入力の分類). 1〜3 段、既定は 大分類→中分類."""
    org = db.get(Organization, org_id)
    raw = ((org.settings or {}).get("worklog") or {}).get("category_levels") if org else None
    if not isinstance(raw, list):
        return list(DEFAULT_CATEGORY_LEVELS)
    names = [str(x).strip() for x in raw if str(x).strip()][: len(CAT_FIELDS)]
    return names or list(DEFAULT_CATEGORY_LEVELS)


def _to_out(wl: WorkLog, row: Row | None, label: str | None = None) -> WorkLogOut:
    return WorkLogOut(
        id=wl.id,
        user_id=wl.user_id,
        work_date=wl.work_date,
        row_id=wl.row_id,
        row_key_value=row.key_value if row else None,
        row_label=label,
        sheet_id=row.sheet_id if row else None,
        cat1=wl.cat1,
        cat2=wl.cat2,
        cat3=wl.cat3,
        memo=wl.memo,
        hours=float(wl.hours),
    )


def _title_column_id(columns: list[Column]) -> int | None:
    texts = [c for c in columns if c.type == "text" and not c.is_key]
    col = texts[0] if texts else next((c for c in columns if c.type == "text"), None)
    return col.id if col else None


def _label_keys(sheet: Sheet, columns: list[Column]) -> list[str]:
    """Which parts make up a task's display text on this sheet: entries are column
    ids (as strings) or ID_KEY. Configured per sheet in
    settings.worklog_task_columns; the default is ID＋件名 (the old behaviour)."""
    raw = (sheet.settings or {}).get("worklog_task_columns")
    valid = {str(c.id) for c in columns} | {ID_KEY}
    if isinstance(raw, list):
        keys = [str(x) for x in raw if str(x) in valid]
        if keys:
            return keys
    title_id = _title_column_id(columns)
    return [ID_KEY] + ([str(title_id)] if title_id else [])


def _task_label(
    row: Row, keys: list[str], by_id: dict[str, Column], member_names: dict[str, str]
) -> str:
    """Join the configured columns' values for one task ('A-1 / 設計する')."""
    data = row.data or {}
    parts: list[str] = []
    for key in keys:
        if key == ID_KEY:
            parts.append(row.key_value or "")
            continue
        col = by_id.get(key)
        if col is None or col.type == "lookup":
            continue  # 参照列はサーバ側で解決しないので表示に使わない
        v = data.get(key)
        if v is None or v == "":
            continue
        parts.append(member_names.get(str(v), "") if col.type == "member" else str(v))
    return " / ".join(p for p in parts if p)


def _labels_for_rows(db: Session, org_id: int, rows: list[Row]) -> dict[int, str]:
    """row_id → display text, using each row's own sheet configuration."""
    if not rows:
        return {}
    member_names = {
        str(u.id): u.name
        for u in db.execute(select(User).where(User.org_id == org_id)).scalars()
    }
    sheet_ids = {r.sheet_id for r in rows}
    sheets = {
        s.id: s
        for s in db.execute(select(Sheet).where(Sheet.id.in_(sheet_ids))).scalars()
    }
    cols_by_sheet: dict[int, list[Column]] = {}
    for c in db.execute(select(Column).where(Column.sheet_id.in_(sheet_ids))).scalars():
        cols_by_sheet.setdefault(c.sheet_id, []).append(c)

    out: dict[int, str] = {}
    for sid, sheet in sheets.items():
        cols = sorted(cols_by_sheet.get(sid, []), key=lambda c: (c.order, c.id))
        keys = _label_keys(sheet, cols)
        by_id = {str(c.id): c for c in cols}
        for r in rows:
            if r.sheet_id == sid:
                out[r.id] = _task_label(r, keys, by_id, member_names)
    return out


def _label_of(db: Session, org_id: int, row: Row | None) -> str | None:
    """Display text for a single task (None when the log has no linked task)."""
    if row is None:
        return None
    return _labels_for_rows(db, org_id, [row]).get(row.id)


@router.get("/tasks", response_model=list[TaskOption])
def my_tasks(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[TaskOption]:
    """Tasks (rows) the current user is assigned to, across all org sheets that
    have a member column. Powers the 実績入力 task dropdown (no sheet picking)."""
    me = str(user.id)
    sheets = list(
        db.execute(select(Sheet).where(Sheet.org_id == user.org_id).order_by(Sheet.order)).scalars()
    )
    member_names = {
        str(u.id): u.name
        for u in db.execute(select(User).where(User.org_id == user.org_id)).scalars()
    }
    out: list[TaskOption] = []
    for sheet in sheets:
        cols = sorted(
            db.execute(select(Column).where(Column.sheet_id == sheet.id)).scalars(),
            key=lambda c: (c.order, c.id),
        )
        member_ids = [c.id for c in cols if c.type == "member"]
        if not member_ids:
            continue
        title_id = _title_column_id(cols)
        # Display text is configurable per sheet (要望: IDと件名以外でも表示したい).
        keys = _label_keys(sheet, cols)
        by_id = {str(c.id): c for c in cols}
        rows = list(db.execute(select(Row).where(Row.sheet_id == sheet.id)).scalars())
        for r in rows:
            data = r.data or {}
            if not any(
                data.get(str(mid)) is not None and str(data.get(str(mid))) == me
                for mid in member_ids
            ):
                continue
            title = str(data.get(str(title_id), "") or "") if title_id else ""
            out.append(
                TaskOption(
                    row_id=r.id,
                    key_value=r.key_value,
                    title=title,
                    label=_task_label(r, keys, by_id, member_names),
                    sheet_id=sheet.id,
                    sheet_name=sheet.name,
                )
            )
    return out


@router.get("/all", response_model=list[UserDayWorkLog])
def all_users_day(
    date_: date = Query(alias="date"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[UserDayWorkLog]:
    """Every org member's work logs for one day, grouped by member with totals
    (みんなの入力一覧). Read-only team view; members with no input are included."""
    members = list(
        db.execute(
            select(User).where(User.org_id == user.org_id).order_by(User.id)
        ).scalars()
    )
    logs = list(
        db.execute(
            select(WorkLog)
            .where(WorkLog.org_id == user.org_id, WorkLog.work_date == date_)
            .order_by(WorkLog.user_id, WorkLog.id)
        ).scalars()
    )
    row_ids = {wl.row_id for wl in logs if wl.row_id is not None}
    rows: dict[int, Row] = {}
    if row_ids:
        for r in db.execute(select(Row).where(Row.id.in_(row_ids))).scalars():
            rows[r.id] = r
    labels = _labels_for_rows(db, user.org_id, list(rows.values()))

    by_user: dict[int, list[WorkLog]] = {}
    for wl in logs:
        by_user.setdefault(wl.user_id, []).append(wl)

    out: list[UserDayWorkLog] = []
    for m in members:
        ulogs = by_user.get(m.id, [])
        out.append(
            UserDayWorkLog(
                user_id=m.id,
                user_name=m.name,
                total_hours=float(sum(float(wl.hours) for wl in ulogs)),
                logs=[
                    _to_out(
                        wl,
                        rows.get(wl.row_id) if wl.row_id else None,
                        labels.get(wl.row_id) if wl.row_id else None,
                    )
                    for wl in ulogs
                ],
            )
        )
    return out


@router.get("/export.xlsx")
def export_worklog_xlsx(
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None, alias="to"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Export every member's work logs over [from, to] (みんなの入力一覧) as .xlsx.
    Defaults to today when no range given."""
    from openpyxl import Workbook

    if from_ is None and to is None:
        from_ = to = date.today()
    from_ = from_ or to
    to = to or from_

    members = {
        u.id: u.name
        for u in db.execute(select(User).where(User.org_id == user.org_id)).scalars()
    }
    logs = list(
        db.execute(
            select(WorkLog)
            .where(
                WorkLog.org_id == user.org_id,
                WorkLog.work_date >= from_,
                WorkLog.work_date <= to,
            )
            .order_by(WorkLog.work_date, WorkLog.user_id, WorkLog.id)
        ).scalars()
    )
    row_ids = {wl.row_id for wl in logs if wl.row_id is not None}
    keys: dict[int, str] = {}
    if row_ids:
        for r in db.execute(select(Row).where(Row.id.in_(row_ids))).scalars():
            keys[r.id] = r.key_value or ""

    # Category columns follow the org's configured levels (段数・名称とも可変).
    levels = category_levels(db, user.org_id)

    wb = Workbook()
    ws = wb.active
    ws.title = "日報"
    ws.append(_WL_HEAD + levels + _WL_TAIL)
    for wl in logs:
        cats = [getattr(wl, f) or "" for f in CAT_FIELDS[: len(levels)]]
        ws.append([
            wl.work_date.isoformat(),
            members.get(wl.user_id, ""),
            keys.get(wl.row_id, "") if wl.row_id else "",
            *cats,
            wl.memo or "",
            float(wl.hours),
        ])

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    filename = f"worklog_{from_.isoformat()}_{to.isoformat()}.xlsx"
    return StreamingResponse(
        buffer,
        media_type=_XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import.xlsx")
def import_worklog_xlsx(
    file: UploadFile,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Admin-only. Bulk-add work logs from .xlsx (みんなの入力一覧 取込). Columns are
    matched by header name (日付/ユーザー/タスクID/<分類の各段>/メモ/時間). The category
    headers follow the org's configured level names, with 大分類/中分類/小分類 accepted
    as fallbacks. Each row becomes a NEW log (no upsert — worklogs have no natural
    key); user is matched by name, task by ID (first match). Linked tasks' weekly
    実績 are recomputed."""
    from openpyxl import load_workbook

    try:
        wb = load_workbook(io.BytesIO(file.file.read()), data_only=True, read_only=True)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Excelファイルを読み込めませんでした（.xlsx 形式をご確認ください）",
        )
    ws = wb.active
    it = ws.iter_rows(values_only=True)
    try:
        header = next(it)
    except StopIteration:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="空のファイルです")

    pos = {str(h).strip(): i for i, h in enumerate(header) if h is not None}
    if "ユーザー" not in pos or "時間" not in pos:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ヘッダーに『ユーザー』と『時間』の列が必要です",
        )

    users_by_name: dict[str, int] = {}
    for u in db.execute(select(User).where(User.org_id == admin.org_id)).scalars():
        users_by_name.setdefault(u.name, u.id)
    # Task key_value -> row_id (first match) within this org.
    rows_by_key: dict[str, int] = {}
    for r in db.execute(
        select(Row).join(Sheet, Row.sheet_id == Sheet.id).where(Sheet.org_id == admin.org_id)
    ).scalars():
        if r.key_value:
            rows_by_key.setdefault(r.key_value, r.id)

    # Category columns: the org's own level names, falling back to the built-in
    # ones so a file exported before the levels were renamed still imports.
    levels = category_levels(db, admin.org_id)
    fallback = DEFAULT_CATEGORY_LEVELS + ["小分類"]
    cat_headers: list[str | None] = []
    for i in range(len(levels)):
        cat_headers.append(
            levels[i] if levels[i] in pos else (fallback[i] if fallback[i] in pos else None)
        )

    # Duplicate guard: signature of an existing log. Re-importing the same file (or
    # a row identical to one already stored) is skipped rather than duplicated.
    def _sig(user_id, work_date, row_id, cats, memo, hours) -> tuple:
        return (
            user_id,
            work_date,
            row_id,
            tuple((c or "") for c in cats),
            memo or "",
            round(float(hours), 2),
        )

    seen: set[tuple] = set()
    for wl in db.execute(select(WorkLog).where(WorkLog.org_id == admin.org_id)).scalars():
        seen.add(
            _sig(
                wl.user_id,
                wl.work_date,
                wl.row_id,
                [getattr(wl, f) for f in CAT_FIELDS[: len(levels)]],
                wl.memo,
                wl.hours,
            )
        )

    def cell(row, name):
        i = pos.get(name)
        return row[i] if i is not None and i < len(row) else None

    created = skipped = duplicates = 0
    affected: set[tuple[int, date]] = set()

    for raw in it:
        if raw is None or not any(v not in (None, "") for v in raw):
            continue
        uname = cell(raw, "ユーザー")
        hours_raw = cell(raw, "時間")
        uid = users_by_name.get(str(uname).strip()) if uname is not None else None
        if uid is None or hours_raw in (None, ""):
            skipped += 1
            continue
        try:
            hours = float(hours_raw)
        except (TypeError, ValueError):
            skipped += 1
            continue

        d_raw = cell(raw, "日付")
        if isinstance(d_raw, datetime):
            work_date = d_raw.date()
        elif isinstance(d_raw, date):
            work_date = d_raw
        elif isinstance(d_raw, str) and d_raw.strip():
            try:
                work_date = date.fromisoformat(d_raw.strip())
            except ValueError:
                work_date = date.today()
        else:
            work_date = date.today()

        key = cell(raw, "タスクID")
        row_id = rows_by_key.get(str(key).strip()) if key not in (None, "") else None

        def _s(name):
            if name is None:
                return None
            v = cell(raw, name)
            return None if v in (None, "") else str(v)

        cats = [_s(h) for h in cat_headers]
        memo = _s("メモ")
        sig = _sig(uid, work_date, row_id, cats, memo, hours)
        if sig in seen:
            duplicates += 1
            continue
        seen.add(sig)

        db.add(
            WorkLog(
                org_id=admin.org_id,
                user_id=uid,
                work_date=work_date,
                row_id=row_id,
                memo=memo,
                hours=hours,
                **{f: c for f, c in zip(CAT_FIELDS, cats)},
            )
        )
        created += 1
        if row_id is not None:
            affected.add((row_id, week_start_for(db, admin.org_id, work_date)))

    db.flush()
    for rid, week in affected:
        recompute_actual(db, rid, week)
    db.commit()
    return {"created": created, "skipped": skipped, "duplicates": duplicates}


def _owned(db: Session, worklog_id: int, user: User) -> WorkLog:
    wl = db.get(WorkLog, worklog_id)
    if wl is None or wl.org_id != user.org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Work log not found")
    if wl.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your work log")
    return wl


@router.get("", response_model=list[WorkLogOut])
def list_worklogs(
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None, alias="to"),
    user_id: int | None = Query(default=None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[WorkLogOut]:
    # Default window = the current week (org-anchored).
    if from_ is None or to is None:
        ws = current_week_start(org_week_start_weekday(db, user.org_id))
        from_ = from_ or ws
        to = to or ws + timedelta(days=6)
    target_user = user.id if user_id is None else user_id
    if target_user != user.id and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required to view others"
        )
    logs = list(
        db.execute(
            select(WorkLog)
            .where(
                WorkLog.org_id == user.org_id,
                WorkLog.user_id == target_user,
                WorkLog.work_date >= from_,
                WorkLog.work_date <= to,
            )
            .order_by(WorkLog.work_date, WorkLog.id)
        ).scalars()
    )
    row_ids = {wl.row_id for wl in logs if wl.row_id is not None}
    rows: dict[int, Row] = {}
    if row_ids:
        for r in db.execute(select(Row).where(Row.id.in_(row_ids))).scalars():
            rows[r.id] = r
    labels = _labels_for_rows(db, user.org_id, list(rows.values()))
    return [
        _to_out(
            wl,
            rows.get(wl.row_id) if wl.row_id else None,
            labels.get(wl.row_id) if wl.row_id else None,
        )
        for wl in logs
    ]


@router.post("", response_model=WorkLogOut, status_code=status.HTTP_201_CREATED)
def create_worklog(
    payload: WorkLogCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> WorkLogOut:
    row = get_row_for_user(db, payload.row_id, user) if payload.row_id is not None else None
    wl = WorkLog(
        org_id=user.org_id,
        user_id=user.id,
        work_date=payload.work_date,
        row_id=payload.row_id,
        cat1=payload.cat1,
        cat2=payload.cat2,
        cat3=payload.cat3,
        memo=payload.memo,
        hours=payload.hours,
    )
    db.add(wl)
    db.flush()
    if payload.row_id is not None:
        recompute_actual(db, payload.row_id, week_start_for(db, user.org_id, payload.work_date))
    db.commit()
    db.refresh(wl)
    return _to_out(wl, row, _label_of(db, user.org_id, row))


@router.patch("/{worklog_id}", response_model=WorkLogOut)
def update_worklog(
    worklog_id: int,
    payload: WorkLogUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> WorkLogOut:
    wl = _owned(db, worklog_id, user)
    affected: set[tuple[int, date]] = set()
    if wl.row_id is not None:
        affected.add((wl.row_id, week_start_for(db, user.org_id, wl.work_date)))

    data = payload.model_dump(exclude_unset=True)
    if data.get("row_id") is not None:
        get_row_for_user(db, data["row_id"], user)  # validate org scope of new task
    for key, val in data.items():
        setattr(wl, key, val)
    db.flush()

    if wl.row_id is not None:
        affected.add((wl.row_id, week_start_for(db, user.org_id, wl.work_date)))
    for rid, week in affected:
        recompute_actual(db, rid, week)
    db.commit()
    db.refresh(wl)
    row = db.get(Row, wl.row_id) if wl.row_id else None
    return _to_out(wl, row, _label_of(db, user.org_id, row))


@router.delete("/{worklog_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_worklog(
    worklog_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    wl = _owned(db, worklog_id, user)
    row_id = wl.row_id
    week = week_start_for(db, user.org_id, wl.work_date)
    db.delete(wl)
    db.flush()
    if row_id is not None:
        recompute_actual(db, row_id, week)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
