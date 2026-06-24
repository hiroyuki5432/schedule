"""Worklog (みんなの入力一覧) Excel export/import."""
from __future__ import annotations

import io

from openpyxl import Workbook, load_workbook


def test_export_worklog_xlsx(auth_client):
    auth_client.post(
        "/api/worklog",
        json={"work_date": "2026-06-01", "cat1": "開発", "memo": "設計", "hours": 3},
    )
    r = auth_client.get("/api/worklog/export.xlsx?from=2026-06-01&to=2026-06-01")
    assert r.status_code == 200, r.text
    ws = load_workbook(io.BytesIO(r.content)).active
    header = [c.value for c in ws[1]]
    assert header == ["日付", "ユーザー", "タスクID", "大分類", "中分類", "メモ", "時間"]
    body = [[c.value for c in row] for row in ws.iter_rows(min_row=2)]
    assert any(row[5] == "設計" and float(row[6]) == 3.0 for row in body)


def test_import_worklog_adds_logs(auth_client):
    admin_name = "Admin"  # from conftest org_admin fixture
    wb = Workbook()
    ws = wb.active
    ws.append(["日付", "ユーザー", "タスクID", "大分類", "中分類", "メモ", "時間"])
    ws.append(["2026-06-02", admin_name, "", "会議", "", "定例", 1.5])
    ws.append(["2026-06-02", "存在しない人", "", "x", "", "", 9])  # skipped
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    r = auth_client.post(
        "/api/worklog/import.xlsx",
        files={"file": ("wl.xlsx", buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"created": 1, "skipped": 1, "duplicates": 0}

    logs = auth_client.get("/api/worklog?from=2026-06-02&to=2026-06-02").json()
    assert any(l["memo"] == "定例" and float(l["hours"]) == 1.5 for l in logs)


def test_import_worklog_dedupes_identical_rows(auth_client):
    """Re-importing the same row is skipped as a duplicate (no double-count)."""
    def _file():
        wb = Workbook()
        ws = wb.active
        ws.append(["日付", "ユーザー", "タスクID", "大分類", "中分類", "メモ", "時間"])
        ws.append(["2026-06-03", "Admin", "", "開発", "", "実装", 2])
        ws.append(["2026-06-03", "Admin", "", "開発", "", "実装", 2])  # in-file dup
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return buf

    files = {"file": ("wl.xlsx", _file(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    r1 = auth_client.post("/api/worklog/import.xlsx", files=files)
    assert r1.status_code == 200, r1.text
    # One created, the identical second row skipped as duplicate.
    assert r1.json() == {"created": 1, "skipped": 0, "duplicates": 1}

    # Re-importing the same file adds nothing (both now duplicates of the stored log).
    files2 = {"file": ("wl.xlsx", _file(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    r2 = auth_client.post("/api/worklog/import.xlsx", files=files2)
    assert r2.json() == {"created": 0, "skipped": 0, "duplicates": 2}

    logs = auth_client.get("/api/worklog?from=2026-06-03&to=2026-06-03").json()
    assert len([l for l in logs if l["memo"] == "実装"]) == 1


def test_import_worklog_requires_admin(client, org_admin, db):
    """A non-admin member is rejected (403)."""
    from app import models
    from app.security import hash_password

    member = models.User(
        org_id=org_admin["org_id"],
        email="m@t.local",
        name="Member",
        role="member",
        password_hash=hash_password("pw123456"),
    )
    db.add(member)
    db.commit()
    client.post("/api/auth/login", json={"email": "m@t.local", "password": "pw123456"})

    wb = Workbook()
    ws = wb.active
    ws.append(["日付", "ユーザー", "時間"])
    ws.append(["2026-06-02", "Member", 1])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    r = client.post(
        "/api/worklog/import.xlsx",
        files={"file": ("wl.xlsx", buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert r.status_code == 403, r.text
