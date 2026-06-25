"""Excel export/import round-trip (upsert by ID, attributes + weekly effort)."""
from __future__ import annotations

import io

from openpyxl import Workbook, load_workbook

from .conftest import make_sheet

_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# A phase → ◇ → phase template (既定マイルストン).
TEMPLATE = [
    {"name": "設計", "kind": "phase", "weight": 1},
    {"name": "レビュー", "kind": "milestone"},
    {"name": "実装", "kind": "phase", "weight": 1},
]


def _add_text_column(client, sheet_id: int, name: str) -> int:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": "text"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _set_template(client, sheet_id: int, items: list) -> None:
    r = client.patch(f"/api/sheets/{sheet_id}", json={"settings": {"default_milestones": items}})
    assert r.status_code == 200, r.text


def _sched_col_ids(client, sheet_id: int) -> tuple[str, str]:
    """GET the sheet (creates 開始日/完了日 columns) and return their (start, end) ids."""
    detail = client.get(f"/api/sheets/{sheet_id}").json()
    start = end = None
    for c in detail["columns"]:
        role = (c.get("config") or {}).get("sched_role")
        if role == "start":
            start = str(c["id"])
        elif role == "end":
            end = str(c["id"])
    assert start and end
    return start, end


def test_export_xlsx_has_header_and_rows(auth_client):
    sid = make_sheet(auth_client, "X")
    col = _add_text_column(auth_client, sid, "件名")
    auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "A-1", "data": {str(col): "設計"}})

    r = auth_client.get(f"/api/sheets/{sid}/export.xlsx")
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    header = [c.value for c in ws[1]]
    assert header[0] == "ID"
    assert "件名" in header
    values = [[c.value for c in row] for row in ws.iter_rows(min_row=2)]
    assert any(v[0] == "A-1" for v in values)


def test_import_upserts_by_id(auth_client):
    sid = make_sheet(auth_client, "Y")
    col = _add_text_column(auth_client, sid, "件名")
    auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "A-1", "data": {str(col): "旧"}})

    # Build an xlsx: update A-1, add new B-2.
    wb = Workbook()
    ws = wb.active
    ws.append(["ID", "件名"])
    ws.append(["A-1", "新"])
    ws.append(["B-2", "追加"])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    r = auth_client.post(
        f"/api/sheets/{sid}/import.xlsx",
        files={"file": ("in.xlsx", buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"created": 1, "updated": 1}

    rows = auth_client.get(f"/api/sheets/{sid}/rows").json()
    by_key = {row["key_value"]: row for row in rows}
    assert by_key["A-1"]["data"][str(col)] == "新"  # updated, not duplicated
    assert by_key["B-2"]["data"][str(col)] == "追加"  # newly created
    assert len(rows) == 2


def test_import_ignores_lookup_columns(auth_client):
    sid = make_sheet(auth_client, "L")
    col = _add_text_column(auth_client, sid, "件名")
    lk = auth_client.post(
        f"/api/sheets/{sid}/columns",
        json={"name": "参照値", "type": "lookup", "config": {}},
    )
    assert lk.status_code in (200, 201), lk.text
    lk_id = lk.json()["id"]

    wb = Workbook()
    ws = wb.active
    ws.append(["ID", "件名", "参照値"])
    ws.append(["A-1", "設計", "勝手な値"])  # lookup cell should be ignored
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    r = auth_client.post(
        f"/api/sheets/{sid}/import.xlsx",
        files={"file": ("in.xlsx", buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert r.status_code == 200, r.text
    rows = auth_client.get(f"/api/sheets/{sid}/rows").json()
    data = rows[0]["data"]
    assert data[str(col)] == "設計"
    assert str(lk_id) not in data  # lookup value never written


def test_export_has_sched_and_template_milestone_columns(auth_client):
    sid = make_sheet(auth_client, "M")
    _add_text_column(auth_client, sid, "件名")
    _set_template(auth_client, sid, TEMPLATE)
    start_id, end_id = _sched_col_ids(auth_client, sid)

    r = auth_client.post(
        f"/api/sheets/{sid}/rows",
        json={"key_value": "A-1", "data": {start_id: "2026-01-01", end_id: "2026-03-01"}},
    )
    rid = r.json()["id"]
    auth_client.put(
        f"/api/rows/{rid}/milestones",
        json=[
            {"name": "設計", "kind": "phase", "boundary_date": "2026-01-01", "order": 0},
            {"name": "レビュー", "kind": "milestone", "boundary_date": "2026-02-01",
             "order": 1, "done": True, "actual_date": "2026-02-05"},
            {"name": "実装", "kind": "phase", "boundary_date": "2026-02-01", "order": 2},
        ],
    )

    ws = load_workbook(io.BytesIO(auth_client.get(f"/api/sheets/{sid}/export.xlsx").content)).active
    header = [c.value for c in ws[1]]
    for h in ("開始日", "完了日", "進捗(%)", "先行タスク(ID)", "レビュー（予定）", "レビュー（実績）"):
        assert h in header, h
    a1 = next([c.value for c in row] for row in ws.iter_rows(min_row=2) if row[0].value == "A-1")
    assert a1[header.index("開始日")] == "2026-01-01"
    assert a1[header.index("レビュー（予定）")] == "2026-02-01"
    assert a1[header.index("レビュー（実績）")] == "2026-02-05"


def test_export_clear_import_round_trip(auth_client):
    """Export → clear the sheet → re-import fully restores rows, span, milestones,
    進捗 and 先行タスク (deps round-trip by key_value, resolved after import)."""
    sid = make_sheet(auth_client, "RT")
    col = _add_text_column(auth_client, sid, "件名")
    _set_template(auth_client, sid, TEMPLATE)
    start_id, end_id = _sched_col_ids(auth_client, sid)

    auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "T-0", "data": {str(col): "前工程"}})
    r = auth_client.post(
        f"/api/sheets/{sid}/rows",
        json={"key_value": "T-1", "data": {str(col): "作業", start_id: "2026-01-01", end_id: "2026-03-01"}},
    )
    body = r.json()
    rid = body["id"]
    t0_id = next(
        x["id"] for x in auth_client.get(f"/api/sheets/{sid}/rows").json() if x["key_value"] == "T-0"
    )
    auth_client.patch(
        f"/api/rows/{rid}",
        json={"data": body["data"], "version": body["version"], "progress": 40, "depends_on": [int(t0_id)]},
    )
    auth_client.put(
        f"/api/rows/{rid}/milestones",
        json=[
            {"name": "設計", "kind": "phase", "boundary_date": "2026-01-01", "order": 0},
            {"name": "レビュー", "kind": "milestone", "boundary_date": "2026-02-01", "order": 1},
            {"name": "実装", "kind": "phase", "boundary_date": "2026-02-01", "order": 2},
        ],
    )

    blob = auth_client.get(f"/api/sheets/{sid}/export.xlsx").content
    assert auth_client.delete(f"/api/sheets/{sid}/rows").status_code == 200
    r = auth_client.post(f"/api/sheets/{sid}/import.xlsx", files={"file": ("rt.xlsx", io.BytesIO(blob), _MEDIA)})
    assert r.status_code == 200, r.text

    rows = {x["key_value"]: x for x in auth_client.get(f"/api/sheets/{sid}/rows").json()}
    t1 = rows["T-1"]
    assert t1["data"][start_id] == "2026-01-01"
    assert t1["progress"] == 40
    assert t1["depends_on"] == [int(rows["T-0"]["id"])]
    ms = sorted(auth_client.get(f"/api/rows/{t1['id']}/milestones").json(), key=lambda m: m["order"])
    assert [(m["name"], m["kind"], m["boundary_date"]) for m in ms] == [
        ("設計", "phase", "2026-01-01"),
        ("レビュー", "milestone", "2026-02-01"),
        ("実装", "phase", "2026-02-01"),  # phase boundary reconstructed from ◇
    ]


def test_import_weekly_effort_future_planned(auth_client):
    sid = make_sheet(auth_client, "Z")  # week-grid sheet
    _add_text_column(auth_client, sid, "件名")

    wb = Workbook()
    ws = wb.active
    ws.append(["ID", "件名", "2099-01-05"])  # far-future week → planned
    ws.append(["W-1", "作業", 12])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    r = auth_client.post(
        f"/api/sheets/{sid}/import.xlsx",
        files={"file": ("in.xlsx", buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert r.status_code == 200, r.text

    effort = auth_client.get(f"/api/sheets/{sid}/effort").json()
    assert len(effort) == 1
    assert float(effort[0]["planned_hours"]) == 12.0
    assert effort[0]["actual_hours"] is None
