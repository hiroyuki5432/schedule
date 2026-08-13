"""データのお掃除（要望: 表面に見えないデータをきれいにできるといい）。"""
from __future__ import annotations

from tests.conftest import make_row, make_sheet


def _text_col(client, sheet_id: int, name: str) -> int:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": "text"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_usage_counts_this_group(auth_client):
    sid = make_sheet(auth_client, "U")
    col = _text_col(auth_client, sid, "件名")
    make_row(auth_client, sid, {str(col): "あ"})

    r = auth_client.get("/api/maintenance/usage")
    assert r.status_code == 200, r.text
    body = r.json()
    tables = {t["name"]: t for t in body["tables"]}
    assert tables["rows"]["rows"] == 1
    assert tables["sheets"]["rows"] == 1
    # 履歴は行を作った時点で1件。
    assert body["cleanable"]["row_events_total"] >= 1


def test_deleting_a_column_leaves_invisible_cells_that_cleanup_removes(auth_client):
    """列を消しても値は rows.data に残る — 画面のどこにも出ないまま溜まる。"""
    sid = make_sheet(auth_client, "O")
    keep = _text_col(auth_client, sid, "件名")
    doomed = _text_col(auth_client, sid, "いらない列")
    make_row(auth_client, sid, {str(keep): "残る", str(doomed): "見えなくなる値"})

    auth_client.delete(f"/api/columns/{doomed}")
    row = auth_client.get(f"/api/sheets/{sid}/rows").json()[0]
    assert str(doomed) in row["data"]  # まだ残っている

    usage = auth_client.get("/api/maintenance/usage").json()
    assert usage["cleanable"]["orphan_cells"] == 1

    # 数えるだけ（dry_run）では消えない。
    dry = auth_client.post("/api/maintenance/cleanup", json={"orphan_cells": True})
    assert dry.json()["deleted"]["orphan_cells"] == 1
    assert str(doomed) in auth_client.get(f"/api/sheets/{sid}/rows").json()[0]["data"]

    done = auth_client.post(
        "/api/maintenance/cleanup", json={"orphan_cells": True, "dry_run": False}
    )
    assert done.json()["deleted"]["orphan_cells"] == 1
    row = auth_client.get(f"/api/sheets/{sid}/rows").json()[0]
    assert str(doomed) not in row["data"]
    assert row["data"][str(keep)] == "残る"  # 生きている列は無傷


def test_old_history_can_be_trimmed(auth_client):
    sid = make_sheet(auth_client, "H")
    col = _text_col(auth_client, sid, "件名")
    make_row(auth_client, sid, {str(col): "あ"})

    # 0日より古い＝すべて。
    r = auth_client.post(
        "/api/maintenance/cleanup", json={"row_events_keep_days": 0, "dry_run": False}
    )
    assert r.json()["deleted"]["row_events"] >= 1
    assert auth_client.get(f"/api/sheets/{sid}/history").json() == []


def test_read_notifications_are_removed_but_unread_stay(auth_client):
    auth_client.post(
        "/api/notifications/register",
        json={
            "items": [
                {
                    "target_user_id": auth_client.org_admin["admin_id"],
                    "type": "behind",
                    "title": "遅れ",
                    "dedupe_key": "k1",
                }
            ]
        },
    )
    before = auth_client.get("/api/notifications").json()
    assert any(n["title"] == "遅れ" for n in before)

    kept = auth_client.post(
        "/api/maintenance/cleanup", json={"notifications_read": True, "dry_run": False}
    )
    assert kept.json()["deleted"]["notifications"] == 0  # まだ未読

    auth_client.post("/api/notifications/mark-read", json={})
    gone = auth_client.post(
        "/api/maintenance/cleanup", json={"notifications_read": True, "dry_run": False}
    )
    assert gone.json()["deleted"]["notifications"] >= 1


def test_cleanup_is_admin_only(client, org_admin, db):
    from app import models
    from app.security import hash_password

    db.add(
        models.User(
            org_id=org_admin["org_id"],
            email="m@t.local",
            name="M",
            role="member",
            password_hash=hash_password("pw123456"),
        )
    )
    db.commit()
    client.post("/api/auth/login", json={"email": "m@t.local", "password": "pw123456"})
    assert client.get("/api/maintenance/usage").status_code == 403
    assert client.post("/api/maintenance/cleanup", json={}).status_code == 403
