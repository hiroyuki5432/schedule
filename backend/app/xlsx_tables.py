"""ブックの中の「テーブル」（Excel のテーブル機能）の定義を読む。

要望: テーブルだと全然取り込めなさそう。

テーブルの中で書いた数式は、セル番地ではなく **列の名前** で保存される（構造化参照）。

    =[@数量]*[@単価]
    =XLOOKUP([@品番], マスタ[品番], マスタ[品名])

この書き方を読めないと、テーブルで作られたブックは数式列も参照列も1つも作れない。
逆に読めさえすれば、A1 参照よりむしろ **確実** に翻訳できる — 式の中に列名がそのまま
書いてあるので、「どの列か」を場所から推測しなくていい。

openpyxl は `read_only=True` で開くとテーブル定義を持ってこない（ワークシートに
`tables` が生えない）。取り込みは大きなブックを read_only で2回開いているので、
テーブル定義のためだけに3回目の（全セルをメモリに載せる）読み込みをするのは割に
合わない。テーブル定義は .xlsx（＝zip）の中の小さな XML なので、そこだけ直接読む。
"""
from __future__ import annotations

import io
import posixpath
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_DOC_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


@dataclass
class TableDef:
    """1つのテーブル。"""

    #: テーブル名（式の中に出てくる名前）。
    name: str
    #: このテーブルが乗っているワークシート名。
    worksheet: str
    #: 見出し行のワークシート行番号（1始まり）。ヘッダ無しのテーブルでは 0。
    header_row: int
    #: 左端の列位置（0始まり）。
    first_col: int
    #: 見出しの並び。`columns[i]` は列位置 `first_col + i`。
    columns: list[str] = field(default_factory=list)

    def column_index(self, column_name: str) -> int | None:
        """列名 → ワークシート上の列位置（0始まり）。無ければ None。"""
        target = column_name.strip().casefold()
        for i, nm in enumerate(self.columns):
            if nm.strip().casefold() == target:
                return self.first_col + i
        return None


def _col_letters_to_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _parse_ref(ref: str) -> tuple[int, int]:
    """'B2:E40' → (先頭列の0始まり位置, 先頭行の1始まり番号)。"""
    head = (ref or "").split(":")[0].replace("$", "")
    letters = "".join(ch for ch in head if ch.isalpha()).upper()
    digits = "".join(ch for ch in head if ch.isdigit())
    return (_col_letters_to_index(letters) if letters else 0, int(digits) if digits else 0)


def _rels(zf: zipfile.ZipFile, part: str) -> dict[str, str]:
    """`part` の .rels を {Id: 解決済みパス} で返す（無ければ空）。"""
    rel_path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    try:
        xml = zf.read(rel_path)
    except KeyError:
        return {}
    base = posixpath.dirname(part)
    out: dict[str, str] = {}
    for rel in ET.fromstring(xml).findall(f"{_PKG_REL}Relationship"):
        rid, target = rel.get("Id"), rel.get("Target") or ""
        if not rid or not target or target.startswith(("http:", "https:")):
            continue
        resolved = target[1:] if target.startswith("/") else posixpath.normpath(
            posixpath.join(base, target)
        )
        out[rid] = resolved
    return out


def read_tables(data: bytes) -> dict[str, TableDef]:
    """ブックの全テーブルを {テーブル名: TableDef} で返す。

    壊れている・そもそもテーブルが無いブックでは空の辞書を返す。テーブルの読めなさは
    取り込み全体を止める理由にはならない（構造化参照が翻訳できないだけで、値としては
    これまでどおり取り込める）ので、ここでは決して例外を投げない。
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            return _read_tables(zf)
    except Exception:
        return {}


def _read_tables(zf: zipfile.ZipFile) -> dict[str, TableDef]:
    book = "xl/workbook.xml"
    try:
        book_xml = ET.fromstring(zf.read(book))
    except (KeyError, ET.ParseError):
        return {}
    book_rels = _rels(zf, book)

    out: dict[str, TableDef] = {}
    for sheet_el in book_xml.iterfind(f"{_MAIN}sheets/{_MAIN}sheet"):
        ws_name = sheet_el.get("name") or ""
        part = book_rels.get(sheet_el.get(f"{_DOC_REL}id") or "")
        if not ws_name or not part:
            continue
        for target in _rels(zf, part).values():
            if "/tables/" not in target:
                continue
            table = _read_table(zf, target, ws_name)
            if table:
                out[table.name] = table
    return out


def _read_table(zf: zipfile.ZipFile, part: str, worksheet: str) -> TableDef | None:
    try:
        el = ET.fromstring(zf.read(part))
    except (KeyError, ET.ParseError):
        return None
    name = el.get("displayName") or el.get("name") or ""
    if not name:
        return None
    first_col, first_row = _parse_ref(el.get("ref") or "")
    # headerRowCount は「見出し行が何行あるか」。0（見出し無しのテーブル）もありうる。
    try:
        header_rows = int(el.get("headerRowCount", "1"))
    except ValueError:
        header_rows = 1
    columns = [
        c.get("name") or ""
        for c in el.iterfind(f"{_MAIN}tableColumns/{_MAIN}tableColumn")
    ]
    return TableDef(
        name=name,
        worksheet=worksheet,
        header_row=first_row if header_rows > 0 else 0,
        first_col=first_col,
        columns=columns,
    )
