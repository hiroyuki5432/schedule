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
