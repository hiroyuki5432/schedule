"""セルのメモ と 範囲の書き込み（貼り付け・まとめて消去・フィル）。"""
from __future__ import annotations

from tests.conftest import make_row, make_sheet


def _col(client, sheet_id: int, name: str, type_: str = "text", config: dict | None = None) -> str:
    r = client.post(
        f"/api/sheets/{sheet_id}/columns",
        json={"name": name, "type": type_, "config": config or {}},
    )
    assert r.status_code in (200, 201), r.text
    return str(r.json()["id"])


# --------------------------------------------------------------------------- #
# メモ
# --------------------------------------------------------------------------- #
def test_note_write_overwrite_and_clear(auth_client):
    sid = make_sheet(auth_client)
    col = _col(auth_client, sid, "担当メモ")
    row = make_row(auth_client, sid)

    r = auth_client.put(f"/api/rows/{row['id']}/notes", json={"cell_key": col, "text": "出張中"})
    assert r.status_code == 200, r.text
    assert r.json()["note"]["text"] == "出張中"
    assert r.json()["note"]["updated_by_name"] == "Admin"

    auth_client.put(f"/api/rows/{row['id']}/notes", json={"cell_key": col, "text": "戻り 10/5"})
    notes = auth_client.get(f"/api/sheets/{sid}/notes").json()
    assert [n["text"] for n in notes] == ["戻り 10/5"]

    r = auth_client.put(f"/api/rows/{row['id']}/notes", json={"cell_key": col, "text": "  "})
    assert r.json()["note"] is None
    assert auth_client.get(f"/api/sheets/{sid}/notes").json() == []

    labels = [e["field_label"] for e in auth_client.get(f"/api/rows/{row['id']}/history").json()]
    assert labels.count("メモ（担当メモ）") == 3


def test_notes_on_id_and_week_cells(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    for key in ("__id__", "w:2026-10-05"):
        r = auth_client.put(f"/api/rows/{row['id']}/notes", json={"cell_key": key, "text": "x"})
        assert r.status_code == 200, r.text
    assert len(auth_client.get(f"/api/sheets/{sid}/notes").json()) == 2


def test_note_cell_key_is_validated(auth_client):
    s1 = make_sheet(auth_client, "A")
    s2 = make_sheet(auth_client, "B")
    other_col = _col(auth_client, s2, "よそ")
    row = make_row(auth_client, s1)
    for key in (other_col, "w:2026-13-01", "nonsense"):
        r = auth_client.put(f"/api/rows/{row['id']}/notes", json={"cell_key": key, "text": "x"})
        assert r.status_code == 400, key


def test_deleting_a_column_drops_its_notes(auth_client):
    sid = make_sheet(auth_client)
    col = _col(auth_client, sid, "消す列")
    row = make_row(auth_client, sid)
    auth_client.put(f"/api/rows/{row['id']}/notes", json={"cell_key": col, "text": "x"})
    auth_client.delete(f"/api/columns/{col}")
    assert auth_client.get(f"/api/sheets/{sid}/notes").json() == []


# --------------------------------------------------------------------------- #
# 範囲の書き込み
# --------------------------------------------------------------------------- #
def test_bulk_update_merges_only_the_sent_cells(auth_client):
    sid = make_sheet(auth_client)
    a = _col(auth_client, sid, "A")
    b = _col(auth_client, sid, "B")
    r1 = make_row(auth_client, sid, {a: "1", b: "keep"})
    r2 = make_row(auth_client, sid, {a: "2", b: "keep"})

    r = auth_client.post(
        "/api/rows/bulk-update",
        json={"items": [{"id": r1["id"], "data": {a: "x"}}, {"id": r2["id"], "data": {a: None}}]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 2
    rows = {x["id"]: x for x in auth_client.get(f"/api/sheets/{sid}/rows").json()}
    assert rows[r1["id"]]["data"] == {a: "x", b: "keep"}
    assert rows[r2["id"]]["data"][a] is None
    assert rows[r2["id"]]["data"][b] == "keep"
    assert rows[r1["id"]]["version"] == r1["version"] + 1


def test_bulk_update_does_not_clobber_a_concurrent_edit_of_another_cell(auth_client):
    sid = make_sheet(auth_client)
    a = _col(auth_client, sid, "A")
    b = _col(auth_client, sid, "B")
    row = make_row(auth_client, sid, {a: "1", b: "1"})
    # 他の人が先に B を直した（こちらの画面は古いまま）。
    auth_client.patch(f"/api/rows/{row['id']}", json={"data": {a: "1", b: "他の人"}, "version": 1})
    auth_client.post("/api/rows/bulk-update", json={"items": [{"id": row["id"], "data": {a: "貼った"}}]})
    data = auth_client.get(f"/api/sheets/{sid}/rows").json()[0]["data"]
    assert data == {a: "貼った", b: "他の人"}


def test_bulk_update_normalizes_dates_skips_computed_and_sets_ids(auth_client):
    sid = make_sheet(auth_client)
    d = _col(auth_client, sid, "期日", "date")
    f = _col(auth_client, sid, "計算", "formula", {"expr": "1+1"})
    row = make_row(auth_client, sid)
    r = auth_client.post(
        "/api/rows/bulk-update",
        json={"items": [{"id": row["id"], "data": {d: "2026/10/3", f: "書けない"}, "key_value": "NEW-1"}]},
    )
    assert r.status_code == 200, r.text
    got = auth_client.get(f"/api/sheets/{sid}/rows").json()[0]
    assert got["data"][d] == "2026-10-03"
    assert f not in got["data"]
    assert got["key_value"] == "NEW-1"
    labels = [e["field_label"] for e in auth_client.get(f"/api/rows/{row['id']}/history").json()]
    assert "期日" in labels and "ID" in labels


def test_bulk_update_refuses_rows_of_another_group(auth_client):
    r = auth_client.post("/api/rows/bulk-update", json={"items": [{"id": 999999, "data": {}}]})
    assert r.status_code == 404
