"""Excel export/import round-trip (upsert by ID, attributes + weekly effort)."""
from __future__ import annotations

import io

from openpyxl import Workbook, load_workbook

from .conftest import make_sheet


def _add_text_column(client, sheet_id: int, name: str) -> int:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": "text"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


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
