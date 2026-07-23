"""Cross-sheet task search (Ctrl+K)."""
from __future__ import annotations

from tests.conftest import make_row, make_sheet


def _add_column(client, sheet_id: int, name: str, type_: str = "text") -> int:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": type_})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_finds_a_task_by_id_across_sheets(auth_client):
    a = make_sheet(auth_client, "設計")
    b = make_sheet(auth_client, "運用")
    make_row(auth_client, a)
    target = auth_client.post(
        f"/api/sheets/{b}/rows", json={"key_value": "P26-777", "data": {}}
    ).json()

    hits = auth_client.get("/api/search?q=P26-777").json()
    assert [h["row_id"] for h in hits] == [target["id"]]
    assert hits[0]["sheet_name"] == "運用"
    assert hits[0]["matched_field"] == "ID"


def test_finds_a_task_by_an_attribute_value_and_names_the_column(auth_client):
    sid = make_sheet(auth_client)
    title = _add_column(auth_client, sid, "件名")
    note = _add_column(auth_client, sid, "備考")
    make_row(auth_client, sid, {str(title): "認証基盤", str(note): "再委託あり"})

    hits = auth_client.get("/api/search?q=再委託").json()
    assert len(hits) == 1
    assert hits[0]["title"] == "認証基盤"
    assert hits[0]["matched_field"] == "備考"


def test_title_match_reports_no_specific_column(auth_client):
    sid = make_sheet(auth_client)
    title = _add_column(auth_client, sid, "件名")
    make_row(auth_client, sid, {str(title): "認証基盤"})

    hits = auth_client.get("/api/search?q=認証").json()
    assert len(hits) == 1
    assert hits[0]["matched_field"] is None


def test_search_is_case_insensitive(auth_client):
    sid = make_sheet(auth_client)
    title = _add_column(auth_client, sid, "件名")
    make_row(auth_client, sid, {str(title): "Login API"})

    assert len(auth_client.get("/api/search?q=login").json()) == 1


def test_no_match_returns_empty(auth_client):
    sid = make_sheet(auth_client)
    make_row(auth_client, sid)
    assert auth_client.get("/api/search?q=存在しない語").json() == []


def test_search_never_crosses_orgs(auth_client, client, db):
    from app import models
    from app.security import hash_password

    sid = make_sheet(auth_client)
    auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "SECRET-1", "data": {}})

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
    client.post("/api/auth/login", json={"email": "other@t.local", "password": "pw123456"})

    assert client.get("/api/search?q=SECRET").json() == []
