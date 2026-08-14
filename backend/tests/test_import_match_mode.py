"""取り込みの行の照合（要望: 1列目が被るだけで1行にまとめないでほしい）。

Excel の1列目は「ID」とは限らない — 顧客名や工程名が普通に重複する。それを ID として
照合していたので、同じ値の行が黙って1行に潰れていた。`match_mode` で選べるようにした:

- ``none``    … 照合しない。Excel の1行＝アプリの1行（ウィザードの既定）
- ``id``      … ID列で既存行を探して更新（従来）
- ``replace`` … 取り込む前にシートの行を全部消す（入れ替え）
"""
from __future__ import annotations

import io
import json

from openpyxl import Workbook

from tests.conftest import make_sheet

_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _xlsx(rows: list[list]) -> io.BytesIO:
    wb = Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def _add_text_column(client, sheet_id: int, name: str) -> int:
    r = client.post(f"/api/sheets/{sheet_id}/columns", json={"name": name, "type": "text"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


#: 1列目（工程）が重複する、ごく普通の表。
_DUPES = [
    ["工程", "作業名"],
    ["設計", "画面Aの設計"],
    ["設計", "画面Bの設計"],
    ["製造", "画面Aの実装"],
]


def _import(client, sheet_id: int, data: dict):
    return client.post(
        f"/api/sheets/{sheet_id}/import.xlsx",
        files={"file": ("dup.xlsx", _xlsx(_DUPES), _MEDIA)},
        data=data,
    )


def test_duplicate_first_column_stays_separate_rows(auth_client):
    """照合しない: 同じ「設計」が2行あっても、2行のまま入る。

    そのうえで **ID列の値は消さずに行のIDとして残す** — 元のIDで参照(LOOKUP)や
    先行タスクを紐付けたいので（要望）。照合に使わないだけで、値は捨てない。
    """
    sid = make_sheet(auth_client, "DUP")
    col = _add_text_column(auth_client, sid, "作業名")

    r = _import(
        auth_client,
        sid,
        {
            "header_row": "1",
            "id_column": "0",
            "match_mode": "none",
            "columns": json.dumps([{"index": 1, "name": "作業名"}]),
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 3 and r.json()["updated"] == 0

    rows = auth_client.get(f"/api/sheets/{sid}/rows").json()
    assert len(rows) == 3
    assert [x["data"][str(col)] for x in rows] == ["画面Aの設計", "画面Bの設計", "画面Aの実装"]
    # 元のIDがそのまま（重複したままでも）残っている。
    assert [x["key_value"] for x in rows] == ["設計", "設計", "製造"]


def test_blank_ids_are_numbered_without_touching_the_others(auth_client):
    """ID列に空欄が混じっていても、埋まっている行のIDはそのまま。空欄だけ採番する。"""
    sid = make_sheet(auth_client, "BLANK")
    _add_text_column(auth_client, sid, "作業名")

    r = auth_client.post(
        f"/api/sheets/{sid}/import.xlsx",
        files={
            "file": (
                "b.xlsx",
                _xlsx(
                    [
                        ["工程", "作業名"],
                        ["A-1", "あ"],
                        [None, "い"],
                        ["A-2", "う"],
                    ]
                ),
                _MEDIA,
            )
        },
        data={
            "header_row": "1",
            "id_column": "0",
            "match_mode": "none",
            "columns": json.dumps([{"index": 1, "name": "作業名"}]),
        },
    )
    assert r.status_code == 200, r.text

    keys = [x["key_value"] for x in auth_client.get(f"/api/sheets/{sid}/rows").json()]
    assert keys[0] == "A-1" and keys[2] == "A-2"
    assert keys[1] and keys[1] not in ("A-1", "A-2")


def test_no_id_column_gives_every_row_its_own_internal_id(auth_client):
    """ID列が無くても、行ごとに内部のIDが自動で振られる（重複も空欄も無い）。"""
    sid = make_sheet(auth_client, "AUTO")
    _add_text_column(auth_client, sid, "工程")
    _add_text_column(auth_client, sid, "作業名")

    r = _import(
        auth_client,
        sid,
        {
            "header_row": "1",
            "id_column": "-1",
            "match_mode": "none",
            "columns": json.dumps(
                [{"index": 0, "name": "工程"}, {"index": 1, "name": "作業名"}]
            ),
        },
    )
    assert r.status_code == 200, r.text

    keys = [x["key_value"] for x in auth_client.get(f"/api/sheets/{sid}/rows").json()]
    assert len(keys) == 3
    assert all(keys) and len(set(keys)) == 3


def test_id_mode_still_merges_on_purpose(auth_client):
    """明示的に「IDで照合」を選んだときは、これまでどおり同じIDは1行にまとまる。"""
    sid = make_sheet(auth_client, "MERGE")
    _add_text_column(auth_client, sid, "作業名")

    r = _import(
        auth_client,
        sid,
        {
            "header_row": "1",
            "id_column": "0",
            "match_mode": "id",
            "columns": json.dumps([{"index": 1, "name": "作業名"}]),
        },
    )
    assert r.status_code == 200, r.text
    rows = auth_client.get(f"/api/sheets/{sid}/rows").json()
    assert {x["key_value"] for x in rows} == {"設計", "製造"}


def test_replace_empties_the_sheet_first(auth_client):
    """入れ替え: 何度取り込んでも、シートの中身は毎回そのファイルのぶんだけになる。"""
    sid = make_sheet(auth_client, "REPL")
    _add_text_column(auth_client, sid, "作業名")
    body = {
        "header_row": "1",
        "id_column": "-1",
        "match_mode": "replace",
        "columns": json.dumps([{"index": 1, "name": "作業名"}]),
    }

    first = _import(auth_client, sid, body)
    assert first.status_code == 200, first.text
    assert first.json()["deleted"] == 0 and first.json()["created"] == 3

    second = _import(auth_client, sid, body)
    assert second.status_code == 200, second.text
    assert second.json()["deleted"] == 3 and second.json()["created"] == 3
    assert len(auth_client.get(f"/api/sheets/{sid}/rows").json()) == 3


def test_inspect_counts_follow_the_mode(auth_client):
    """プレビューの件数も、選んだ照合のとおりに出る（実行との食い違いを作らない）。"""
    sid = make_sheet(auth_client, "PRE")
    _add_text_column(auth_client, sid, "作業名")
    auth_client.post(f"/api/sheets/{sid}/rows", json={"key_value": "設計", "data": {}})

    def inspect(mode: str) -> dict:
        r = auth_client.post(
            f"/api/sheets/{sid}/import.xlsx/inspect",
            files={"file": ("dup.xlsx", _xlsx(_DUPES), _MEDIA)},
            data={"header_row": "1", "id_column": "0", "match_mode": mode},
        )
        assert r.status_code == 200, r.text
        return r.json()

    # 「設計」は2行あって、どちらも既存の1行に当たる（＝まとまる）。
    by_id = inspect("id")
    assert by_id["updated_rows"] == 2 and by_id["new_rows"] == 1
    assert by_id["duplicate_ids"] == 1

    none = inspect("none")
    assert none["new_rows"] == 3 and none["updated_rows"] == 0

    repl = inspect("replace")
    assert repl["new_rows"] == 3 and repl["deleted_rows"] == 1


def test_omitting_the_mode_keeps_the_old_behaviour(auth_client):
    """モードを送ってこない呼び出し（古いプリセット・API直叩き）は従来のまま。"""
    sid = make_sheet(auth_client, "OLD")
    _add_text_column(auth_client, sid, "作業名")

    r = _import(
        auth_client,
        sid,
        {
            "header_row": "1",
            "id_column": "0",
            "columns": json.dumps([{"index": 1, "name": "作業名"}]),
        },
    )
    assert r.status_code == 200, r.text
    assert {x["key_value"] for x in auth_client.get(f"/api/sheets/{sid}/rows").json()} == {
        "設計",
        "製造",
    }


def test_preset_remembers_the_mode(auth_client):
    """設定に記録され、一括取り込みが同じ照合で再現できる。"""
    sid = make_sheet(auth_client, "P")
    r = auth_client.post(
        "/api/import/presets",
        json={
            "worksheet_name": "工程表",
            "target_sheet_id": sid,
            "id_column": 0,
            "match_mode": "none",
            "mapping": [{"index": 1, "name": "作業名", "type": ""}],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["match_mode"] == "none"

    saved = {p["worksheet_name"]: p for p in auth_client.get("/api/import/presets").json()}
    assert saved["工程表"]["match_mode"] == "none"
