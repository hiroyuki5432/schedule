"""データのお掃除 — 溜まり続けるデータを見て、要らないものを消す。

要望: 「作ったり消したりを続けているが、基本DBは溜まり続けている？ もしそうなら
表面に見えないデータはきれいにできるといい」。答えは **Yes** で、画面から消しても
消えないものが5種類ある:

1. **変更履歴 (row_events)** — 1セル直すごとに1行増え、消す仕組みが無かった。
2. **週次スナップショット (sheet_snapshots)** — シートを開いた週ごとに、そのシートの
   状態まるごとが JSON で1件。3年ぶんで150件/シート、行が多いほど1件が重い。
3. **既読の通知** — 読んだあとも残り続ける。
4. **消した列のセル** — 列を消しても `rows.data` の中の値は残る（列IDがキーなので、
   どの列のものだったのかも分からないまま残る）。行を開いても表示されない＝完全に
   見えないデータ。取り込み→列を直す、を繰り返すほど溜まる。
5. **空の工数セル** — 数字を消した週のレコードが 0件ではなく「両方 null」で残る。

加えて **バックアップ** は1件がグループ全体の JSON なので、放っておくといちばん太る。

どれも「消していい」と言い切れないもの（履歴・断面）なので、この API は
**必ず件数を見せてから消す**（`dry_run`）。消すのは管理者だけ。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import (
    Backup,
    Column,
    EffortEntry,
    ImportPreset,
    Notification,
    Row,
    RowEvent,
    RowMilestone,
    Sheet,
    SheetSnapshot,
    User,
    WorkLog,
)
from app.schedule_service import LEGACY_END_KEY, LEGACY_START_KEY, sched_columns
from app.schemas import CleanupRequest
from app.security import require_admin

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])

#: 既定のしきい値。画面はこれを初期値に出し、変えたぶんを問い合わせに載せてくる。
DEFAULT_EVENT_KEEP_DAYS = 365
DEFAULT_SNAPSHOT_KEEP_WEEKS = 52
DEFAULT_BACKUP_KEEP = 10

#: 実テーブルのサイズを出すための一覧（表示名つき）。Postgres 以外では出さない。
_TABLES: list[tuple[str, str]] = [
    ("rows", "タスク（行）"),
    ("effort_entries", "週次工数"),
    ("row_milestones", "マイルストン"),
    ("row_events", "変更履歴"),
    ("sheet_snapshots", "週次スナップショット"),
    ("work_logs", "実績入力（日報）"),
    ("notifications", "通知"),
    ("backups", "バックアップ"),
    ("import_presets", "取り込み設定"),
    ("columns", "列定義"),
    ("sheets", "シート"),
]


def _sheet_ids(db: Session, org_id: int) -> list[int]:
    return list(db.execute(select(Sheet.id).where(Sheet.org_id == org_id)).scalars())


def _row_ids_subq(db: Session, org_id: int):
    return (
        select(Row.id)
        .join(Sheet, Sheet.id == Row.sheet_id)
        .where(Sheet.org_id == org_id)
        .scalar_subquery()
    )


def _count(db: Session, stmt) -> int:
    return int(db.execute(stmt).scalar_one() or 0)


def _table_sizes(db: Session) -> tuple[int | None, dict[str, int]]:
    """(DB全体のバイト数, テーブルごとのバイト数)。Postgres 以外では (None, {})。

    サイズはインストール全体のもの（テーブルはグループで共有）。行数のほうはこの
    グループだけを数えているので、画面では別々に見せる。
    """
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return None, {}
    try:
        total = int(
            db.execute(text("SELECT pg_database_size(current_database())")).scalar_one()
        )
        sizes: dict[str, int] = {}
        for name, _label in _TABLES:
            size = db.execute(
                text("SELECT pg_total_relation_size(to_regclass(:n))"), {"n": name}
            ).scalar()
            if size is not None:
                sizes[name] = int(size)
        return total, sizes
    except Exception:  # pragma: no cover - サイズが取れなくても本体は使える
        return None, {}


def _orphan_cells(db: Session, org_id: int) -> tuple[int, int, int, int]:
    """(消した列のセル数, その行数, 移行前の開始/完了日の値の数, その行数)。

    前者は `rows.data` にあるのに、そのシートの列一覧にはもう無いキー — 列を削除した
    ときに置き去りになった値で、画面のどこにも出ない。後者は 開始日/完了日 を実列に
    移す前の `__sched_*` の値で、実列にすでに値が入っているぶんだけを「重複したコピー」
    として数える（実列が空なら、まだ読まれる可能性があるので触らない）。
    """
    orphan_cells = orphan_rows = legacy_cells = legacy_rows = 0
    for sheet in db.execute(select(Sheet).where(Sheet.org_id == org_id)).scalars():
        col_ids = {
            str(cid)
            for cid in db.execute(
                select(Column.id).where(Column.sheet_id == sheet.id)
            ).scalars()
        }
        start_col, end_col = sched_columns(db, sheet.id)
        legacy_pairs = [
            (LEGACY_START_KEY, str(start_col.id) if start_col else None),
            (LEGACY_END_KEY, str(end_col.id) if end_col else None),
        ]
        for row in db.execute(select(Row).where(Row.sheet_id == sheet.id)).scalars():
            data = row.data or {}
            dead = [k for k in data if k not in col_ids and not str(k).startswith("__")]
            copies = [
                key
                for key, col_id in legacy_pairs
                if key in data and col_id and data.get(col_id) not in (None, "")
            ]
            if dead:
                orphan_cells += len(dead)
                orphan_rows += 1
            if copies:
                legacy_cells += len(copies)
                legacy_rows += 1
    return orphan_cells, orphan_rows, legacy_cells, legacy_rows


@router.get("/usage")
def usage(
    row_events_keep_days: int = DEFAULT_EVENT_KEEP_DAYS,
    snapshots_keep_weeks: int = DEFAULT_SNAPSHOT_KEEP_WEEKS,
    backups_keep: int = DEFAULT_BACKUP_KEEP,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """いま何がどれだけ溜まっていて、指定のしきい値だと何件消せるか。書き込みはしない。"""
    org_id = admin.org_id
    sheet_ids = _sheet_ids(db, org_id)
    row_ids = _row_ids_subq(db, org_id)
    total_bytes, sizes = _table_sizes(db)

    def rows_of(model, where=None) -> int:
        stmt = select(func.count()).select_from(model)
        return _count(db, stmt if where is None else stmt.where(where))

    event_cutoff = datetime.now(timezone.utc) - timedelta(days=max(0, row_events_keep_days))
    snapshot_cutoff = date.today() - timedelta(weeks=max(0, snapshots_keep_weeks))

    events_total = rows_of(RowEvent, RowEvent.org_id == org_id)
    events_old = rows_of(
        RowEvent, (RowEvent.org_id == org_id) & (RowEvent.created_at < event_cutoff)
    )
    snapshots_total = (
        rows_of(SheetSnapshot, SheetSnapshot.sheet_id.in_(sheet_ids)) if sheet_ids else 0
    )
    snapshots_old = (
        rows_of(
            SheetSnapshot,
            SheetSnapshot.sheet_id.in_(sheet_ids) & (SheetSnapshot.for_week < snapshot_cutoff),
        )
        if sheet_ids
        else 0
    )
    notifications_read = rows_of(
        Notification, (Notification.org_id == org_id) & Notification.read_at.is_not(None)
    )
    empty_effort = rows_of(
        EffortEntry,
        EffortEntry.row_id.in_(row_ids)
        & EffortEntry.planned_hours.is_(None)
        & EffortEntry.actual_hours.is_(None),
    )
    backups = list(
        db.execute(
            select(Backup.id, Backup.size_bytes)
            .where(Backup.org_id == org_id)
            .order_by(Backup.created_at.desc(), Backup.id.desc())
        ).all()
    )
    backups_old = max(0, len(backups) - max(0, backups_keep))
    orphan_cells, orphan_rows, legacy_cells, legacy_rows = _orphan_cells(db, org_id)

    counts = {
        "rows": rows_of(Row, Row.sheet_id.in_(sheet_ids)) if sheet_ids else 0,
        "effort_entries": rows_of(EffortEntry, EffortEntry.row_id.in_(row_ids)),
        "row_milestones": rows_of(RowMilestone, RowMilestone.row_id.in_(row_ids)),
        "row_events": events_total,
        "sheet_snapshots": snapshots_total,
        "work_logs": rows_of(WorkLog, WorkLog.org_id == org_id),
        "notifications": rows_of(Notification, Notification.org_id == org_id),
        "backups": len(backups),
        "import_presets": rows_of(ImportPreset, ImportPreset.org_id == org_id),
        "columns": rows_of(Column, Column.sheet_id.in_(sheet_ids)) if sheet_ids else 0,
        "sheets": len(sheet_ids),
    }

    return {
        "database_bytes": total_bytes,
        "tables": [
            {
                "name": name,
                "label": label,
                "rows": counts.get(name, 0),
                "bytes": sizes.get(name),
            }
            for name, label in _TABLES
        ],
        "cleanable": {
            "row_events_total": events_total,
            "row_events_old": events_old,
            "row_events_keep_days": row_events_keep_days,
            "snapshots_total": snapshots_total,
            "snapshots_old": snapshots_old,
            "snapshots_keep_weeks": snapshots_keep_weeks,
            "notifications_read": notifications_read,
            "orphan_cells": orphan_cells,
            "orphan_rows": orphan_rows,
            "legacy_cells": legacy_cells,
            "legacy_rows": legacy_rows,
            "empty_effort": empty_effort,
            "backups_total": len(backups),
            "backups_old": backups_old,
            "backups_keep": backups_keep,
            "backups_bytes": sum(int(b.size_bytes or 0) for b in backups),
            "backups_old_bytes": sum(
                int(b.size_bytes or 0) for b in backups[max(0, backups_keep) :]
            ),
        },
    }


@router.post("/cleanup")
def cleanup(
    body: CleanupRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """選ばれた種類だけを消す。`dry_run` なら数えるだけで書き込まない。

    まとめて1トランザクション。途中で失敗したら何も消えない。
    """
    org_id = admin.org_id
    sheet_ids = _sheet_ids(db, org_id)
    row_ids = _row_ids_subq(db, org_id)
    deleted: dict[str, int] = {}

    def count(model, where) -> int:
        return _count(db, select(func.count()).select_from(model).where(where))

    if body.row_events_keep_days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=max(0, body.row_events_keep_days))
        where = (RowEvent.org_id == org_id) & (RowEvent.created_at < cutoff)
        deleted["row_events"] = count(RowEvent, where)
        if not body.dry_run and deleted["row_events"]:
            db.execute(delete(RowEvent).where(where))

    if body.snapshots_keep_weeks is not None and sheet_ids:
        cutoff_week = date.today() - timedelta(weeks=max(0, body.snapshots_keep_weeks))
        where = SheetSnapshot.sheet_id.in_(sheet_ids) & (SheetSnapshot.for_week < cutoff_week)
        deleted["sheet_snapshots"] = count(SheetSnapshot, where)
        if not body.dry_run and deleted["sheet_snapshots"]:
            db.execute(delete(SheetSnapshot).where(where))

    if body.notifications_read:
        where = (Notification.org_id == org_id) & Notification.read_at.is_not(None)
        deleted["notifications"] = count(Notification, where)
        if not body.dry_run and deleted["notifications"]:
            db.execute(delete(Notification).where(where))

    if body.empty_effort:
        where = (
            EffortEntry.row_id.in_(row_ids)
            & EffortEntry.planned_hours.is_(None)
            & EffortEntry.actual_hours.is_(None)
        )
        deleted["effort_entries"] = count(EffortEntry, where)
        if not body.dry_run and deleted["effort_entries"]:
            db.execute(delete(EffortEntry).where(where))

    if body.orphan_cells or body.legacy_cells:
        cells = 0
        for sheet in db.execute(select(Sheet).where(Sheet.org_id == org_id)).scalars():
            col_ids = {
                str(cid)
                for cid in db.execute(
                    select(Column.id).where(Column.sheet_id == sheet.id)
                ).scalars()
            }
            start_col, end_col = sched_columns(db, sheet.id)
            legacy_pairs = [
                (LEGACY_START_KEY, str(start_col.id) if start_col else None),
                (LEGACY_END_KEY, str(end_col.id) if end_col else None),
            ]
            for row in db.execute(select(Row).where(Row.sheet_id == sheet.id)).scalars():
                data = row.data or {}
                drop: list[str] = []
                if body.orphan_cells:
                    drop += [
                        k for k in data if k not in col_ids and not str(k).startswith("__")
                    ]
                if body.legacy_cells:
                    drop += [
                        key
                        for key, col_id in legacy_pairs
                        if key in data and col_id and data.get(col_id) not in (None, "")
                    ]
                if not drop:
                    continue
                cells += len(drop)
                if not body.dry_run:
                    next_data = {k: v for k, v in data.items() if k not in set(drop)}
                    row.data = next_data
        deleted["orphan_cells"] = cells

    if body.backups_keep is not None:
        keep = max(0, body.backups_keep)
        ids = list(
            db.execute(
                select(Backup.id)
                .where(Backup.org_id == org_id)
                .order_by(Backup.created_at.desc(), Backup.id.desc())
            ).scalars()
        )
        drop_ids = ids[keep:]
        deleted["backups"] = len(drop_ids)
        if not body.dry_run and drop_ids:
            db.execute(delete(Backup).where(Backup.id.in_(drop_ids)))

    if body.dry_run:
        db.rollback()
    else:
        db.commit()

    return {
        "dry_run": body.dry_run,
        "deleted": deleted,
        "total": sum(deleted.values()),
    }
