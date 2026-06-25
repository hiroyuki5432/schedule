"""開始日/完了日 are auto-created date columns; legacy __sched_* values migrate into them."""
from __future__ import annotations

from .conftest import make_sheet


def _roles(detail) -> dict[str, str]:
    out = {}
    for c in detail["columns"]:
        role = (c.get("config") or {}).get("sched_role")
        if role:
            out[role] = str(c["id"])
    return out


def test_sched_columns_created_on_get(auth_client):
    sid = make_sheet(auth_client, "S")
    detail = auth_client.get(f"/api/sheets/{sid}").json()
    roles = _roles(detail)
    assert "start" in roles and "end" in roles
    names = {c["name"] for c in detail["columns"]}
    assert "開始日" in names and "完了日" in names
    # Idempotent: a second GET doesn't add more.
    again = auth_client.get(f"/api/sheets/{sid}").json()
    assert len(again["columns"]) == len(detail["columns"])


def test_legacy_span_migrates_into_columns(auth_client):
    sid = make_sheet(auth_client, "L")
    auth_client.post(
        f"/api/sheets/{sid}/rows",
        json={"key_value": "A-1", "data": {"__sched_start": "2026-05-01", "__sched_end": "2026-06-01"}},
    )
    detail = auth_client.get(f"/api/sheets/{sid}").json()
    roles = _roles(detail)
    row = detail["rows"][0]
    # Legacy values copied into the new columns (originals kept as a fallback).
    assert row["data"][roles["start"]] == "2026-05-01"
    assert row["data"][roles["end"]] == "2026-06-01"
    assert row["data"]["__sched_start"] == "2026-05-01"
