"""Notifications: register dedupe, mark-read, and lazy 未入力 generation."""
from __future__ import annotations

from datetime import date

from app import models
from app.notification_service import generate_worklog_missing

TODAY = date(2026, 6, 23)  # Tuesday


def test_register_dedupes(auth_client):
    admin_id = auth_client.org_admin["admin_id"]
    item = {
        "target_user_id": admin_id,
        "type": "behind",
        "title": "遅延: P26-001",
        "body": "進捗が予定を下回っています。",
        "ref_kind": "sheet",
        "ref_id": "1",
        "dedupe_key": "behind:1:2026-06-22",
    }
    r1 = auth_client.post("/api/notifications/register", json={"items": [item]})
    assert r1.status_code == 200
    assert r1.json()["created"] == 1
    # Same dedupe_key again creates nothing.
    r2 = auth_client.post("/api/notifications/register", json={"items": [item]})
    assert r2.json()["created"] == 0

    titles = [n["title"] for n in auth_client.get("/api/notifications").json()]
    assert "遅延: P26-001" in titles


def test_mark_read(auth_client):
    admin_id = auth_client.org_admin["admin_id"]
    auth_client.post(
        "/api/notifications/register",
        json={
            "items": [
                {
                    "target_user_id": admin_id,
                    "type": "behind",
                    "title": "遅延: X",
                    "dedupe_key": "behind:x",
                }
            ]
        },
    )
    upd = auth_client.post("/api/notifications/mark-read", json={}).json()
    assert upd["updated"] >= 1
    notes = auth_client.get("/api/notifications").json()
    assert all(n["read_at"] is not None for n in notes if n["title"] == "遅延: X")


def _make_user(db, org, required: bool, email: str):
    u = models.User(
        org_id=org.id,
        email=email,
        name=email,
        role="member",
        worklog_required=required,
        password_hash="x",
    )
    db.add(u)
    db.commit()
    return u


def test_worklog_missing_generates_for_required_user(db):
    org = models.Organization(name="O", slug="o", settings={"week_start_weekday": 1})
    db.add(org)
    db.flush()
    user = _make_user(db, org, required=True, email="m1@t.local")

    # Weekdays in [today-7, today): 06-16,17,18,19,22 = 5 business days, none logged.
    n = generate_worklog_missing(db, user, today=TODAY)
    assert n == 5
    # Idempotent: a second run creates nothing.
    assert generate_worklog_missing(db, user, today=TODAY) == 0


def test_worklog_missing_skips_logged_days(db):
    org = models.Organization(name="O2", slug="o2", settings={"week_start_weekday": 1})
    db.add(org)
    db.flush()
    user = _make_user(db, org, required=True, email="m2@t.local")
    db.add(
        models.WorkLog(
            org_id=org.id, user_id=user.id, work_date=date(2026, 6, 17), hours=8
        )
    )
    db.commit()
    # 06-17 is logged, so only 4 of the 5 business days are flagged.
    assert generate_worklog_missing(db, user, today=TODAY) == 4


def test_worklog_missing_skips_non_required_user(db):
    org = models.Organization(name="O3", slug="o3", settings={"week_start_weekday": 1})
    db.add(org)
    db.flush()
    user = _make_user(db, org, required=False, email="boss@t.local")
    assert generate_worklog_missing(db, user, today=TODAY) == 0
