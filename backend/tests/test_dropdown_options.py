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


# --------------------------------------------------------------------------- #
# Excel 取り込みで入った値が「選択肢に無い値」にならないこと
#
# 取り込みは row.data に直接書くので、選択肢を育てないと「値は入っているのに一覧では
# 選択肢に未登録」という状態になる（要望: シート取込後にプルダウンがうまく追加できない）。
# --------------------------------------------------------------------------- #
import io  # noqa: E402

from openpyxl import Workbook  # noqa: E402

_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _import_values(client, sheet_id: int, header: str, values: list[str]) -> dict:
    """1列だけのブックを作って既存シートへ取り込む。"""
    wb = Workbook()
    ws = wb.active
    ws.append(["ID", header])
    for i, v in enumerate(values, start=1):
        ws.append([f"K-{i}", v])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    r = client.post(
        f"/api/sheets/{sheet_id}/import.xlsx",
        files={"file": ("in.xlsx", buf, _MEDIA)},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_import_adds_missing_dropdown_options(auth_client):
    sheet_id = make_sheet(auth_client)
    col_id = _add_dropdown(
        auth_client, sheet_id, [{"id": "a", "value": "既存", "color": "#fff"}]
    )
    # 列名を「状態」にしてあるので、その見出しで取り込む。
    res = _import_values(auth_client, sheet_id, "状態", ["既存", "新A", "新B", "新A"])
    assert res["created"] == 4

    cols = auth_client.get(f"/api/sheets/{sheet_id}/columns").json()
    col = next(c for c in cols if c["id"] == col_id)
    values = [o["value"] for o in col["config"]["options"]]
    assert values == ["既存", "新A", "新B"]  # 重複は1件、既存はそのまま
    # すべての選択肢に id と色が付く（画面側が id をキーに扱うため）。
    assert all(o.get("id") and o.get("color") for o in col["config"]["options"])
    assert any("状態" in n and "2 件" in n for n in res["notes"])


def test_import_does_not_explode_a_free_text_column(auth_client):
    """種類が多すぎる列は選択肢を増やさず、理由を返す（住所のような自由記述）。"""
    sheet_id = make_sheet(auth_client)
    col_id = _add_dropdown(auth_client, sheet_id, [])
    res = _import_values(
        auth_client, sheet_id, "状態", [f"住所{i}" for i in range(80)]
    )

    cols = auth_client.get(f"/api/sheets/{sheet_id}/columns").json()
    col = next(c for c in cols if c["id"] == col_id)
    assert col["config"].get("options", []) == []
    assert any("選択肢には追加していません" in n for n in res["notes"])

    # 値そのものは失われない — 表示できることが最低条件。
    rows = auth_client.get(f"/api/sheets/{sheet_id}/rows").json()
    assert rows[0]["data"][str(col_id)] == "住所0"
