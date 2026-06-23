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
