"""Row CRUD with auto-numbering and optimistic locking."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import history_service
from app.date_values import normalize_date_text
from app.db import get_db
from app.deps import get_row_for_user, get_sheet_for_user
from app.models import Column, Row, RowEvent, Sheet, User
from app.schemas import RowBulkDelete, RowCreate, RowEventOut, RowOut, RowUpdate
from app.security import current_user
from app.weeks import current_week_start
from app.worklog_service import org_week_start_weekday

router = APIRouter(prefix="/api", tags=["rows"])


def _normalize_cells(db: Session, sheet_id: int, data: dict | None) -> dict:
    """日付列の値を 'YYYY-MM-DD' に揃えてから保存する。

    貼り付けや取り込み経由だと `2025/10/18` や `2025-10-18 00:00:00` のまま入って
    しまい、並べ替えや期間計算が効かなくなる。入口がどこであれ保存形は1つにする。
    読めない値は残す（消すよりは見えて直せるほうがよい）。
    """
    if not data:
        return data or {}
    date_col_ids = {
        str(cid)
        for cid in db.execute(
            select(Column.id).where(Column.sheet_id == sheet_id, Column.type == "date")
        ).scalars()
    }
    if not date_col_ids:
        return data
    out = dict(data)
    for cid in date_col_ids & set(out):
        out[cid] = normalize_date_text(out[cid])
    return out


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


def _next_child_key_value(db: Session, parent: Row) -> str:
    """Subtask id = parent key + '-' + 2-digit sequence (e.g. P26-001 -> P26-001-01).
    Sequence = max existing child suffix + 1, so deletes don't reuse ids."""
    base = parent.key_value or ""
    prefix = f"{base}-"
    max_seq = 0
    for c in db.execute(select(Row).where(Row.parent_row_id == parent.id)).scalars():
        kv = c.key_value or ""
        if kv.startswith(prefix):
            suffix = kv[len(prefix):]
            if suffix.isdigit():
                max_seq = max(max_seq, int(suffix))
    return f"{base}-{max_seq + 1:02d}"


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
        data=_normalize_cells(db, sheet_id, payload.data),
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
    _log_created(db, user, row, "行を追加")
    return row


@router.post(
    "/rows/{parent_id}/children",
    response_model=RowOut,
    status_code=status.HTTP_201_CREATED,
)
def create_child_row(
    parent_id: int,
    payload: RowCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Row:
    """Create a subtask (子タスク) under a top-level task. Subtasks are real rows
    that inherit weekly effort, milestones and 日報-driven actuals; the parent
    aggregates them. Nesting is one level only."""
    parent = get_row_for_user(db, parent_id, user)
    if parent.parent_row_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="サブタスクの下にさらに子タスクは作れません",
        )
    key_value = payload.key_value
    if key_value is None or key_value == "":
        key_value = _next_child_key_value(db, parent)

    row = Row(
        sheet_id=parent.sheet_id,
        parent_row_id=parent.id,
        key_value=key_value,
        data=_normalize_cells(db, parent.sheet_id, payload.data),
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
    _log_created(db, user, row, "子タスクを追加")
    return row


def _log_created(db: Session, user: User, row: Row, what: str) -> None:
    """Record a creation event (needs the committed row so it has an id)."""
    history_service.record(
        db, user=user, row=row, kind="create", changes=[(what, None, row.key_value or "")]
    )
    db.commit()


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
    fields = payload.model_dump(exclude_unset=True)
    # 正規化してから履歴を取る（履歴に残るのも保存されるのと同じ値にする）。
    new_data = _normalize_cells(db, row.sheet_id, payload.data)
    # Log the diff BEFORE mutating, while `row` still holds the old values.
    history_service.record_row_update(
        db,
        user=user,
        row=row,
        new_data=new_data,
        new_key=payload.key_value,
        new_progress=payload.progress if "progress" in fields else ...,
        new_depends_on=payload.depends_on if "depends_on" in fields else ...,
    )
    if payload.key_value is not None and payload.key_value != row.key_value:
        row.key_value = payload.key_value
    row.data = new_data
    # progress / depends_on are applied only when present in the body (so a normal
    # data edit never clears them); an explicit null clears progress.
    if "progress" in fields:
        row.progress = payload.progress
        # Stamp the week this progress applies to (for weekly-reset display).
        row.progress_week = (
            None
            if payload.progress is None
            else current_week_start(org_week_start_weekday(db, user.org_id))
        )
    if "depends_on" in fields:
        row.depends_on = payload.depends_on or []
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
    # Log first: the event's row_id is SET NULL by the delete, but row_key keeps
    # the task id so the deletion stays traceable in the sheet history.
    history_service.record(
        db, user=user, row=row, kind="delete", changes=[("行を削除", row.key_value or "", None)]
    )
    db.delete(row)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/rows/bulk-delete")
def bulk_delete_rows(
    payload: RowBulkDelete,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """複数行をまとめて削除する（要望: まとめて選択して削除）。

    1行ずつ DELETE を投げると、100行選んだら100リクエスト＋100回の再取得になり、
    途中で失敗すれば「どこまで消えたのか分からない」状態が残る。これは1トランザクション
    なので、全部消えるか、1つも消えないかのどちらか。

    子タスク（サブタスク）は親を消せば一緒に消える。明示的に選ばれていなくても消えるので、
    件数は「実際に消えた行数」を返す。
    """
    ids = list(dict.fromkeys(payload.ids))  # 重複を潰して順序は保つ
    if not ids:
        return {"deleted": 0}
    # 1件ずつ所有権を確認する — 他組織の行IDを混ぜられても触れないように。
    rows = [get_row_for_user(db, rid, user) for rid in ids]

    selected = {r.id for r in rows}
    children = list(
        db.execute(select(Row).where(Row.parent_row_id.in_(selected))).scalars()
    )
    # 件数は commit の前に確定させる。commit 後に child.id を読むと、削除済みの行を
    # 読み直そうとして ObjectDeletedError になる。
    deleted_ids = selected | {c.id for c in children}
    for row in rows:
        history_service.record(
            db,
            user=user,
            row=row,
            kind="delete",
            changes=[("行を削除", row.key_value or "", None)],
        )
    for child in children:
        if child.id in selected:
            continue
        history_service.record(
            db,
            user=user,
            row=child,
            kind="delete",
            changes=[("行を削除（親の削除に伴う）", child.key_value or "", None)],
        )
    for row in rows:
        db.delete(row)
    db.commit()
    return {"deleted": len(deleted_ids)}


def _events_out(db: Session, events: list[RowEvent]) -> list[RowEventOut]:
    """Attach the author's display name to each event."""
    user_ids = {e.user_id for e in events if e.user_id is not None}
    names: dict[int, str] = {}
    if user_ids:
        names = {
            uid: name
            for uid, name in db.execute(
                select(User.id, User.name).where(User.id.in_(user_ids))
            ).all()
        }
    return [
        RowEventOut(
            id=e.id,
            row_id=e.row_id,
            row_key=e.row_key,
            user_name=names.get(e.user_id or -1, "(不明)"),
            kind=e.kind,
            field_label=e.field_label,
            old_value=e.old_value,
            new_value=e.new_value,
            created_at=e.created_at,
        )
        for e in events
    ]


@router.get("/rows/{row_id}/history", response_model=list[RowEventOut])
def row_history(
    row_id: int,
    limit: int = 200,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[RowEventOut]:
    """Full change log for one task, newest first."""
    get_row_for_user(db, row_id, user)
    events = list(
        db.execute(
            select(RowEvent)
            .where(RowEvent.row_id == row_id)
            .order_by(RowEvent.created_at.desc(), RowEvent.id.desc())
            .limit(min(limit, 500))
        ).scalars()
    )
    return _events_out(db, events)


@router.get("/sheets/{sheet_id}/history", response_model=list[RowEventOut])
def sheet_history(
    sheet_id: int,
    limit: int = 200,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[RowEventOut]:
    """Recent changes across the whole sheet, newest first (「先週から何が変わった？」)."""
    get_sheet_for_user(db, sheet_id, user)
    events = list(
        db.execute(
            select(RowEvent)
            .where(RowEvent.sheet_id == sheet_id)
            .order_by(RowEvent.created_at.desc(), RowEvent.id.desc())
            .limit(min(limit, 500))
        ).scalars()
    )
    return _events_out(db, events)
