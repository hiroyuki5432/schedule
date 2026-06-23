"""Weekly effort upsert + optimistic locking on cells (the most-edited surface)."""
from __future__ import annotations

from tests.conftest import make_row, make_sheet

WEEK = "2026-06-22"  # a Monday


def test_effort_create_then_versioned_update(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    # Create (no version needed).
    r = auth_client.put(
        f"/api/rows/{row['id']}/effort/{WEEK}", json={"planned_hours": 8}
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1
    # Update with the right version bumps it.
    r = auth_client.put(
        f"/api/rows/{row['id']}/effort/{WEEK}",
        json={"planned_hours": 10, "version": 1},
    )
    assert r.status_code == 200
    assert r.json()["version"] == 2
    assert float(r.json()["planned_hours"]) == 10


def test_effort_stale_version_conflicts(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    auth_client.put(f"/api/rows/{row['id']}/effort/{WEEK}", json={"planned_hours": 8})
    # Now version is 1; a concurrent edit using version 0/1 after another bump fails.
    auth_client.put(
        f"/api/rows/{row['id']}/effort/{WEEK}",
        json={"planned_hours": 9, "version": 1},
    )  # -> version 2
    r = auth_client.put(
        f"/api/rows/{row['id']}/effort/{WEEK}",
        json={"planned_hours": 99, "version": 1},
    )
    assert r.status_code == 409, r.text
    assert r.json()["current"]["version"] == 2
    assert float(r.json()["current"]["planned_hours"]) == 9
