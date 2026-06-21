"""Daily work-log (日報) CRUD. Hours roll up into the linked task's weekly
EffortEntry.actual_hours via app.worklog_service.recompute_actual."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_row_for_user
from app.models import Column, Row, Sheet, User, WorkLog
from app.schemas import TaskOption, WorkLogCreate, WorkLogOut, WorkLogUpdate
from app.security import current_user
from app.weeks import current_week_start
from app.worklog_service import org_week_start_weekday, recompute_actual, week_start_for

router = APIRouter(prefix="/api/worklog", tags=["worklog"])


def _to_out(wl: WorkLog, row: Row | None) -> WorkLogOut:
    return WorkLogOut(
        id=wl.id,
        user_id=wl.user_id,
        work_date=wl.work_date,
        row_id=wl.row_id,
        row_key_value=row.key_value if row else None,
        sheet_id=row.sheet_id if row else None,
        cat1=wl.cat1,
        cat2=wl.cat2,
        memo=wl.memo,
        hours=float(wl.hours),
    )


def _title_column_id(columns: list[Column]) -> int | None:
    texts = [c for c in columns if c.type == "text" and not c.is_key]
    col = texts[0] if texts else next((c for c in columns if c.type == "text"), None)
    return col.id if col else None


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
    out: list[TaskOption] = []
    for sheet in sheets:
        cols = list(db.execute(select(Column).where(Column.sheet_id == sheet.id)).scalars())
        member_ids = [c.id for c in cols if c.type == "member"]
        if not member_ids:
            continue
        title_id = _title_column_id(cols)
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
                    sheet_id=sheet.id,
                    sheet_name=sheet.name,
                )
            )
    return out


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
    return [_to_out(wl, rows.get(wl.row_id) if wl.row_id else None) for wl in logs]


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
        memo=payload.memo,
        hours=payload.hours,
    )
    db.add(wl)
    db.flush()
    if payload.row_id is not None:
        recompute_actual(db, payload.row_id, week_start_for(db, user.org_id, payload.work_date))
    db.commit()
    db.refresh(wl)
    return _to_out(wl, row)


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
    return _to_out(wl, row)


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
