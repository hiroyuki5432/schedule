"""行の並び順と途中への挿入（要望: Excel の「上に行を挿入」）。"""
from __future__ import annotations

from sqlalchemy import insert

from app import models
from tests.conftest import make_row, make_sheet


def _keys(client, sheet_id: int) -> list[str]:
    return [r["key_value"] for r in client.get(f"/api/sheets/{sheet_id}/rows").json()]


def test_rows_come_back_in_the_order_they_were_added(auth_client):
    sid = make_sheet(auth_client)
    keys = [make_row(auth_client, sid)["key_value"] for _ in range(3)]
    assert _keys(auth_client, sid) == keys
    # シート詳細（画面が読む方）も同じ並び。
    detail = auth_client.get(f"/api/sheets/{sid}").json()
    assert [r["key_value"] for r in detail["rows"]] == keys


def test_insert_above_and_below_a_row(auth_client):
    sid = make_sheet(auth_client)
    a, b, c = (make_row(auth_client, sid) for _ in range(3))

    r = auth_client.post(
        f"/api/sheets/{sid}/rows", json={"key_value": "上", "insert_before_id": b["id"]}
    )
    assert r.status_code == 201, r.text
    r = auth_client.post(
        f"/api/sheets/{sid}/rows", json={"key_value": "下", "insert_after_id": b["id"]}
    )
    assert r.status_code == 201, r.text
    assert _keys(auth_client, sid) == [a["key_value"], "上", b["key_value"], "下", c["key_value"]]

    # 末尾への追加は従来どおり最後に付く。
    tail = make_row(auth_client, sid)
    assert _keys(auth_client, sid)[-1] == tail["key_value"]


def test_insert_at_the_very_top(auth_client):
    sid = make_sheet(auth_client)
    a = make_row(auth_client, sid)
    auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "先頭", "insert_before_id": a["id"]})
    assert _keys(auth_client, sid) == ["先頭", a["key_value"]]


def test_inserting_after_a_parent_goes_below_its_subtasks(auth_client):
    sid = make_sheet(auth_client)
    parent = make_row(auth_client, sid)
    kid = auth_client.post(f"/api/rows/{parent['id']}/children", json={"data": {}}).json()
    nxt = make_row(auth_client, sid)

    r = auth_client.post(
        f"/api/sheets/{sid}/rows", json={"key_value": "X", "insert_after_id": parent["id"]}
    )
    assert r.status_code == 201
    assert r.json()["parent_row_id"] is None
    assert _keys(auth_client, sid) == [
        parent["key_value"],
        kid["key_value"],
        "X",
        nxt["key_value"],
    ]


def test_inserting_next_to_a_subtask_makes_a_sibling_subtask(auth_client):
    sid = make_sheet(auth_client)
    parent = make_row(auth_client, sid)
    k1 = auth_client.post(f"/api/rows/{parent['id']}/children", json={"data": {}}).json()
    k2 = auth_client.post(f"/api/rows/{parent['id']}/children", json={"data": {}}).json()

    r = auth_client.post(f"/api/sheets/{sid}/rows", json={"insert_before_id": k2["id"]})
    assert r.status_code == 201, r.text
    new = r.json()
    assert new["parent_row_id"] == parent["id"]
    # 子タスクの採番（親ID-NN）で番号が振られる。
    assert new["key_value"].startswith(parent["key_value"] + "-")
    assert _keys(auth_client, sid) == [
        parent["key_value"],
        k1["key_value"],
        new["key_value"],
        k2["key_value"],
    ]


def test_anchor_from_another_sheet_is_refused(auth_client):
    s1 = make_sheet(auth_client, "A")
    s2 = make_sheet(auth_client, "B")
    other = make_row(auth_client, s2)
    r = auth_client.post(f"/api/sheets/{s1}/rows", json={"insert_before_id": other["id"]})
    assert r.status_code == 400


def test_rows_written_without_an_order_land_at_the_end(auth_client, db):
    """取り込み・復元のように ORM を通さず INSERT しても、並び順は埋まる（DB のトリガ）。"""
    sid = make_sheet(auth_client)
    first = make_row(auth_client, sid)
    db.execute(insert(models.Row.__table__), [{"sheet_id": sid, "key_value": "core", "data": {}, "version": 1, "depends_on": []}])
    db.commit()
    assert _keys(auth_client, sid) == [first["key_value"], "core"]
