"""Bulk weekly-effort writes — the range paste / range clear path."""
from __future__ import annotations

from tests.conftest import make_row, make_sheet

W1 = "2026-06-22"  # a Monday
W2 = "2026-06-29"


def test_bulk_creates_and_updates_in_one_request(auth_client):
    sid = make_sheet(auth_client)
    a = make_row(auth_client, sid)
    b = make_row(auth_client, sid)
    # Seed one cell so the call covers both create and update.
    auth_client.put(f"/api/rows/{a['id']}/effort/{W1}", json={"planned_hours": 3})

    r = auth_client.put(
        "/api/effort/bulk",
        json={
            "items": [
                {"row_id": a["id"], "week_start": W1, "planned_hours": 8},
                {"row_id": a["id"], "week_start": W2, "planned_hours": 4},
                {"row_id": b["id"], "week_start": W1, "planned_hours": 5},
            ]
        },
    )
    assert r.status_code == 200, r.text
    assert len(r.json()) == 3

    stored = {
        (e["row_id"], e["week_start"]): float(e["planned_hours"] or 0)
        for e in auth_client.get(f"/api/sheets/{sid}/effort").json()
    }
    assert stored[(a["id"], W1)] == 8
    assert stored[(a["id"], W2)] == 4
    assert stored[(b["id"], W1)] == 5


def test_bulk_null_clears_a_cell(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    auth_client.put(f"/api/rows/{row['id']}/effort/{W1}", json={"planned_hours": 8})

    r = auth_client.put(
        "/api/effort/bulk",
        json={"items": [{"row_id": row["id"], "week_start": W1, "planned_hours": None}]},
    )
    assert r.status_code == 200, r.text
    assert r.json()[0]["planned_hours"] is None


def test_bulk_leaves_the_other_field_alone(auth_client):
    """Pasting planned hours must not wipe the 実績 that came from 日報."""
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    auth_client.put(f"/api/rows/{row['id']}/effort/{W1}", json={"actual_hours": 6})

    auth_client.put(
        "/api/effort/bulk",
        json={"items": [{"row_id": row["id"], "week_start": W1, "planned_hours": 9}]},
    )
    entry = auth_client.get(f"/api/sheets/{sid}/effort").json()[0]
    assert float(entry["planned_hours"]) == 9
    assert float(entry["actual_hours"]) == 6


def test_bulk_is_recorded_in_the_history(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)

    auth_client.put(
        "/api/effort/bulk",
        json={
            "items": [
                {"row_id": row["id"], "week_start": W1, "planned_hours": 8},
                {"row_id": row["id"], "week_start": W2, "planned_hours": 8},
            ]
        },
    )
    events = auth_client.get(f"/api/rows/{row['id']}/history").json()
    assert len([e for e in events if e["kind"] == "effort"]) == 2


def test_bulk_rejects_a_row_from_another_org(auth_client, client, db, org_admin):
    from app import models
    from app.security import hash_password

    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)

    other = models.Organization(name="O2", slug="o2", settings={})
    db.add(other)
    db.flush()
    db.add(
        models.User(
            org_id=other.id,
            email="other@t.local",
            name="Other",
            role="admin",
            password_hash=hash_password("pw123456"),
        )
    )
    db.commit()
    # NOTE: auth_client IS client — logging in here replaces the admin session.
    client.post("/api/auth/login", json={"email": "other@t.local", "password": "pw123456"})

    r = client.put(
        "/api/effort/bulk",
        json={"items": [{"row_id": row["id"], "week_start": W1, "planned_hours": 99}]},
    )
    assert r.status_code == 404

    # Back as the owner: nothing was written.
    client.post(
        "/api/auth/login",
        json={"email": org_admin["email"], "password": org_admin["password"]},
    )
    assert client.get(f"/api/sheets/{sid}/effort").json() == []
