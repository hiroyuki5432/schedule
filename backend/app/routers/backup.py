"""バックアップ / リストア (グループ管理).

Admin-only throughout. Backups are stored in the DB so they can be listed and
restored in one click, and can also be downloaded as a .json file to keep a copy
off the box (a DB-level disaster takes the stored ones with it).

Every restore is a single transaction and takes an automatic safety backup first,
so 「戻したけど戻しすぎた」 is itself undoable.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import backup_service as bk
from app.db import get_db
from app.models import Backup, User
from app.schemas import BackupCreate, BackupOut
from app.security import require_admin

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backups", tags=["backup"])

#: Reasonable ceiling for an uploaded file, so a wrong drag-and-drop fails fast
#: instead of being parsed as JSON.
MAX_UPLOAD_BYTES = 200 * 1024 * 1024


def _row(b: Backup) -> dict:
    """List/detail shape — never includes the payload."""
    return {
        "id": b.id,
        "label": b.label,
        "format_version": b.format_version,
        "summary": b.summary or {},
        "size_bytes": b.size_bytes,
        "created_at": b.created_at,
        "created_by_name": b.created_by_name,
    }


def _take(db: Session, admin: User, label: str) -> Backup:
    """Snapshot the group as it is right now. Does not commit.

    Any failure is re-raised as a 400 carrying the real reason: a bare 500 tells
    the user only 「失敗しました」, which is useless for reporting the problem.
    The most common cause on a fresh deploy is the `backups` table not existing
    yet because migrations have not run, so that case is named explicitly.
    """
    try:
        payload = bk.export_org(db, admin.org_id)
    except bk.BackupError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception as exc:
        log.exception("backup export failed for org %s", admin.org_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"バックアップの作成に失敗しました: {type(exc).__name__}: {exc}",
        )
    b = Backup(
        org_id=admin.org_id,
        label=label[:255],
        format_version=bk.FORMAT_VERSION,
        payload=payload,
        summary=bk.summarize(payload),
        size_bytes=bk.payload_size(payload),
        created_by=admin.id,
        created_by_name=admin.name[:255],
    )
    db.add(b)
    return b


@router.get("", response_model=list[BackupOut])
def list_backups(
    admin: User = Depends(require_admin), db: Session = Depends(get_db)
) -> list[dict]:
    """Newest first. The payload column is never selected — it is the big one."""
    rows = db.execute(
        select(
            Backup.id,
            Backup.label,
            Backup.format_version,
            Backup.summary,
            Backup.size_bytes,
            Backup.created_at,
            Backup.created_by_name,
        )
        .where(Backup.org_id == admin.org_id)
        .order_by(Backup.created_at.desc(), Backup.id.desc())
    ).mappings()
    return [dict(r) for r in rows]


@router.post("", response_model=BackupOut, status_code=status.HTTP_201_CREATED)
def create_backup(
    body: BackupCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Take a backup of everything in this group right now."""
    label = (body.label or "").strip() or f"手動バックアップ {datetime.now():%Y-%m-%d %H:%M}"
    b = _take(db, admin, label)
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        log.exception("backup insert failed for org %s", admin.org_id)
        hint = ""
        if "backups" in str(exc) and "exist" in str(exc).lower():
            hint = "（backups テーブルがありません。alembic のマイグレーションを実行してください）"
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"バックアップの保存に失敗しました{hint}: {type(exc).__name__}: {exc}",
        )
    db.refresh(b)
    return _row(b)


@router.get("/{backup_id}/download")
def download_backup(
    backup_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """The backup as a .json file, to keep a copy outside the database."""
    b = _get(db, backup_id, admin)
    blob = json.dumps(b.payload, ensure_ascii=False, indent=1).encode("utf-8")
    stamp = b.created_at.strftime("%Y%m%d_%H%M%S")
    return StreamingResponse(
        iter([blob]),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="backup_{stamp}.json"',
        },
    )


@router.delete("/{backup_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_backup(
    backup_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    db.delete(_get(db, backup_id, admin))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{backup_id}/restore")
def restore_backup(
    backup_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Put the group back to this backup's state — everything, settings included."""
    b = _get(db, backup_id, admin)
    return _restore(db, admin, b.payload, source=b.label)


@router.post("/restore-file")
def restore_from_file(
    file: UploadFile,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Restore from a downloaded .json — the path back after losing the database."""
    blob = file.file.read()
    if len(blob) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="ファイルが大きすぎます"
        )
    try:
        payload = json.loads(blob.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="バックアップファイルを読み取れませんでした（.json をご確認ください）",
        )
    return _restore(db, admin, payload, source=file.filename or "アップロードしたファイル")


def _restore(db: Session, admin: User, payload: dict, source: str) -> dict:
    """Safety backup + restore, all in one transaction.

    The safety copy is taken BEFORE the wipe and lands in `backups`, which the
    restore itself never touches — so an over-eager restore can be undone.
    """
    try:
        bk.validate(payload, admin.org_id)
    except bk.RestoreError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    # Was the person doing this in the backup? If not they are about to delete
    # their own account, and the next request will bounce them to the login page.
    restored_user_ids = {u.get("id") for u in payload["tables"].get("users") or []}
    self_removed = admin.id not in restored_user_ids

    safety = _take(db, admin, f"復元前の自動バックアップ（{datetime.now():%Y-%m-%d %H:%M}）")
    db.flush()

    try:
        counts = bk.restore_org(db, admin.org_id, payload)
    except bk.RestoreError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception:
        db.rollback()
        raise

    db.commit()
    return {
        "restored_from": source,
        "counts": counts,
        "safety_backup_id": safety.id,
        # The UI uses this to say "you have been signed out" instead of showing a
        # confusing 401 on the next click.
        "signed_out": self_removed,
    }


def _get(db: Session, backup_id: int, admin: User) -> Backup:
    b = db.get(Backup, backup_id)
    if b is None or b.org_id != admin.org_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="バックアップが見つかりません"
        )
    return b
