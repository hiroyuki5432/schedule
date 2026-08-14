"""XLOOKUP / VLOOKUP → 参照(LOOKUP)列 と、Excel の「テーブル」で書かれた数式。

要望: 新規シート作成でExcel取り込み時にXLOOKUP使ってたらうまくLOOKUPを自動生成して
ほしい／テーブルだと全然取り込めなさそう。

参照列は「別のシートを引く」ものなので、**参照先が既にこのアプリにあるとき** だけ
自動で作れる。無いときは値として取り込み、理由を画面に返す — というところまでを見る。
"""
from __future__ import annotations

import io
import json

from openpyxl import Workbook
from openpyxl.worksheet.table import Table

_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _save(wb) -> io.BytesIO:
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def _master_workbook() -> io.BytesIO:
    """先に取り込んでおくマスタ（品番・品名・単価）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "マスタ"
    ws.append(["品番", "品名", "単価"])
    for i in range(1, 4):
        ws.append([f"P{i:03d}", f"部品{i}", 100 * i])
    return _save(wb)


def _detail_workbook(*, as_table: bool) -> io.BytesIO:
    """明細シート。品名列が XLOOKUP でマスタを引いている。

    `as_table` で書き方が変わる:
      * True  … Excel の「テーブル」— 構造化参照（`XLOOKUP([@品番], マスタ[品番], …)`）
      * False … ふつうの範囲参照（`XLOOKUP(A2, マスタ!$A:$A, …)`）
    """
    wb = Workbook()
    ws = wb.active
    ws.title = "明細"
    ws.append(["品番", "数量", "品名", "金額"])
    for i in range(1, 4):
        row = i + 1
        if as_table:
            ws.append([
                f"P{i:03d}", i,
                "=XLOOKUP([@品番],マスタ[品番],マスタ[品名])",
                "=[@数量]*XLOOKUP([@品番],マスタ[品番],マスタ[単価])",
            ])
        else:
            ws.append([
                f"P{i:03d}", i,
                f"=XLOOKUP(A{row},マスタ!$A:$A,マスタ!$B:$B)",
                f"=B{row}*2",
            ])

    ms = wb.create_sheet("マスタ")
    ms.append(["品番", "品名", "単価"])
    for i in range(1, 4):
        ms.append([f"P{i:03d}", f"部品{i}", 100 * i])

    if as_table:
        ws.add_table(Table(displayName="明細", ref="A1:D4"))
        ms.add_table(Table(displayName="マスタ", ref="A1:C4"))
    return _save(wb)


def _import_master(client) -> int:
    r = client.post(
        "/api/sheets/import.xlsx",
        files={"file": ("m.xlsx", _master_workbook(), _MEDIA)},
        data={"name": "マスタ", "has_week_grid": "false", "sheet_name": "マスタ"},
    )
    assert r.status_code == 201, r.text
    return r.json()["sheet_id"]


def _inspect(client, buf, **extra) -> dict:
    r = client.post(
        "/api/sheets/import.xlsx/inspect",
        files={"file": ("in.xlsx", buf, _MEDIA)},
        data={"has_week_grid": "false", "sheet_name": "明細", **extra},
    )
    assert r.status_code == 200, r.text
    return {c["header"]: c for c in r.json()["columns"]}


# --------------------------------------------------------------------------- #
# 参照先がまだ無いとき
# --------------------------------------------------------------------------- #
def test_lookup_without_the_master_sheet_stays_a_value(auth_client):
    """マスタを取り込む前は参照列にできない — 理由を返し、値として取り込む。"""
    by_header = _inspect(auth_client, _detail_workbook(as_table=True))
    name = by_header["品名"]
    assert name["type"] != "lookup"
    assert name["formula"]["lookup"]["ready"] is False
    assert "マスタ" in name["formula"]["reason"]


# --------------------------------------------------------------------------- #
# 参照先があるとき（テーブルの書き方 / ふつうの範囲参照）
# --------------------------------------------------------------------------- #
def test_xlookup_over_a_table_becomes_a_lookup_column(auth_client):
    master_id = _import_master(auth_client)
    by_header = _inspect(auth_client, _detail_workbook(as_table=True))

    name = by_header["品名"]
    assert name["type"] == "lookup"          # 既定で参照列として提案される
    lk = name["formula"]["lookup"]
    assert lk["ready"] is True
    assert lk["sheet_id"] == master_id
    assert lk["local_column"] == "品番"
    assert lk["return_column"] == "品名"

    # 取り込んだマスタは1列目をID列にしているので、照合先は列ではなく行のID。
    assert lk["match_key_column_id"] == "__id__"

    # テーブルの中の掛け算（構造化参照）も数式列になる — ここが従来まったく読めなかった。
    money = by_header["金額"]
    assert money["type"] != "lookup"
    assert money["formula"]["reason"] is not None  # XLOOKUP を含む式は式にできない


def test_xlookup_over_plain_ranges_becomes_a_lookup_column(auth_client):
    master_id = _import_master(auth_client)
    by_header = _inspect(auth_client, _detail_workbook(as_table=False))

    lk = by_header["品名"]["formula"]["lookup"]
    assert lk["ready"] is True and lk["sheet_id"] == master_id
    # 列番地（$B:$B）でも、参照先の見出し行を読んで列名を突き止める。
    assert lk["return_column"] == "品名"
    assert by_header["金額"]["formula"]["expr"] == "[数量]*2"


def test_import_creates_the_lookup_column(auth_client):
    master_id = _import_master(auth_client)
    r = auth_client.post(
        "/api/sheets/import.xlsx",
        files={"file": ("in.xlsx", _detail_workbook(as_table=True), _MEDIA)},
        data={"name": "明細", "has_week_grid": "false", "sheet_name": "明細"},
    )
    assert r.status_code == 201, r.text
    detail = auth_client.get(f"/api/sheets/{r.json()['sheet_id']}").json()

    name = next(c for c in detail["columns"] if c["name"] == "品名")
    assert name["type"] == "lookup"
    cfg = name["config"]
    assert cfg["target_sheet_id"] == master_id
    assert cfg["match_key_column_id"] == "__id__"
    # キーは「このシートの品番列」。ID列（=品番）にしているので行のID。
    assert cfg["local_key_column_id"] == "__id__"

    # 参照列は計算列なので値を保存しない。
    assert all(str(name["id"]) not in row["data"] for row in detail["rows"])


def test_lookup_column_can_be_forced_back_to_a_value(auth_client):
    """ウィザードで「自由入力として取り込む」を選んだとき（lookup を送らない）。"""
    _import_master(auth_client)
    r = auth_client.post(
        "/api/sheets/import.xlsx",
        files={"file": ("in.xlsx", _detail_workbook(as_table=True), _MEDIA)},
        data={
            "name": "明細2",
            "has_week_grid": "false",
            "sheet_name": "明細",
            "columns": json.dumps(
                [
                    {"index": 1, "name": "数量", "type": "number"},
                    {"index": 2, "name": "品名", "type": "text"},
                ]
            ),
        },
    )
    assert r.status_code == 201, r.text
    detail = auth_client.get(f"/api/sheets/{r.json()['sheet_id']}").json()
    name = next(c for c in detail["columns"] if c["name"] == "品名")
    assert name["type"] == "text"


# --------------------------------------------------------------------------- #
# テーブルで書かれた、ふつうの数式
# --------------------------------------------------------------------------- #
def _table_arithmetic_workbook() -> io.BytesIO:
    wb = Workbook()
    ws = wb.active
    ws.title = "見積"
    ws.append(["ID", "単価", "数量", "金額"])
    for i in range(1, 4):
        ws.append([f"K-{i}", 100 * i, i, "=[@単価]*[@数量]"])
    ws.add_table(Table(displayName="見積T", ref="A1:D4"))
    return _save(wb)


def test_structured_reference_arithmetic_becomes_a_formula_column(auth_client):
    """`=[@単価]*[@数量]` — テーブルの中の数式。従来はここで丸ごと落ちていた。"""
    r = auth_client.post(
        "/api/sheets/import.xlsx",
        files={"file": ("t.xlsx", _table_arithmetic_workbook(), _MEDIA)},
        data={"name": "見積T", "has_week_grid": "false"},
    )
    assert r.status_code == 201, r.text
    detail = auth_client.get(f"/api/sheets/{r.json()['sheet_id']}").json()
    money = next(c for c in detail["columns"] if c["name"] == "金額")
    assert money["type"] == "formula"
    assert money["config"]["expr"] == "[単価]*[数量]"
