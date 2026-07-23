"""Cross-sheet task search (「P26-001 ってどのシートだっけ」).

Matches the task ID and every attribute value, over all sheets in the caller's
org. The match runs in the database (JSONB cast to text) so the browser never
has to download every row of every sheet just to filter them.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import String, cast, or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Column, Row, Sheet, User
from app.schemas import SearchHit
from app.security import current_user

router = APIRouter(prefix="/api", tags=["search"])

# Hard cap so a one-letter query can't try to render the whole database.
MAX_RESULTS = 50


def _title_column_id(columns: list[Column]) -> int | None:
    """Same rule the grid uses: the first non-key text column."""
    texts = [c for c in columns if c.type == "text" and not c.is_key]
    col = texts[0] if texts else next((c for c in columns if c.type == "text"), None)
    return col.id if col else None


@router.get("/search", response_model=list[SearchHit])
def search_rows(
    q: str = Query(min_length=1),
    limit: int = MAX_RESULTS,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[SearchHit]:
    needle = q.strip()
    if not needle:
        return []

    sheets = {
        s.id: s
        for s in db.execute(
            select(Sheet).where(Sheet.org_id == user.org_id).order_by(Sheet.order)
        ).scalars()
    }
    if not sheets:
        return []

    pattern = f"%{needle}%"
    rows = list(
        db.execute(
            select(Row)
            .where(
                Row.sheet_id.in_(sheets.keys()),
                or_(
                    Row.key_value.ilike(pattern),
                    cast(Row.data, String).ilike(pattern),
                ),
            )
            .order_by(Row.sheet_id, Row.id)
            .limit(min(limit, MAX_RESULTS))
        ).scalars()
    )
    if not rows:
        return []

    # Column metadata per sheet, fetched once for the sheets that actually hit.
    hit_sheet_ids = {r.sheet_id for r in rows}
    cols_by_sheet: dict[int, list[Column]] = {sid: [] for sid in hit_sheet_ids}
    for c in db.execute(
        select(Column).where(Column.sheet_id.in_(hit_sheet_ids)).order_by(Column.order)
    ).scalars():
        cols_by_sheet[c.sheet_id].append(c)

    lowered = needle.lower()
    out: list[SearchHit] = []
    for r in rows:
        cols = cols_by_sheet.get(r.sheet_id, [])
        title_id = _title_column_id(cols)
        data = r.data or {}
        title = str(data.get(str(title_id), "") or "") if title_id else ""
        out.append(
            SearchHit(
                row_id=r.id,
                sheet_id=r.sheet_id,
                sheet_name=sheets[r.sheet_id].name,
                key_value=r.key_value,
                title=title,
                # Which field matched, so the user can tell WHY a row is listed
                # when neither the ID nor the title contains the query.
                matched_field=_matched_field(data, cols, lowered, r.key_value, title),
            )
        )
    # ID / title matches first — those are what people usually mean.
    out.sort(key=lambda h: 0 if h.matched_field in (None, "ID") else 1)
    return out


def _matched_field(
    data: dict,
    columns: list[Column],
    lowered: str,
    key_value: str | None,
    title: str,
) -> str | None:
    """Name of the column whose value matched, or None for an ID/title match."""
    if key_value and lowered in key_value.lower():
        return "ID"
    if title and lowered in title.lower():
        return None
    for c in columns:
        v = data.get(str(c.id))
        if v is not None and lowered in str(v).lower():
            return c.name
    return None
