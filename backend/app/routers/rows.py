"""Row CRUD with auto-numbering and optimistic locking."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import history_service, trash_service
from app.date_values import normalize_date_text
from app.db import get_db
from app.deps import get_row_for_user, get_sheet_for_user
from app.models import Column, Row, RowEvent, Sheet, User
from app.schemas import (
    RowBulkDelete,
    RowBulkUpdate,
    RowCreate,
    RowEventOut,
    RowOut,
    RowUpdate,
)
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
        db.execute(
            select(Row).where(Row.sheet_id == sheet_id).order_by(Row.sort_order, Row.id)
        ).scalars()
    )


def _anchor_for(
    db: Session, sheet_id: int, payload: RowCreate, user: User
) -> tuple[Row, bool] | None:
    """挿入位置の基準になる行と、その前（True）か後ろ（False）か。指定が無ければ None。"""
    anchor_id = payload.insert_before_id or payload.insert_after_id
    if not anchor_id:
        return None
    anchor = get_row_for_user(db, anchor_id, user)
    if anchor.sheet_id != sheet_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="挿入位置の行が、このシートの行ではありません",
        )
    return anchor, payload.insert_before_id is not None


def _make_room(db: Session, anchor: Row, before: bool) -> int:
    """基準の行の前／後ろに1つ空きを作り、その番号を返す。

    後ろの行の番号を1つずつずらすだけなので、並びはそれ以外まったく変わらない。
    子タスクは画面では親の下にまとめて出す（番号は親子をまたいで1本）ので、
    親の「後ろ」に入れるときは、その親の子タスクたちの後ろに入れる。
    """
    target = anchor.sort_order or 0
    if not before:
        last = target
        if anchor.parent_row_id is None:
            kids = db.execute(
                select(Row.sort_order).where(Row.parent_row_id == anchor.id)
            ).scalars().all()
            last = max([target, *[k or 0 for k in kids]])
        target = last + 1
    db.execute(
        update(Row)
        .where(Row.sheet_id == anchor.sheet_id, Row.sort_order >= target)
        .values(sort_order=Row.sort_order + 1)
        .execution_options(synchronize_session=False)
    )
    return target


@router.post("/sheets/{sheet_id}/rows", response_model=RowOut, status_code=status.HTTP_201_CREATED)
def create_row(
    sheet_id: int,
    payload: RowCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Row:
    sheet = get_sheet_for_user(db, sheet_id, user)
    anchored = _anchor_for(db, sheet_id, payload, user)
    # 子タスクの前後に挿入したときは、同じ親の子タスクとして入れる（画面では親の下に
    # まとめて並ぶので、最上位の行にすると挿入した場所に出てこない）。
    parent = (
        db.get(Row, anchored[0].parent_row_id)
        if anchored and anchored[0].parent_row_id is not None
        else None
    )
    key_value = payload.key_value
    if key_value is None or key_value == "":
        key_value = (
            _next_child_key_value(db, parent) if parent is not None else _next_key_value(db, sheet)
        )

    row = Row(
        sheet_id=sheet_id,
        parent_row_id=parent.id if parent is not None else None,
        key_value=key_value,
        data=_normalize_cells(db, sheet_id, payload.data),
        version=1,
        created_by=user.id,
        updated_by=user.id,
    )
    if anchored:
        row.sort_order = _make_room(db, anchored[0], anchored[1])
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


@router.delete("/rows/{row_id}")
def delete_row(
    row_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """1行を削除する。消す前にゴミ箱へ写すので、`trash_id` で元に戻せる。"""
    row = get_row_for_user(db, row_id, user)
    sheet = db.get(Sheet, row.sheet_id)
    batch = trash_service.trash_rows(db, user, sheet, [row])
    db.commit()
    return {"deleted": batch.row_count, "trash_id": batch.id}


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
    件数は「実際に消えた行数」を返す。消したものはゴミ箱に入り、`trash_id` で戻せる
    （シートごとに1件。普通は1シートなので1件）。
    """
    ids = list(dict.fromkeys(payload.ids))  # 重複を潰して順序は保つ
    if not ids:
        return {"deleted": 0, "trash_id": None, "trash_ids": []}
    # 1件ずつ所有権を確認する — 他組織の行IDを混ぜられても触れないように。
    rows = [get_row_for_user(db, rid, user) for rid in ids]
    by_sheet: dict[int, list[Row]] = {}
    for r in rows:
        by_sheet.setdefault(r.sheet_id, []).append(r)
    batches = [
        trash_service.trash_rows(db, user, db.get(Sheet, sid), group)
        for sid, group in by_sheet.items()
    ]
    db.commit()
    trash_ids = [b.id for b in batches]
    return {
        "deleted": sum(b.row_count for b in batches),
        "trash_id": trash_ids[0] if len(trash_ids) == 1 else None,
        "trash_ids": trash_ids,
    }


@router.post("/rows/bulk-update")
def bulk_update_rows(
    payload: RowBulkUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """範囲の貼り付け・まとめて消去・フィル（要望: Excel のように範囲でコピペしたい）。

    セル単位で上書きする: 送られてきた列だけを書き換え、それ以外の列はそのとき DB に
    ある値のまま残す。同じ行の別の列を他の人が直していても消さないため、行の version
    による衝突検出はしない（週次工数の範囲貼り付けと同じ扱い）。履歴は1セルずつ残る。

    計算列（参照・数式）は値を持たないので、送られてきても書かない。
    """
    merged: dict[int, dict] = {}
    keys: dict[int, str] = {}
    for it in payload.items:
        merged.setdefault(it.id, {}).update(it.data)
        if it.key_value is not None:
            keys[it.id] = it.key_value
    if not merged:
        return {"updated": 0, "rows": []}

    rows = [get_row_for_user(db, rid, user) for rid in merged]
    computed: dict[int, set[str]] = {}
    out: list[Row] = []
    for row in rows:
        if row.sheet_id not in computed:
            computed[row.sheet_id] = {
                str(cid)
                for cid in db.execute(
                    select(Column.id).where(
                        Column.sheet_id == row.sheet_id, Column.type.in_(("lookup", "formula"))
                    )
                ).scalars()
            }
        patch = {
            str(k): v for k, v in merged[row.id].items() if str(k) not in computed[row.sheet_id]
        }
        patch = _normalize_cells(db, row.sheet_id, patch)
        new_data = {**(row.data or {}), **patch}
        new_key = keys.get(row.id)
        history_service.record_row_update(
            db, user=user, row=row, new_data=new_data, new_key=new_key
        )
        if new_key is not None:
            row.key_value = new_key
        row.data = new_data
        row.version = row.version + 1
        row.updated_by = user.id
        out.append(row)
    db.commit()
    for r in out:
        db.refresh(r)
    return {"updated": len(out), "rows": [RowOut.model_validate(r) for r in out]}


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
