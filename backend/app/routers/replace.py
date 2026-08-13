"""一括置換（列だけ / シート全体）。

要望: 「列のみやシートの一括置換ができるといい」。取り込んだ表記ゆれ（「(株)」→
「株式会社」、旧部署名、全角の混入…）を直すのに、いままではセルを1つずつ開くしか
なかった。Excel の「すべて置換」に当たるものが要る。

設計で外せなかった点:

- **必ず先に件数と例を見せる**（`dry_run`）。置換は取り消せない操作で、しかも部分一致
  は思ったより広く当たる（「東京」で「東京海上」まで書き換わる）。実行前に「何行・
  何セル・どんな見た目になるか」を出す。
- **計算列（参照・数式）は対象外**。値を持っていないので書いても次の再計算で消える。
- **プルダウンは選択肢も一緒に置換する**。データだけ直すと、値は変わったのに選択肢は
  古いまま＝「選択肢に無い値」が並ぶ（取り込みで一度やらかしている道）。
- **変更履歴に残す**。誰がいつ何を一括で書き換えたのかは、後から必ず訊かれる。
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import history_service
from app.date_values import normalize_date_text
from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import Column, Row, User
from app.schemas import COMPUTED_COLUMN_TYPES, ReplaceRequest, ReplaceResult
from app.security import current_user

router = APIRouter(prefix="/api/sheets", tags=["replace"])

#: How many before/after examples come back with the dry run.
SAMPLE_LIMIT = 30

#: ID(key_value) を指す擬似的な列キー。列一覧には無いので別扱いする。
KEY_COLUMN = "__id__"


def _apply(text: str, find: str, replace: str, whole_cell: bool, case_sensitive: bool) -> str | None:
    """置換後の文字列。当たらなければ None。

    `whole_cell` はセル全体が `find` と同じときだけ差し替える（Excel の「セル内容が
    完全に同一であるものを検索する」）。部分一致のときは大文字小文字の扱いを揃えるため
    正規表現で回す — `str.replace` には ignore-case が無いので。
    """
    if whole_cell:
        hit = text == find if case_sensitive else text.casefold() == find.casefold()
        return replace if hit else None
    if case_sensitive:
        return text.replace(find, replace) if find in text else None
    pattern = re.compile(re.escape(find), re.IGNORECASE)
    return pattern.sub(lambda _m: replace, text) if pattern.search(text) else None


def _store(column: Column | None, text: str):
    """置換後の文字列を、その列の保存形に戻す。

    数値列に `"1200"` を文字列で書くと並べ替えも合計もおかしくなるので、数値として
    読めるなら数値で保存する。日付列も保存形（YYYY-MM-DD）に揃える。読めない値は
    文字列のまま残す — 置換で消えるほうが困るので。
    """
    if text == "":
        return None
    if column is None:
        return text
    if column.type == "number":
        try:
            num = float(text)
        except ValueError:
            return text
        return int(num) if num == int(num) else num
    if column.type == "date":
        return normalize_date_text(text) or text
    return text


def _cell_text(value) -> str:
    """セルの値を、置換の対象になる文字列にする。"""
    if value is None or isinstance(value, (list, dict, bool)):
        return ""
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value)


@router.post("/{sheet_id}/replace", response_model=ReplaceResult)
def replace_values(
    sheet_id: int,
    body: ReplaceRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> ReplaceResult:
    """このシートの値を一括で置換する。`dry_run` なら何も書かずに件数と例だけ返す。"""
    sheet = get_sheet_for_user(db, sheet_id, user)
    find = body.find
    if find == "":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="検索する文字列を入れてください"
        )

    columns = list(
        db.execute(
            select(Column).where(Column.sheet_id == sheet.id).order_by(Column.order, Column.id)
        ).scalars()
    )
    by_id = {str(c.id): c for c in columns}

    # 対象の列。単一指定のときはその列だけ（存在と所属を確かめる）。ID(key_value) は
    # 列一覧に無いので `__id__` という擬似キーで指す。
    scope = (body.column_id or "").strip()
    if scope == KEY_COLUMN:
        targets: list[Column] = []
        touch_key = True
    elif scope:
        target = by_id.get(scope)
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="列が見つかりません"
            )
        if target.type in COMPUTED_COLUMN_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"「{target.name}」は計算列（参照/数式）なので置換できません",
            )
        targets = [target]
        touch_key = False
    else:
        targets = [c for c in columns if c.type not in COMPUTED_COLUMN_TYPES]
        # シート全体でも ID まで書き換えるのは、頼まれたときだけ（IDを変えると
        # 参照(LOOKUP)や先行タスクの当たり先が動くため）。
        touch_key = body.include_key

    target_ids = [str(c.id) for c in targets]

    rows = list(
        db.execute(select(Row).where(Row.sheet_id == sheet.id).order_by(Row.id)).scalars()
    )

    samples: list[dict] = []
    changed_rows = 0
    changed_cells = 0

    for row in rows:
        data = dict(row.data or {})
        hits: list[tuple[str, str, str]] = []  # (label, before, after) for the history
        row_changed = False

        for cid in target_ids:
            before = _cell_text(data.get(cid))
            if before == "":
                continue
            after = _apply(before, find, body.replace, body.whole_cell, body.case_sensitive)
            if after is None or after == before:
                continue
            changed_cells += 1
            row_changed = True
            col = by_id.get(cid)
            if len(samples) < SAMPLE_LIMIT:
                samples.append(
                    {
                        "row_key": row.key_value or "",
                        "column_name": col.name if col else cid,
                        "before": before,
                        "after": after,
                    }
                )
            if not body.dry_run:
                stored = _store(col, after)
                if stored is None:
                    data.pop(cid, None)
                else:
                    data[cid] = stored
                hits.append((col.name if col else cid, before, after))

        if touch_key and row.key_value:
            after = _apply(
                row.key_value, find, body.replace, body.whole_cell, body.case_sensitive
            )
            if after is not None and after != row.key_value:
                changed_cells += 1
                row_changed = True
                if len(samples) < SAMPLE_LIMIT:
                    samples.append(
                        {
                            "row_key": row.key_value,
                            "column_name": "ID",
                            "before": row.key_value,
                            "after": after,
                        }
                    )
                if not body.dry_run:
                    hits.append(("ID", row.key_value, after))
                    row.key_value = after or None

        if row_changed:
            changed_rows += 1
        if hits and not body.dry_run:
            row.data = data
            row.version = (row.version or 1) + 1
            row.updated_by = user.id
            history_service.record(db, user=user, row=row, kind="update", changes=hits)

    # プルダウンの選択肢そのもの。データだけ直すと「選択肢に無い値」が並ぶので、
    # 既定では一緒に置換する。重複した選択肢は畳む。
    option_changes = 0
    if body.include_options:
        for col in targets:
            if col.type != "dropdown":
                continue
            options = list((col.config or {}).get("options") or [])
            if not options:
                continue
            next_options: list[dict] = []
            seen: set[str] = set()
            touched = False
            for opt in options:
                value = str(opt.get("value") or "")
                after = _apply(
                    value, find, body.replace, body.whole_cell, body.case_sensitive
                )
                new_value = value if after is None else after
                if after is not None and after != value:
                    option_changes += 1
                    touched = True
                # 置換の結果すでにある選択肢と同じになったら、増やさず畳む。
                if new_value == "" or new_value in seen:
                    touched = True
                    continue
                seen.add(new_value)
                next_options.append({**opt, "value": new_value})
            if touched and not body.dry_run:
                col.config = {**(col.config or {}), "options": next_options}

    if not body.dry_run and (changed_cells or option_changes):
        db.commit()
    else:
        db.rollback()

    return ReplaceResult(
        rows=changed_rows,
        cells=changed_cells,
        options=option_changes,
        applied=not body.dry_run,
        samples=samples,  # type: ignore[arg-type]
    )
