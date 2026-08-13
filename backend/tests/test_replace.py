"""一括置換（要望: 列のみ／シート全体の置換ができるといい）。"""
from __future__ import annotations

from tests.conftest import make_row, make_sheet


def _text_col(client, sheet_id: int, name: str) -> int:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": "text"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _rows(client, sheet_id: int) -> list[dict]:
    return client.get(f"/api/sheets/{sheet_id}/rows").json()


def test_dry_run_counts_without_writing(auth_client):
    sid = make_sheet(auth_client, "R")
    col = _text_col(auth_client, sid, "顧客")
    make_row(auth_client, sid, {str(col): "(株)あかり"})
    make_row(auth_client, sid, {str(col): "(株)そら"})
    make_row(auth_client, sid, {str(col): "みどり合同"})

    r = auth_client.post(
        f"/api/sheets/{sid}/replace",
        json={"column_id": str(col), "find": "(株)", "replace": "株式会社"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied"] is False
    assert body["rows"] == 2 and body["cells"] == 2
    assert body["samples"][0]["after"] == "株式会社あかり"
    # 何も書いていない。
    assert {x["data"][str(col)] for x in _rows(auth_client, sid)} == {
        "(株)あかり",
        "(株)そら",
        "みどり合同",
    }


def test_apply_writes_and_leaves_history(auth_client):
    sid = make_sheet(auth_client, "R")
    col = _text_col(auth_client, sid, "顧客")
    make_row(auth_client, sid, {str(col): "(株)あかり"})

    r = auth_client.post(
        f"/api/sheets/{sid}/replace",
        json={
            "column_id": str(col),
            "find": "(株)",
            "replace": "株式会社",
            "dry_run": False,
        },
    )
    assert r.status_code == 200 and r.json()["applied"] is True
    assert _rows(auth_client, sid)[0]["data"][str(col)] == "株式会社あかり"

    history = auth_client.get(f"/api/sheets/{sid}/history").json()
    assert any(
        h["field_label"] == "顧客" and h["new_value"] == "株式会社あかり" for h in history
    )


def test_only_the_chosen_column_is_touched(auth_client):
    sid = make_sheet(auth_client, "R")
    a = _text_col(auth_client, sid, "顧客")
    b = _text_col(auth_client, sid, "備考")
    make_row(auth_client, sid, {str(a): "東京", str(b): "東京で作業"})

    auth_client.post(
        f"/api/sheets/{sid}/replace",
        json={"column_id": str(a), "find": "東京", "replace": "大阪", "dry_run": False},
    )
    row = _rows(auth_client, sid)[0]
    assert row["data"][str(a)] == "大阪"
    assert row["data"][str(b)] == "東京で作業"


def test_whole_cell_does_not_touch_partial_matches(auth_client):
    sid = make_sheet(auth_client, "R")
    col = _text_col(auth_client, sid, "顧客")
    make_row(auth_client, sid, {str(col): "東京"})
    make_row(auth_client, sid, {str(col): "東京海上"})

    r = auth_client.post(
        f"/api/sheets/{sid}/replace",
        json={
            "column_id": str(col),
            "find": "東京",
            "replace": "大阪",
            "whole_cell": True,
            "dry_run": False,
        },
    )
    assert r.json()["cells"] == 1
    assert {x["data"][str(col)] for x in _rows(auth_client, sid)} == {"大阪", "東京海上"}


def test_sheet_wide_replace_covers_every_column(auth_client):
    sid = make_sheet(auth_client, "R")
    a = _text_col(auth_client, sid, "顧客")
    b = _text_col(auth_client, sid, "備考")
    make_row(auth_client, sid, {str(a): "旧部署", str(b): "旧部署あて"})

    r = auth_client.post(
        f"/api/sheets/{sid}/replace",
        json={"find": "旧部署", "replace": "新部署", "dry_run": False},
    )
    assert r.json()["cells"] == 2
    row = _rows(auth_client, sid)[0]
    assert row["data"][str(a)] == "新部署" and row["data"][str(b)] == "新部署あて"


def test_dropdown_options_are_replaced_too(auth_client):
    """データだけ直すと「選択肢に無い値」が並ぶので、選択肢も一緒に置換する。"""
    sid = make_sheet(auth_client, "R")
    r = auth_client.post(
        f"/api/sheets/{sid}/columns",
        json={
            "name": "状態",
            "type": "dropdown",
            "config": {"options": [{"id": "a", "value": "進行中"}, {"id": "b", "value": "完了"}]},
        },
    )
    col = r.json()["id"]
    make_row(auth_client, sid, {str(col): "進行中"})

    res = auth_client.post(
        f"/api/sheets/{sid}/replace",
        json={
            "column_id": str(col),
            "find": "進行中",
            "replace": "対応中",
            "dry_run": False,
        },
    )
    assert res.json()["options"] == 1
    columns = auth_client.get(f"/api/sheets/{sid}/columns").json()
    values = [o["value"] for o in columns[-1]["config"]["options"]]
    assert values == ["対応中", "完了"]
    assert _rows(auth_client, sid)[0]["data"][str(col)] == "対応中"


def test_id_is_only_touched_when_asked(auth_client):
    sid = make_sheet(auth_client, "R")
    _text_col(auth_client, sid, "件名")
    auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "OLD-1", "data": {}})

    quiet = auth_client.post(
        f"/api/sheets/{sid}/replace", json={"find": "OLD", "replace": "NEW", "dry_run": False}
    )
    assert quiet.json()["cells"] == 0

    loud = auth_client.post(
        f"/api/sheets/{sid}/replace",
        json={"find": "OLD", "replace": "NEW", "include_key": True, "dry_run": False},
    )
    assert loud.json()["cells"] == 1
    assert _rows(auth_client, sid)[0]["key_value"] == "NEW-1"


def test_computed_columns_are_refused(auth_client):
    sid = make_sheet(auth_client, "R")
    r = auth_client.post(
        f"/api/sheets/{sid}/columns",
        json={"name": "合計", "type": "formula", "config": {"expr": "1+1"}},
    )
    col = r.json()["id"]
    res = auth_client.post(
        f"/api/sheets/{sid}/replace", json={"column_id": str(col), "find": "a", "replace": "b"}
    )
    assert res.status_code == 400


def test_empty_find_is_refused(auth_client):
    sid = make_sheet(auth_client, "R")
    res = auth_client.post(f"/api/sheets/{sid}/replace", json={"find": "", "replace": "x"})
    assert res.status_code == 400
