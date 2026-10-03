"""セルのメモ（要望: Excel のコメントのように、セルに一言残したい）。

1セルに1件。書き直せば上書き、空にすれば消える。変更は行の変更履歴にも残る
（「メモ（担当）」のように、どのセルのメモかが分かる名前で）。
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import history_service
from app.db import get_db
from app.deps import get_row_for_user, get_sheet_for_user
from app.models import CellNote, Column, Row, User
from app.schemas import CellNoteIn, CellNoteOut
from app.security import current_user

router = APIRouter(prefix="/api", tags=["notes"])

#: ID のセル。
ID_KEY = "__id__"
#: 週次工数のセルの接頭辞（"w:2026-10-05"）。
WEEK_PREFIX = "w:"
#: 1件のメモの上限（文字）。セルに付ける一言なので、長文はレコードの自由入力列へ。
MAX_LEN = 2000


def _label_for(db: Session, row: Row, cell_key: str) -> str:
    """変更履歴に出す「どのセルのメモか」。不正な cell_key なら 400。"""
    if cell_key == ID_KEY:
        return "メモ（ID）"
    if cell_key.startswith(WEEK_PREFIX):
        iso = cell_key[len(WEEK_PREFIX):]
        try:
            date.fromisoformat(iso)
        except ValueError:
            raise HTTPException(status_code=400, detail="週の指定が正しくありません")
        return f"メモ（工数 {iso}）"
    if cell_key.isdigit():
        col = db.get(Column, int(cell_key))
        if col is None or col.sheet_id != row.sheet_id:
            raise HTTPException(status_code=400, detail="この行のシートに無い列です")
        return f"メモ（{col.name}）"
    raise HTTPException(status_code=400, detail="セルの指定が正しくありません")


@router.get("/sheets/{sheet_id}/notes", response_model=list[CellNoteOut])
def list_notes(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[CellNote]:
    get_sheet_for_user(db, sheet_id, user)
    return list(
        db.execute(
            select(CellNote).where(CellNote.sheet_id == sheet_id).order_by(CellNote.id)
        ).scalars()
    )


@router.put("/rows/{row_id}/notes")
def put_note(
    row_id: int,
    body: CellNoteIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """メモを書く（空文字なら消す）。消したときは `note: null` を返す。"""
    row = get_row_for_user(db, row_id, user)
    cell_key = body.cell_key.strip()
    label = _label_for(db, row, cell_key)
    text = (body.text or "").strip()
    if len(text) > MAX_LEN:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"メモは{MAX_LEN}文字までです（いま{len(text)}文字）",
        )

    note = db.execute(
        select(CellNote).where(CellNote.row_id == row.id, CellNote.cell_key == cell_key)
    ).scalar_one_or_none()
    before = note.text if note is not None else ""
    if before == text:
        return {"note": CellNoteOut.model_validate(note) if note is not None else None}

    if not text:
        db.delete(note)
    elif note is None:
        note = CellNote(
            sheet_id=row.sheet_id,
            row_id=row.id,
            cell_key=cell_key,
            text=text,
            updated_by=user.id,
            updated_by_name=user.name,
        )
        db.add(note)
    else:
        note.text = text
        note.updated_by = user.id
        note.updated_by_name = user.name
    history_service.record(
        db, user=user, row=row, kind="update", changes=[(label, before, text)]
    )
    db.commit()
    if not text:
        return {"note": None}
    db.refresh(note)
    return {"note": CellNoteOut.model_validate(note)}
