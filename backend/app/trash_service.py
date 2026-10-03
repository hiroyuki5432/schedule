"""ゴミ箱 — 行の削除を取り消せるようにする（要望: Excel なら Ctrl+Z で戻せる）。

削除するときに、消える行の中身をまるごと ``deleted_rows`` に写してから消す。
戻すときは、写しておいたものを **同じID** で書き戻す。

同じIDで戻す理由:
  * 他の行の「先行タスク」（rows.depends_on）は行IDを持っている。削除しても他の行の
    depends_on は書き換えないので、同じIDで戻せば依存関係はそのままつながる。
  * 変更履歴（row_events）と日報（work_logs）は、行が消えると row_id が NULL になる
    （履歴と日報は残す設計）。どの記録がこの行のものだったかを控えておき、戻すときに
    結び直す。新しいIDで戻すと、日報の実績が別の行のものになってしまう。
  * IDは全体の通し番号から払い出され、再利用されないので、同じIDが空いている。

消える範囲は「選んだ行 ＋ その子タスク」（親を消すと子は DB の CASCADE で消える）。
子タスクを持つ親を戻せば子も戻る。子だけを消して、その後で親も消していた場合、
子を戻す時点で親が居ないので、子は親なし（最上位の行）として戻し、そう伝える。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app import history_service
from app.backup_service import _coerce_for_insert, _json_safe, _resync_sequence
from app.models import (
    CellNote,
    DeletedRowBatch,
    EffortEntry,
    Row,
    RowEvent,
    RowMilestone,
    Sheet,
    User,
    WorkLog,
)

#: 一覧に出す ID の数（それ以上は「ほか N 件」）。
_KEYS_SHOWN = 8


class RestoreError(Exception):
    """戻せないとき。メッセージはそのまま画面に出す。"""


def _dump_model(obj) -> dict[str, Any]:
    """1件をそのまま JSON に（属性名＝列名のモデルだけに使う）。"""
    return {c.name: _json_safe(getattr(obj, c.name)) for c in obj.__table__.columns}


def _keys_label(rows: list[Row]) -> str:
    keys = [r.key_value or "(IDなし)" for r in rows if r.parent_row_id is None] or [
        r.key_value or "(IDなし)" for r in rows
    ]
    head = keys[:_KEYS_SHOWN]
    rest = len(keys) - len(head)
    return "、".join(head) + (f" ほか{rest}件" if rest > 0 else "")


def trash_rows(db: Session, user: User, sheet: Sheet, selected: list[Row]) -> DeletedRowBatch:
    """選ばれた行（＋子タスク）をゴミ箱に写してから消す。commit はしない。

    変更履歴の「行を削除」もここで残す（呼び出し側に任せると入口ごとに漏れる）。
    """
    selected_ids = {r.id for r in selected}
    children = list(
        db.execute(
            select(Row).where(
                Row.parent_row_id.in_(selected_ids), Row.id.not_in(selected_ids)
            )
        ).scalars()
    ) if selected_ids else []
    all_rows = [*selected, *children]
    ids = [r.id for r in all_rows]

    payload = {
        "rows": [_dump_model(r) for r in all_rows],
        "effort": [
            _dump_model(e)
            for e in db.execute(select(EffortEntry).where(EffortEntry.row_id.in_(ids))).scalars()
        ],
        "milestones": [
            _dump_model(m)
            for m in db.execute(select(RowMilestone).where(RowMilestone.row_id.in_(ids))).scalars()
        ],
        "notes": [
            _dump_model(n)
            for n in db.execute(select(CellNote).where(CellNote.row_id.in_(ids))).scalars()
        ],
        # 行が消えると row_id が NULL になるもの。戻すときに結び直すため
        # 「どの記録がどの行のものだったか」を控える（{記録ID: 行ID}）。
        "worklog_owner": {
            str(wid): rid
            for wid, rid in db.execute(
                select(WorkLog.id, WorkLog.row_id).where(WorkLog.row_id.in_(ids))
            ).all()
        },
    }

    batch = DeletedRowBatch(
        org_id=sheet.org_id,
        sheet_id=sheet.id,
        row_count=len(all_rows),
        row_keys=_keys_label(all_rows),
        payload=payload,
        deleted_by=user.id,
        deleted_by_name=user.name,
    )
    db.add(batch)

    for r in selected:
        history_service.record(
            db, user=user, row=r, kind="delete", changes=[("行を削除", r.key_value or "", None)]
        )
    for c in children:
        history_service.record(
            db,
            user=user,
            row=c,
            kind="delete",
            changes=[("行を削除（親の削除に伴う）", c.key_value or "", None)],
        )
    # 履歴（row_id を持つ）を先に書き出してから消す — 消した後だと SET NULL が
    # 効かないまま行の無い row_id を指してしまう。
    db.flush()
    event_owner = {
        str(eid): rid
        for eid, rid in db.execute(
            select(RowEvent.id, RowEvent.row_id).where(RowEvent.row_id.in_(ids))
        ).all()
    }
    # 新しい dict を代入する（元の dict を書き換えると、ORM が「変わっていない」と
    # 判断して UPDATE を出さず、控えが保存されない）。
    batch.payload = {**payload, "event_owner": event_owner}
    flag_modified(batch, "payload")
    # 親と一緒に選ばれた子タスクは、親の削除（DB の CASCADE）で消える。ORM からも
    # 消そうとすると、順番しだいで「もう無い行を消そうとした」エラーになる。
    for r in selected:
        if r.parent_row_id is None or r.parent_row_id not in selected_ids:
            db.delete(r)
    db.flush()
    return batch


def restore(db: Session, user: User, batch: DeletedRowBatch) -> dict[str, Any]:
    """ゴミ箱の1件を元に戻す。commit はしない。戻したらゴミ箱から消す。"""
    payload = batch.payload or {}
    rows = list(payload.get("rows") or [])
    if not rows:
        db.delete(batch)
        return {"restored": 0, "row_ids": [], "notes": []}

    ids = [int(r["id"]) for r in rows]
    taken = set(db.execute(select(Row.id).where(Row.id.in_(ids))).scalars())
    if taken:
        raise RestoreError("この行はすでに元に戻されています")

    notes: list[str] = []
    restoring = set(ids)
    parent_ids = {int(r["parent_row_id"]) for r in rows if r.get("parent_row_id")}
    outside = parent_ids - restoring
    alive = (
        set(db.execute(select(Row.id).where(Row.id.in_(outside))).scalars()) if outside else set()
    )
    for r in rows:
        pid = r.get("parent_row_id")
        if pid and int(pid) not in restoring and int(pid) not in alive:
            r["parent_row_id"] = None
            notes.append(
                f"「{r.get('key_value') or ''}」の親タスクが見つからないため、親なしの行として戻しました"
            )

    # 親 → 子 の順に入れる（parent_row_id の外部キーは1行ずつ確かめられる）。
    rows.sort(key=lambda r: (r.get("parent_row_id") is not None, int(r["id"])))
    row_t = Row.__table__
    db.execute(insert(row_t), [_coerce_for_insert(row_t, r) for r in rows])
    for table, key in (
        (EffortEntry.__table__, "effort"),
        (RowMilestone.__table__, "milestones"),
        (CellNote.__table__, "notes"),
    ):
        data = [_coerce_for_insert(table, x) for x in (payload.get(key) or [])]
        if data:
            db.execute(insert(table), data)

    # 消したときに外れた結びつき（変更履歴・日報の row_id）を戻す。その後で別の
    # 行に付け替えられたもの（row_id が NULL でない）には触らない。
    for model, key in ((RowEvent, "event_owner"), (WorkLog, "worklog_owner")):
        for rec_id, row_id in (payload.get(key) or {}).items():
            db.execute(
                update(model)
                .where(model.id == int(rec_id), model.row_id.is_(None))
                .values(row_id=int(row_id))
            )

    db.flush()
    restored_rows = list(db.execute(select(Row).where(Row.id.in_(ids))).scalars())
    for r in restored_rows:
        history_service.record(
            db, user=user, row=r, kind="create", changes=[("行を元に戻す", None, r.key_value or "")]
        )

    # 通し番号を、書き戻した ID より先へ進めておく（念のため。IDは再利用されないので
    # 普通は進んでいるが、バックアップから復元した直後などは保証がない）。
    for name in ("rows", "effort_entries", "row_milestones", "cell_notes"):
        _resync_sequence(db, name)

    db.delete(batch)
    db.flush()
    return {"restored": len(ids), "row_ids": ids, "notes": notes}
