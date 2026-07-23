"""Change history (変更履歴): every edit is recorded with who/what/when."""
from __future__ import annotations

from tests.conftest import make_row, make_sheet

WEEK = "2026-06-22"  # a Monday


def _add_column(client, sheet_id: int, name: str, type_: str = "text") -> int:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": type_})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_creating_a_row_is_recorded(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)

    events = auth_client.get(f"/api/rows/{row['id']}/history").json()
    assert [e["kind"] for e in events] == ["create"]
    assert events[0]["user_name"] == "Admin"
    assert events[0]["row_key"] == row["key_value"]


def test_cell_edit_records_column_name_and_both_values(auth_client):
    sid = make_sheet(auth_client)
    col = _add_column(auth_client, sid, "担当メモ")
    row = make_row(auth_client, sid, {str(col): "旧"})

    r = auth_client.patch(
        f"/api/rows/{row['id']}",
        json={"data": {str(col): "新"}, "version": row["version"]},
    )
    assert r.status_code == 200, r.text

    events = auth_client.get(f"/api/rows/{row['id']}/history").json()
    update = next(e for e in events if e["kind"] == "update")
    assert update["field_label"] == "担当メモ"
    assert update["old_value"] == "旧"
    assert update["new_value"] == "新"


def test_unchanged_fields_are_not_recorded(auth_client):
    sid = make_sheet(auth_client)
    col = _add_column(auth_client, sid, "件名")
    row = make_row(auth_client, sid, {str(col): "同じ"})

    auth_client.patch(
        f"/api/rows/{row['id']}",
        json={"data": {str(col): "同じ"}, "version": row["version"]},
    )
    events = auth_client.get(f"/api/rows/{row['id']}/history").json()
    assert [e["kind"] for e in events] == ["create"]


def test_internal_keys_are_not_recorded(auth_client):
    """Bookkeeping keys (週次リセットの週スタンプ等) would be noise in the log."""
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)

    auth_client.patch(
        f"/api/rows/{row['id']}",
        json={"data": {"__wk_9": "2026-06-22"}, "version": row["version"]},
    )
    events = auth_client.get(f"/api/rows/{row['id']}/history").json()
    assert [e["kind"] for e in events] == ["create"]


def test_effort_edit_is_recorded_with_the_week(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)

    auth_client.put(f"/api/rows/{row['id']}/effort/{WEEK}", json={"planned_hours": 8})
    auth_client.put(
        f"/api/rows/{row['id']}/effort/{WEEK}",
        json={"planned_hours": 12, "version": 1},
    )

    events = auth_client.get(f"/api/rows/{row['id']}/history").json()
    effort = [e for e in events if e["kind"] == "effort"]
    assert len(effort) == 2
    # Newest first.
    assert effort[0]["field_label"] == f"予定工数 {WEEK}"
    assert effort[0]["old_value"] == "8h"
    assert effort[0]["new_value"] == "12h"


def test_deleting_a_row_stays_in_the_sheet_history(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)

    assert auth_client.delete(f"/api/rows/{row['id']}").status_code == 204

    events = auth_client.get(f"/api/sheets/{sid}/history").json()
    deleted = next(e for e in events if e["kind"] == "delete")
    # row_id is cleared by the cascade, but the task's ID is preserved.
    assert deleted["row_id"] is None
    assert deleted["row_key"] == row["key_value"]


def test_history_is_scoped_to_the_org(auth_client, client, db):
    """Another org's admin must not see these events."""
    from app import models
    from app.security import hash_password

    sid = make_sheet(auth_client)
    make_row(auth_client, sid)

    other_org = models.Organization(name="O2", slug="o2", settings={})
    db.add(other_org)
    db.flush()
    db.add(
        models.User(
            org_id=other_org.id,
            email="other@t.local",
            name="Other",
            role="admin",
            password_hash=hash_password("pw123456"),
        )
    )
    db.commit()

    client.post("/api/auth/login", json={"email": "other@t.local", "password": "pw123456"})
    assert client.get(f"/api/sheets/{sid}/history").status_code == 404
