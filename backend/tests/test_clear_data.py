"""Clearing a sheet's / the whole org's data keeps columns + settings, resets 採番."""
from __future__ import annotations

from .conftest import make_sheet


def _add_text_column(client, sheet_id: int, name: str) -> int:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": "text"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _seed_row(client, sheet_id: int) -> dict:
    """A row (auto-numbered) with one week of effort + one milestone."""
    row = client.post(f"/api/sheets/{sheet_id}/rows", json={"data": {}}).json()
    rid = row["id"]
    client.put(f"/api/rows/{rid}/effort/2099-01-05", json={"planned_hours": 8})
    client.put(
        f"/api/rows/{rid}/milestones",
        json=[{"name": "設計", "kind": "phase", "boundary_date": "2099-01-05", "order": 0}],
    )
    return row


def test_clear_sheet_rows_keeps_columns_and_resets_numbering(auth_client):
    sid = make_sheet(auth_client, "C")
    col = _add_text_column(auth_client, sid, "件名")
    # Two auto-numbered rows → keys 001, 002 (advances next_seq to 3).
    r1 = _seed_row(auth_client, sid)
    r2 = _seed_row(auth_client, sid)
    assert {r1["key_value"], r2["key_value"]} == {"001", "002"}

    r = auth_client.delete(f"/api/sheets/{sid}/rows")
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == 2

    assert auth_client.get(f"/api/sheets/{sid}/rows").json() == []
    assert auth_client.get(f"/api/sheets/{sid}/effort").json() == []
    # Column + sheet survive.
    cols = auth_client.get(f"/api/sheets/{sid}/columns").json()
    assert [c["id"] for c in cols] == [col]
    # 採番 reset: next auto row is 001 again.
    again = auth_client.post(f"/api/sheets/{sid}/rows", json={"data": {}}).json()
    assert again["key_value"] == "001"


def test_clear_org_data_clears_every_sheet(auth_client):
    s1 = make_sheet(auth_client, "O1")
    s2 = make_sheet(auth_client, "O2")
    _add_text_column(auth_client, s1, "件名")
    _seed_row(auth_client, s1)
    _seed_row(auth_client, s2)

    r = auth_client.post("/api/org/clear-data")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sheets"] == 2
    assert body["deleted"] == 2

    assert auth_client.get(f"/api/sheets/{s1}/rows").json() == []
    assert auth_client.get(f"/api/sheets/{s2}/rows").json() == []
