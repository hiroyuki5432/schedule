"""ゴミ箱（削除した行を元に戻す）。中身の出し入れは app.trash_service。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import trash_service
from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import DeletedRowBatch, User
from app.schemas import TrashOut
from app.security import current_user, require_admin

router = APIRouter(prefix="/api", tags=["trash"])


def _batch_for_user(db: Session, trash_id: int, user: User) -> DeletedRowBatch:
    batch = db.get(DeletedRowBatch, trash_id)
    if batch is None or batch.org_id != user.org_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="ゴミ箱に見つかりません（すでに元に戻したか、完全に削除されています）",
        )
    return batch


@router.get("/sheets/{sheet_id}/trash", response_model=list[TrashOut])
def list_trash(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[TrashOut]:
    """このシートで削除された行（新しい順）。"""
    get_sheet_for_user(db, sheet_id, user)
    batches = db.execute(
        select(DeletedRowBatch)
        .where(DeletedRowBatch.sheet_id == sheet_id)
        .order_by(DeletedRowBatch.deleted_at.desc(), DeletedRowBatch.id.desc())
        .limit(200)
    ).scalars()
    return [
        TrashOut(
            id=b.id,
            sheet_id=b.sheet_id,
            row_count=b.row_count,
            row_keys=b.row_keys,
            deleted_by_name=b.deleted_by_name,
            deleted_at=b.deleted_at,
        )
        for b in batches
    ]


@router.post("/trash/{trash_id}/restore")
def restore_trash(
    trash_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """削除した行を元に戻す（同じID・同じ並び位置・工数・◇・メモ・履歴の結びつきごと）。"""
    batch = _batch_for_user(db, trash_id, user)
    try:
        result = trash_service.restore(db, user, batch)
    except trash_service.RestoreError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    db.commit()
    return result


@router.delete("/trash/{trash_id}", status_code=status.HTTP_204_NO_CONTENT)
def purge_trash(
    trash_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)
) -> Response:
    """ゴミ箱から完全に消す（管理者のみ。戻せなくなる）。"""
    batch = _batch_for_user(db, trash_id, admin)
    db.delete(batch)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
