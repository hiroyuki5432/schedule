"""Rows: auto-numbering + optimistic locking (the concurrent-edit safety net)."""
from __future__ import annotations

from tests.conftest import make_row, make_sheet


def test_create_row_autonumbers(auth_client):
    sid = make_sheet(auth_client)
    r1 = make_row(auth_client, sid)
    r2 = make_row(auth_client, sid)
    # Each new row gets a distinct key and version starts at 1.
    assert r1["key_value"] != r2["key_value"]
    assert r1["version"] == 1


def test_update_with_correct_version_succeeds(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    r = auth_client.patch(
        f"/api/rows/{row['id']}",
        json={"data": {"x": "1"}, "version": row["version"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == row["version"] + 1
    assert r.json()["data"]["x"] == "1"


def test_stale_version_conflicts(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    # First edit bumps the version to 2.
    auth_client.patch(
        f"/api/rows/{row['id']}",
        json={"data": {"x": "1"}, "version": row["version"]},
    )
    # A second edit using the STALE original version must be rejected with 409
    # and return the current record so the client can refresh.
    r = auth_client.patch(
        f"/api/rows/{row['id']}",
        json={"data": {"x": "2"}, "version": row["version"]},
    )
    assert r.status_code == 409, r.text
    body = r.json()
    assert "current" in body
    assert body["current"]["version"] == 2
    # The losing edit did not take effect.
    assert body["current"]["data"].get("x") == "1"


# --------------------------------------------------------------------------- #
# まとめて削除（要望: まとめて選択して削除）
# --------------------------------------------------------------------------- #
def test_bulk_delete_removes_every_selected_row(auth_client):
    sheet_id = make_sheet(auth_client)
    ids = [make_row(auth_client, sheet_id)["id"] for _ in range(4)]

    r = auth_client.post("/api/rows/bulk-delete", json={"ids": ids[:3]})
    assert r.status_code == 200, r.text
    assert r.json() == {"deleted": 3}

    left = auth_client.get(f"/api/sheets/{sheet_id}/rows").json()
    assert [row["id"] for row in left] == [ids[3]]


def test_bulk_delete_counts_children_taken_with_their_parent(auth_client):
    sheet_id = make_sheet(auth_client)
    parent = make_row(auth_client, sheet_id)
    for _ in range(2):
        c = auth_client.post(f"/api/rows/{parent['id']}/children", json={"data": {}})
        assert c.status_code == 201, c.text

    r = auth_client.post("/api/rows/bulk-delete", json={"ids": [parent["id"]]})
    assert r.json() == {"deleted": 3}  # 親1 + 子2
    assert auth_client.get(f"/api/sheets/{sheet_id}/rows").json() == []


def test_bulk_delete_is_all_or_nothing_across_sheets(auth_client, client, org_admin):
    """他組織の行IDを混ぜても、こちらの行まで巻き添えで消えない。"""
    sheet_id = make_sheet(auth_client)
    mine = make_row(auth_client, sheet_id)["id"]

    r = auth_client.post("/api/rows/bulk-delete", json={"ids": [mine, 999999]})
    assert r.status_code == 404
    # 1件も消えていない。
    left = auth_client.get(f"/api/sheets/{sheet_id}/rows").json()
    assert [row["id"] for row in left] == [mine]


def test_bulk_delete_of_nothing_is_a_no_op(auth_client):
    assert auth_client.post("/api/rows/bulk-delete", json={"ids": []}).json() == {
        "deleted": 0
    }


def test_bulk_delete_is_recorded_in_the_sheet_history(auth_client):
    sheet_id = make_sheet(auth_client)
    ids = [make_row(auth_client, sheet_id)["id"] for _ in range(2)]
    auth_client.post("/api/rows/bulk-delete", json={"ids": ids})

    events = auth_client.get(f"/api/sheets/{sheet_id}/history").json()
    deletes = [e for e in events if e["kind"] == "delete"]
    assert len(deletes) == 2
