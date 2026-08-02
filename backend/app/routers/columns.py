"""Column CRUD."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.date_values import normalize_date_text
from app.db import get_db
from app.deps import get_column_for_user, get_sheet_for_user
from app.models import Column, Row, Sheet, User
from app.schemas import ColumnCreate, ColumnOut, ColumnUpdate
from app.security import current_user

router = APIRouter(prefix="/api", tags=["columns"])


@router.get("/sheets/{sheet_id}/columns", response_model=list[ColumnOut])
def list_columns(
    sheet_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[Column]:
    get_sheet_for_user(db, sheet_id, user)
    return list(
        db.execute(
            select(Column).where(Column.sheet_id == sheet_id).order_by(Column.order, Column.id)
        ).scalars()
    )


@router.post("/sheets/{sheet_id}/columns", response_model=ColumnOut, status_code=status.HTTP_201_CREATED)
def create_column(
    sheet_id: int,
    payload: ColumnCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Column:
    get_sheet_for_user(db, sheet_id, user)
    order = payload.order
    if order is None:
        order = db.execute(
            select(func.coalesce(func.max(Column.order), -1)).where(Column.sheet_id == sheet_id)
        ).scalar_one() + 1
    column = Column(
        sheet_id=sheet_id,
        name=payload.name,
        type=payload.type,
        order=order,
        is_key=bool(payload.is_key),
        config=payload.config or {},
    )
    db.add(column)
    db.commit()
    db.refresh(column)
    return column


@router.patch("/columns/{column_id}", response_model=ColumnOut)
def update_column(
    column_id: int,
    payload: ColumnUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Column:
    column = get_column_for_user(db, column_id, user)
    fields = payload.model_dump(exclude_unset=True)

    # When a dropdown's option values are renamed, follow the change through to the
    # stored data so existing rows keep their (renamed) value (要望: リスト名を変えても
    # データが追従). Options are matched by their stable `id`; only changed values
    # are remapped.
    rename_map: dict[str, str] = {}
    if "config" in fields and column.type == "dropdown":
        old_by_id = {
            o.get("id"): o.get("value")
            for o in (column.config or {}).get("options", [])
            if o.get("id")
        }
        for o in fields["config"].get("options", []) or []:
            oid, new_val = o.get("id"), o.get("value")
            old_val = old_by_id.get(oid)
            if oid and old_val is not None and new_val and old_val != new_val:
                rename_map[old_val] = new_val

    # 数式列は列を NAME で参照する（`[単価] * [数量]`）。名前を変えたら、同じシートの
    # 数式のほうも書き換える — そうしないと、列名を直した瞬間に数式が「そんな列は
    # ない」になる（要望: リスト名を変えてもデータが追従、と同じ考え方）。
    old_name = column.name
    new_name = str(fields.get("name") or "").strip()

    for key, value in fields.items():
        setattr(column, key, value)

    if new_name and new_name != old_name:
        _rewrite_formula_refs(db, column.sheet_id, old_name, new_name)

    # 日付に変えたら、入っている値も 'YYYY-MM-DD' に直す。要望: 取り込みで
    # `2025-10-18 00:00:00` になった列を日付に変えても時刻が残ったまま。型だけ変えても
    # 中身は文字列のままなので、並べ替えも期間計算も効かなかった。
    #
    # 既に日付型の列に対して type="date" を投げ直したときも走らせる — 直す手段が
    # 「一度 自由入力 に戻してから日付に戻す」しかないのは、直し方として不親切なので
    # （シート設定の「値を日付に揃える」がこれを呼ぶ）。
    if fields.get("type") == "date":
        _normalize_date_values(db, column)

    if rename_map:
        col_key = str(column.id)
        rows = db.execute(
            select(Row).where(Row.sheet_id == column.sheet_id)
        ).scalars()
        for r in rows:
            cur = (r.data or {}).get(col_key)
            if cur in rename_map:
                data = dict(r.data or {})
                data[col_key] = rename_map[cur]
                r.data = data

    db.commit()
    db.refresh(column)
    return column


def _normalize_date_values(db: Session, column: Column) -> None:
    """この列に入っている値を日付の保存形（'YYYY-MM-DD'）に揃える。呼び出し側が commit。

    `2025-10-18 00:00:00` や `2025/10/18` を日付に直す。読めない値（「未定」など）は
    そのまま残す — 型を変えただけでデータが消えるのは論外なので。
    """
    col_key = str(column.id)
    rows = db.execute(select(Row).where(Row.sheet_id == column.sheet_id)).scalars()
    for r in rows:
        current = (r.data or {}).get(col_key)
        if current is None or current == "":
            continue
        fixed = normalize_date_text(current)
        if fixed == current:
            continue
        data = dict(r.data or {})
        if fixed is None:
            data.pop(col_key, None)
        else:
            data[col_key] = fixed
        r.data = data


def _rewrite_formula_refs(db: Session, sheet_id: int, old_name: str, new_name: str) -> None:
    """同じシートの数式列の `[旧名]` を `[新名]` に置き換える（呼び出し側が commit する）。

    参照は `[名前]` の形しかないので、単純な置換で足りる。空白を挟んだ `[ 名前 ]` も
    式としては有効だが、そこまでは追わない（数式エディタが出すのは詰めた形）。
    """
    if not old_name or old_name == new_name:
        return
    columns = db.execute(
        select(Column).where(Column.sheet_id == sheet_id, Column.type == "formula")
    ).scalars()
    for c in columns:
        expr = (c.config or {}).get("expr")
        if not isinstance(expr, str) or f"[{old_name}]" not in expr:
            continue
        config = dict(c.config or {})
        config["expr"] = expr.replace(f"[{old_name}]", f"[{new_name}]")
        c.config = config


@router.delete("/columns/{column_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_column(
    column_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> Response:
    column = get_column_for_user(db, column_id, user)
    # Clear sheet references to this column if set.
    sheet = db.get(Sheet, column.sheet_id)
    if sheet is not None:
        if sheet.key_column_id == column.id:
            sheet.key_column_id = None
        if sheet.color_basis_column_id == column.id:
            sheet.color_basis_column_id = None
    db.delete(column)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
