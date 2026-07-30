"""Daily work-log → weekly actual rollup (the 日報→実績 invariant)."""
from __future__ import annotations

from tests.conftest import make_row, make_sheet

WORK_DATE = "2026-06-23"  # Tuesday
WEEK = "2026-06-22"  # its Monday-anchored week start


def _actual_for(client, sheet_id: int, row_id: int, week: str = WEEK) -> float:
    entries = client.get(f"/api/sheets/{sheet_id}/effort").json()
    for e in entries:
        if str(e["row_id"]) == str(row_id) and e["week_start"] == week:
            return float(e["actual_hours"] or 0)
    return 0.0


def test_worklog_rolls_up_into_weekly_actual(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    rid = row["id"]

    r = auth_client.post(
        "/api/worklog",
        json={"work_date": WORK_DATE, "row_id": rid, "hours": 3},
    )
    assert r.status_code in (200, 201), r.text
    assert _actual_for(auth_client, sid, rid) == 3.0

    # A second log the same week sums in.
    auth_client.post(
        "/api/worklog",
        json={"work_date": WORK_DATE, "row_id": rid, "hours": 2},
    )
    assert _actual_for(auth_client, sid, rid) == 5.0


def _sheet_with_columns(client) -> tuple[int, dict[str, int]]:
    """A sheet with 件名/顧客 text columns + the admin as 担当 (for task labels)."""
    sid = make_sheet(client)
    ids: dict[str, int] = {}
    for name, ctype in (("件名", "text"), ("顧客", "text"), ("担当", "member")):
        r = client.post(f"/api/sheets/{sid}/columns", json={"name": name, "type": ctype})
        assert r.status_code in (200, 201), r.text
        ids[name] = r.json()["id"]
    return sid, ids


def test_task_label_follows_sheet_setting(auth_client):
    """要望: 実績入力のタスク表示を ID＋件名 以外の列でも組み立てられる。"""
    sid, cols = _sheet_with_columns(auth_client)
    me = auth_client.org_admin["admin_id"]
    row = auth_client.post(
        f"/api/sheets/{sid}/rows",
        json={
            "key_value": "T-1",
            "data": {
                str(cols["件名"]): "設計する",
                str(cols["顧客"]): "A社",
                str(cols["担当"]): me,
            },
        },
    ).json()

    # Default: ID＋件名 (the historical behaviour).
    task = next(t for t in auth_client.get("/api/worklog/tasks").json() if t["row_id"] == row["id"])
    assert task["label"] == "T-1 / 設計する"

    # Configured: 顧客 → 件名 (no ID).
    auth_client.patch(
        f"/api/sheets/{sid}",
        json={"settings": {"worklog_task_columns": [str(cols["顧客"]), str(cols["件名"])]}},
    )
    task = next(t for t in auth_client.get("/api/worklog/tasks").json() if t["row_id"] == row["id"])
    assert task["label"] == "A社 / 設計する"

    # The same label is attached to each work log (みんなの入力一覧のタスク欄).
    auth_client.post("/api/worklog", json={"work_date": WORK_DATE, "row_id": row["id"], "hours": 1})
    log = auth_client.get(f"/api/worklog?from={WORK_DATE}&to={WORK_DATE}").json()[0]
    assert log["row_label"] == "A社 / 設計する"
    day = auth_client.get(f"/api/worklog/all?date={WORK_DATE}").json()
    assert any(l["row_label"] == "A社 / 設計する" for u in day for l in u["logs"])


def test_worklog_keeps_third_category_level(auth_client):
    """3段目の分類 (cat3) が保存・取得できる（段数は組織設定で増減）。"""
    r = auth_client.post(
        "/api/worklog",
        json={"work_date": WORK_DATE, "cat1": "開発", "cat2": "設計", "cat3": "画面", "hours": 2},
    )
    assert r.status_code in (200, 201), r.text
    assert r.json()["cat3"] == "画面"
    log = auth_client.get(f"/api/worklog?from={WORK_DATE}&to={WORK_DATE}").json()[0]
    assert (log["cat1"], log["cat2"], log["cat3"]) == ("開発", "設計", "画面")


def test_deleting_worklog_recomputes_actual(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    rid = row["id"]
    wl = auth_client.post(
        "/api/worklog", json={"work_date": WORK_DATE, "row_id": rid, "hours": 4}
    ).json()
    assert _actual_for(auth_client, sid, rid) == 4.0

    assert auth_client.delete(f"/api/worklog/{wl['id']}").status_code == 204
    # With no logs left, the derived actual clears back to 0/None.
    assert _actual_for(auth_client, sid, rid) == 0.0
