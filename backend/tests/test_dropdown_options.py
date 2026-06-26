"""Dropdown option maintenance: renaming a value follows through to stored data."""
from __future__ import annotations

from tests.conftest import make_row, make_sheet


def _add_dropdown(client, sheet_id: int, options: list[dict]) -> int:
    r = client.post(
        f"/api/sheets/{sheet_id}/columns",
        json={"name": "状態", "type": "dropdown", "config": {"options": options}},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_rename_option_follows_stored_data(auth_client):
    sheet_id = make_sheet(auth_client)
    col_id = _add_dropdown(
        auth_client,
        sheet_id,
        [
            {"id": "a", "value": "進行中", "color": "#fff"},
            {"id": "b", "value": "完了", "color": "#eee"},
        ],
    )
    # Two rows use the value we will rename.
    r1 = make_row(auth_client, sheet_id, {str(col_id): "進行中"})
    r2 = make_row(auth_client, sheet_id, {str(col_id): "完了"})

    # Rename option "進行中" → "対応中" (same id "a").
    r = auth_client.patch(
        f"/api/columns/{col_id}",
        json={
            "config": {
                "options": [
                    {"id": "a", "value": "対応中", "color": "#fff"},
                    {"id": "b", "value": "完了", "color": "#eee"},
                ]
            }
        },
    )
    assert r.status_code == 200, r.text

    detail = auth_client.get(f"/api/sheets/{sheet_id}").json()
    by_id = {row["id"]: row for row in detail["rows"]}
    assert by_id[r1["id"]]["data"][str(col_id)] == "対応中"  # followed
    assert by_id[r2["id"]]["data"][str(col_id)] == "完了"  # untouched


def test_freeze_option_keeps_value(auth_client):
    """Freezing an option must NOT alter stored data (only hides it in the picker)."""
    sheet_id = make_sheet(auth_client)
    col_id = _add_dropdown(
        auth_client, sheet_id, [{"id": "a", "value": "旧区分", "color": "#fff"}]
    )
    row = make_row(auth_client, sheet_id, {str(col_id): "旧区分"})

    r = auth_client.patch(
        f"/api/columns/{col_id}",
        json={"config": {"options": [{"id": "a", "value": "旧区分", "frozen": True}]}},
    )
    assert r.status_code == 200, r.text

    detail = auth_client.get(f"/api/sheets/{sheet_id}").json()
    by_id = {row_["id"]: row_ for row_ in detail["rows"]}
    assert by_id[row["id"]]["data"][str(col_id)] == "旧区分"
