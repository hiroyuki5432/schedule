"""Public org self-signup + admin member management (role change / delete)."""
from __future__ import annotations


def test_signup_creates_org_admin_and_starter_sheet_then_logged_in(client):
    r = client.post(
        "/api/org/signup",
        json={
            "org_name": "新チーム",
            "admin_name": "山田",
            "admin_email": "boss",  # no '@' — login IDs need not be emails
            "admin_password": "pw123456",
        },
    )
    assert r.status_code == 201, r.text
    org = r.json()
    assert org["name"] == "新チーム"
    assert org["slug"]  # auto-generated, non-empty

    # Signup logs the new admin in (session cookie set on the client).
    me = client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["user"]["role"] == "admin"
    assert me.json()["user"]["email"] == "boss"

    # The new org starts with one usable sheet.
    sheets = client.get("/api/sheets").json()
    assert len(sheets) == 1
    assert sheets[0]["has_week_grid"] is True


def test_signup_rejects_duplicate_login_id(client):
    body = {
        "org_name": "A",
        "admin_name": "a",
        "admin_email": "dup",
        "admin_password": "pw123456",
    }
    assert client.post("/api/org/signup", json=body).status_code == 201
    client.post("/api/auth/logout")
    body["org_name"] = "B"
    r = client.post("/api/org/signup", json=body)
    assert r.status_code == 409, r.text


def test_admin_can_change_role_and_delete_member(auth_client):
    created = auth_client.post(
        "/api/members",
        json={"name": "M", "email": "m1", "password": "pw123456", "role": "member"},
    )
    assert created.status_code == 201, created.text
    mid = created.json()["id"]

    promoted = auth_client.patch(f"/api/members/{mid}", json={"role": "admin"})
    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["role"] == "admin"

    deleted = auth_client.delete(f"/api/members/{mid}")
    assert deleted.status_code == 204, deleted.text
    assert all(m["id"] != mid for m in auth_client.get("/api/members").json())


def test_admin_cannot_delete_self(auth_client):
    me = auth_client.get("/api/auth/me").json()["user"]
    r = auth_client.delete(f"/api/members/{me['id']}")
    assert r.status_code == 400, r.text


def test_create_member_allows_non_email_login_id(auth_client):
    r = auth_client.post(
        "/api/members",
        json={"name": "N", "email": "plainid", "password": "pw123456"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["email"] == "plainid"
