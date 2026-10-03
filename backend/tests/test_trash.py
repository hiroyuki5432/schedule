"""ゴミ箱（要望: 行の削除を取り消したい）。

戻したものが「消す前と同じ」であることを見る — 同じID・並び・工数・◇・メモ・
子タスク、それに削除で外れた変更履歴と日報の結びつき。
"""
from __future__ import annotations

from tests.conftest import make_row, make_sheet

WEEK = "2026-06-22"


def _col(client, sheet_id: int, name: str) -> str:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": "text", "config": {}})
    assert r.status_code in (200, 201), r.text
    return str(r.json()["id"])


def _ids(client, sheet_id: int) -> list[int]:
    return [r["id"] for r in client.get(f"/api/sheets/{sheet_id}/rows").json()]


def test_delete_then_restore_brings_everything_back(auth_client):
    sid = make_sheet(auth_client)
    col = _col(auth_client, sid, "件名")
    a = make_row(auth_client, sid, {col: "A"})
    b = make_row(auth_client, sid, {col: "B"})
    c = make_row(auth_client, sid, {col: "C"})
    kid = auth_client.post(f"/api/rows/{b['id']}/children", json={"data": {col: "B-1"}}).json()
    auth_client.put(f"/api/rows/{b['id']}/effort/{WEEK}", json={"planned_hours": 8})
    auth_client.put(f"/api/rows/{kid['id']}/effort/{WEEK}", json={"planned_hours": 3})
    auth_client.put(
        f"/api/rows/{b['id']}/milestones",
        json=[{"name": "設計", "boundary_date": "2026-07-01", "kind": "phase", "order": 0}],
    )
    auth_client.put(f"/api/rows/{b['id']}/notes", json={"cell_key": col, "text": "客先待ち"})
    before = _ids(auth_client, sid)

    r = auth_client.delete(f"/api/rows/{b['id']}")
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == 2  # 親 + 子
    trash_id = r.json()["trash_id"]
    assert _ids(auth_client, sid) == [a["id"], c["id"]]

    listed = auth_client.get(f"/api/sheets/{sid}/trash").json()
    assert [t["id"] for t in listed] == [trash_id]
    assert listed[0]["row_count"] == 2
    assert b["key_value"] in listed[0]["row_keys"]

    r = auth_client.post(f"/api/trash/{trash_id}/restore")
    assert r.status_code == 200, r.text
    assert sorted(r.json()["row_ids"]) == sorted([b["id"], kid["id"]])

    # 同じID・同じ並び。
    assert _ids(auth_client, sid) == before
    rows = {x["id"]: x for x in auth_client.get(f"/api/sheets/{sid}/rows").json()}
    assert rows[b["id"]]["data"][col] == "B"
    assert rows[kid["id"]]["parent_row_id"] == b["id"]
    # 工数・◇・メモ。
    effort = {
        (e["row_id"], e["week_start"]): e
        for e in auth_client.get(f"/api/sheets/{sid}/effort").json()
    }
    assert float(effort[(b["id"], WEEK)]["planned_hours"]) == 8
    assert float(effort[(kid["id"], WEEK)]["planned_hours"]) == 3
    ms = auth_client.get(f"/api/rows/{b['id']}/milestones").json()
    assert [m["name"] for m in ms] == ["設計"]
    notes = auth_client.get(f"/api/sheets/{sid}/notes").json()
    assert [(n["row_id"], n["text"]) for n in notes] == [(b["id"], "客先待ち")]
    # ゴミ箱からは消える。
    assert auth_client.get(f"/api/sheets/{sid}/trash").json() == []


def test_restore_relinks_history_and_worklogs(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    auth_client.patch(
        f"/api/rows/{row['id']}", json={"data": {}, "version": row["version"], "key_value": "T-1"}
    )
    wl = auth_client.post(
        "/api/worklog", json={"work_date": "2026-06-23", "row_id": row["id"], "hours": 2}
    )
    assert wl.status_code in (200, 201), wl.text

    trash_id = auth_client.delete(f"/api/rows/{row['id']}").json()["trash_id"]
    auth_client.post(f"/api/trash/{trash_id}/restore")

    history = auth_client.get(f"/api/rows/{row['id']}/history").json()
    labels = [e["field_label"] for e in history]
    # 削除前の履歴（IDの変更）も、この行の履歴として読める。
    assert "ID" in labels
    assert "行を削除" in labels and "行を元に戻す" in labels
    # 日報の実績も、この行に戻っている。
    logs = auth_client.get("/api/worklog", params={"from": "2026-06-23", "to": "2026-06-23"}).json()
    assert any(str(x["row_id"]) == str(row["id"]) for x in logs)
    effort = auth_client.get(f"/api/sheets/{sid}/effort").json()
    assert any(e["row_id"] == row["id"] and float(e["actual_hours"] or 0) == 2 for e in effort)


def test_bulk_delete_goes_to_one_trash_entry(auth_client):
    sid = make_sheet(auth_client)
    ids = [make_row(auth_client, sid)["id"] for _ in range(3)]
    r = auth_client.post("/api/rows/bulk-delete", json={"ids": ids[:2]})
    trash_id = r.json()["trash_id"]
    assert auth_client.post(f"/api/trash/{trash_id}/restore").status_code == 200
    assert _ids(auth_client, sid) == ids


def test_parent_and_child_selected_together(auth_client):
    sid = make_sheet(auth_client)
    parent = make_row(auth_client, sid)
    kid = auth_client.post(f"/api/rows/{parent['id']}/children", json={"data": {}}).json()
    r = auth_client.post("/api/rows/bulk-delete", json={"ids": [kid["id"], parent["id"]]})
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == 2
    auth_client.post(f"/api/trash/{r.json()['trash_id']}/restore")
    assert _ids(auth_client, sid) == [parent["id"], kid["id"]]


def test_child_whose_parent_is_gone_comes_back_as_top_level(auth_client):
    sid = make_sheet(auth_client)
    parent = make_row(auth_client, sid)
    kid = auth_client.post(f"/api/rows/{parent['id']}/children", json={"data": {}}).json()
    kid_trash = auth_client.delete(f"/api/rows/{kid['id']}").json()["trash_id"]
    auth_client.delete(f"/api/rows/{parent['id']}")

    r = auth_client.post(f"/api/trash/{kid_trash}/restore")
    assert r.status_code == 200, r.text
    assert r.json()["notes"], "親が居ないことを伝える"
    rows = auth_client.get(f"/api/sheets/{sid}/rows").json()
    assert [(x["id"], x["parent_row_id"]) for x in rows] == [(kid["id"], None)]


def test_restoring_twice_is_refused(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    trash_id = auth_client.delete(f"/api/rows/{row['id']}").json()["trash_id"]
    assert auth_client.post(f"/api/trash/{trash_id}/restore").status_code == 200
    assert auth_client.post(f"/api/trash/{trash_id}/restore").status_code == 404


def test_new_rows_after_restore_do_not_collide(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    trash_id = auth_client.delete(f"/api/rows/{row['id']}").json()["trash_id"]
    auth_client.post(f"/api/trash/{trash_id}/restore")
    again = make_row(auth_client, sid)
    assert again["id"] != row["id"]


def test_trash_can_be_cleaned_up_by_age(auth_client):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    auth_client.delete(f"/api/rows/{row['id']}")
    dry = auth_client.post(
        "/api/maintenance/cleanup", json={"trash_keep_days": 0, "dry_run": True}
    ).json()
    assert dry["deleted"]["deleted_rows"] == 1
    assert len(auth_client.get(f"/api/sheets/{sid}/trash").json()) == 1
    auth_client.post("/api/maintenance/cleanup", json={"trash_keep_days": 0, "dry_run": False})
    assert auth_client.get(f"/api/sheets/{sid}/trash").json() == []
