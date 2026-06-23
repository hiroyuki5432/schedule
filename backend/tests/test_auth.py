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
