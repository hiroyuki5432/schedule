"""Auth: login / me / logout."""
from __future__ import annotations


def test_login_wrong_password(client, org_admin):
    r = client.post(
        "/api/auth/login",
        json={"email": org_admin["email"], "password": "wrong"},
    )
    assert r.status_code == 401


def test_login_and_me(auth_client, org_admin):
    r = auth_client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["user"]["email"] == org_admin["email"]


def test_logout_clears_session(auth_client):
    assert auth_client.post("/api/auth/logout").status_code in (200, 204)
    # After logout, an authed endpoint should reject.
    assert auth_client.get("/api/members").status_code == 401


def test_frozen_account_cannot_login(client, auth_client, org_admin):
    """A frozen (is_active=false) member is refused at login with 403."""
    # Admin creates a member, then freezes them.
    r = auth_client.post(
        "/api/members",
        json={"name": "M", "email": "m@t.local", "password": "pw123456", "role": "member"},
    )
    assert r.status_code in (200, 201), r.text
    member_id = r.json()["id"]
    assert auth_client.patch(f"/api/members/{member_id}", json={"is_active": False}).status_code == 200

    r = client.post("/api/auth/login", json={"email": "m@t.local", "password": "pw123456"})
    assert r.status_code == 403

    # Unfreezing restores login.
    assert auth_client.patch(f"/api/members/{member_id}", json={"is_active": True}).status_code == 200
    r = client.post("/api/auth/login", json={"email": "m@t.local", "password": "pw123456"})
    assert r.status_code == 200


def test_admin_cannot_freeze_self(auth_client, org_admin):
    r = auth_client.patch(
        f"/api/members/{org_admin['admin_id']}", json={"is_active": False}
    )
    assert r.status_code == 400
