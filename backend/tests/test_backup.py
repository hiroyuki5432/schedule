"""バックアップ / リストア.

The promise is 「完全にその時の状態に戻す」, so these tests care most about the
things a naive implementation gets wrong: the settings buried in JSONB that are
keyed BY ID (row.data, lookup config, 固定列数…), and the fact that restoring
must not leave the id sequences pointing at ids that already exist.
"""
from __future__ import annotations

import json

from .conftest import make_sheet


def test_every_table_is_either_backed_up_or_deliberately_excluded():
    """A table added later must not be silently left out of backups.

    This fails the moment a new model appears, forcing an explicit decision:
    add it to TABLE_ORDER, or list it here with the reason it is excluded.
    """
    from app import backup_service as bk
    from app.db import Base

    # Not part of a group's restorable state, on purpose:
    excluded = {
        "organizations",  # the group row itself — updated in place, not re-inserted
        "notifications",  # derived; the bell regenerates them on next view
        "backups",        # a restore must not wipe the list of backups
    }
    known = set(bk.TABLE_ORDER) | excluded
    actual = set(Base.metadata.tables)
    assert actual == known, (
        f"バックアップ対象が未決定のテーブルがあります: {sorted(actual - known)}"
        f" / 存在しないテーブルが指定されています: {sorted(known - actual)}"
    )


def _add_col(client, sheet_id: int, name: str, type_: str = "text", config: dict | None = None) -> str:
    r = client.post(
        f"/api/sheets/{sheet_id}/columns",
        json={"name": name, "type": type_, "config": config or {}},
    )
    assert r.status_code in (200, 201), r.text
    return str(r.json()["id"])


def _backups(client) -> list[dict]:
    r = client.get("/api/backups")
    assert r.status_code == 200, r.text
    return r.json()


def test_restore_puts_back_rows_and_the_settings_keyed_by_id(auth_client):
    """row.data is keyed by COLUMN ID, and a sheet's settings hold column ids too.
    Re-numbering on restore would silently point them at the wrong column, so the
    round-trip has to preserve the ids themselves."""
    sid = make_sheet(auth_client, "設計")
    title = _add_col(auth_client, sid, "件名")
    kind = _add_col(auth_client, sid, "区分")
    auth_client.post(
        f"/api/sheets/{sid}/rows",
        json={"key_value": "A-1", "data": {title: "基本設計", kind: "開発"}},
    )
    # A setting that stores a column id — the kind of thing that breaks quietly.
    assert auth_client.patch(
        f"/api/sheets/{sid}",
        json={"settings": {"pinned_columns": 2, "worklog_task_columns": ["__id__", title]}},
    ).status_code == 200
    assert auth_client.patch("/api/org", json={"settings": {"app_title": "テスト表示名"}}).status_code == 200

    r = auth_client.post("/api/backups", json={"label": "取り込み前"})
    assert r.status_code == 201, r.text
    backup_id = r.json()["id"]
    assert r.json()["summary"]["sheets"] == 1
    assert r.json()["summary"]["rows"] == 1

    # Wreck everything: change data, settings, and add a whole sheet.
    row_id = auth_client.get(f"/api/sheets/{sid}").json()["rows"][0]["id"]
    detail = auth_client.get(f"/api/sheets/{sid}").json()
    auth_client.patch(
        f"/api/rows/{row_id}",
        json={"data": {title: "書き換えた"}, "version": detail["rows"][0]["version"]},
    )
    auth_client.patch(f"/api/sheets/{sid}", json={"settings": {"pinned_columns": 0}})
    auth_client.patch("/api/org", json={"settings": {"app_title": "壊した"}})
    make_sheet(auth_client, "あとから作ったシート")

    assert auth_client.post(f"/api/backups/{backup_id}/restore").status_code == 200

    sheets = auth_client.get("/api/sheets").json()
    assert [s["name"] for s in sheets] == ["設計"]        # the extra sheet is gone
    after = auth_client.get(f"/api/sheets/{sid}").json()
    # Column ids survived, so the row data still resolves to the right columns.
    assert {str(c["id"]) for c in after["columns"]} >= {title, kind}
    assert after["rows"][0]["data"][title] == "基本設計"
    assert after["rows"][0]["data"][kind] == "開発"
    assert after["sheet"]["settings"]["pinned_columns"] == 2
    assert after["sheet"]["settings"]["worklog_task_columns"] == ["__id__", title]
    assert auth_client.get("/api/org").json()["settings"]["app_title"] == "テスト表示名"


def test_lookup_config_survives_because_ids_do(auth_client):
    """A 参照(LOOKUP) column points at a sheet id AND two column ids. This is the
    setting that silently reads the wrong column if ids are re-allocated."""
    src = make_sheet(auth_client, "マスタ")
    key = _add_col(auth_client, src, "コード")
    val = _add_col(auth_client, src, "名称")
    dst = make_sheet(auth_client, "利用側")
    look = _add_col(
        auth_client,
        dst,
        "名称参照",
        "lookup",
        {"target_sheet_id": src, "match_key_column_id": key, "return_column_id": val},
    )

    bid = auth_client.post("/api/backups", json={"label": "参照つき"}).json()["id"]
    auth_client.delete(f"/api/columns/{look}")
    assert auth_client.post(f"/api/backups/{bid}/restore").status_code == 200

    cols = {str(c["id"]): c for c in auth_client.get(f"/api/sheets/{dst}").json()["columns"]}
    cfg = cols[look]["config"]
    assert str(cfg["target_sheet_id"]) == str(src)
    assert str(cfg["match_key_column_id"]) == str(key)
    assert str(cfg["return_column_id"]) == str(val)


def test_new_rows_after_restore_do_not_collide(auth_client):
    """Restoring writes explicit primary keys, so every id sequence has to be
    moved past them or the very next INSERT fails on a duplicate key."""
    sid = make_sheet(auth_client, "S")
    _add_col(auth_client, sid, "件名")
    for i in range(3):
        auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": f"A-{i}", "data": {}})

    bid = auth_client.post("/api/backups", json={"label": "b"}).json()["id"]
    assert auth_client.post(f"/api/backups/{bid}/restore").status_code == 200

    # The thing that breaks without a sequence resync.
    r = auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "NEW", "data": {}})
    assert r.status_code in (200, 201), r.text
    assert auth_client.post("/api/sheets", json={"name": "新シート", "has_week_grid": True}).status_code in (200, 201)


def test_restore_takes_a_safety_backup_first(auth_client):
    """戻しすぎ has to be recoverable, so the pre-restore state is captured."""
    sid = make_sheet(auth_client, "元")
    bid = auth_client.post("/api/backups", json={"label": "古い"}).json()["id"]
    make_sheet(auth_client, "あとから")

    res = auth_client.post(f"/api/backups/{bid}/restore").json()
    assert [s["name"] for s in auth_client.get("/api/sheets").json()] == ["元"]

    # The safety copy is listed, and restoring it brings the newer sheet back.
    safety = res["safety_backup_id"]
    assert any(b["id"] == safety for b in _backups(auth_client))
    assert auth_client.post(f"/api/backups/{safety}/restore").status_code == 200
    assert sorted(s["name"] for s in auth_client.get("/api/sheets").json()) == ["あとから", "元"]
    assert sid  # the original sheet id is still meaningful


def test_backups_are_not_wiped_by_a_restore(auth_client):
    """A restore must not delete the list of backups you would need to undo it."""
    make_sheet(auth_client, "S")
    first = auth_client.post("/api/backups", json={"label": "1つめ"}).json()["id"]
    second = auth_client.post("/api/backups", json={"label": "2つめ"}).json()["id"]

    assert auth_client.post(f"/api/backups/{first}/restore").status_code == 200
    ids = {b["id"] for b in _backups(auth_client)}
    assert {first, second} <= ids


def test_download_round_trips_through_a_file(auth_client):
    """The downloaded .json is the way back after losing the database, so it has
    to be restorable on its own."""
    sid = make_sheet(auth_client, "保存対象")
    title = _add_col(auth_client, sid, "件名")
    auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "A-1", "data": {title: "値"}})
    bid = auth_client.post("/api/backups", json={"label": "dl"}).json()["id"]

    r = auth_client.get(f"/api/backups/{bid}/download")
    assert r.status_code == 200, r.text
    blob = r.content
    assert json.loads(blob.decode("utf-8"))["format_version"] == 1

    make_sheet(auth_client, "余計なシート")
    r = auth_client.post(
        "/api/backups/restore-file",
        files={"file": ("backup.json", blob, "application/json")},
    )
    assert r.status_code == 200, r.text
    assert [s["name"] for s in auth_client.get("/api/sheets").json()] == ["保存対象"]
    assert auth_client.get(f"/api/sheets/{sid}").json()["rows"][0]["data"][title] == "値"


def test_a_backup_from_another_group_is_refused(auth_client, client, db):
    """Ids are written back verbatim, so applying a backup to a different group
    could collide with rows that group already owns."""
    make_sheet(auth_client, "S")
    bid = auth_client.post("/api/backups", json={"label": "x"}).json()["id"]
    payload = auth_client.get(f"/api/backups/{bid}/download").json()
    payload["org_id"] = payload["org_id"] + 999

    r = auth_client.post(
        "/api/backups/restore-file",
        files={"file": ("b.json", json.dumps(payload).encode("utf-8"), "application/json")},
    )
    assert r.status_code == 400
    assert "別のグループ" in r.json()["detail"]


def test_a_backup_without_an_admin_is_refused(auth_client):
    """Restoring one would leave the group unmanageable — including undoing it."""
    make_sheet(auth_client, "S")
    bid = auth_client.post("/api/backups", json={"label": "x"}).json()["id"]
    payload = auth_client.get(f"/api/backups/{bid}/download").json()
    for u in payload["tables"]["users"]:
        u["role"] = "member"

    r = auth_client.post(
        "/api/backups/restore-file",
        files={"file": ("b.json", json.dumps(payload).encode("utf-8"), "application/json")},
    )
    assert r.status_code == 400
    assert "管理者" in r.json()["detail"]


def test_members_and_worklogs_are_restored(auth_client):
    """メンバーも含めて完全に戻す（選択済みの方針）: an account added after the
    backup is gone again, and 日報 keep their author link."""
    sid = make_sheet(auth_client, "S")
    auth_client.post(
        "/api/worklog",
        json={"work_date": "2026-08-03", "hours": 3, "cat1": "開発", "memo": "作業"},
    )
    bid = auth_client.post("/api/backups", json={"label": "メンバー前"}).json()["id"]

    assert auth_client.post(
        "/api/members",
        json={"name": "あとから", "email": "later@t.local", "password": "pw123456", "role": "member"},
    ).status_code in (200, 201)
    assert len(auth_client.get("/api/members").json()) == 2

    assert auth_client.post(f"/api/backups/{bid}/restore").status_code == 200
    members = auth_client.get("/api/members").json()
    assert [m["email"] for m in members] == ["admin@t.local"]
    logs = auth_client.get("/api/worklog?from=2026-08-01&to=2026-08-31").json()
    assert len(logs) == 1 and float(logs[0]["hours"]) == 3.0
    assert sid  # sheet kept
