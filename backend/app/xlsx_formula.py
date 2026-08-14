"""Excel の数式を、このアプリの数式列（`[列名]` 参照）と参照列（LOOKUP）に翻訳する。

要望: Excel の数式もいい感じに取り込めないか／XLOOKUP を使っていたら参照(LOOKUP)を
自動生成してほしい／テーブルだと全然取り込めなさそう。

これまで取り込みは `data_only=True` で開いていたので、数式セルは **計算結果だけ** が
入っていた。値としては正しいが、元データを直しても追従しない“焼き付いた数字”になる。
このモジュールは数式そのものを読み、翻訳できるものは列の定義として作れるようにする。

翻訳の出口は2つある:

* **数式列** — `=D2*E2` や `=[@数量]*[@単価]` を `[単価]*[数量]` に翻訳する。
* **参照列（LOOKUP）** — `=XLOOKUP([@品番], マスタ[品番], マスタ[品名])` のように
  「別の表から1つ引いてくる」だけの式は、このアプリの参照列そのものなので、式ではなく
  参照の設定に読み替える（:class:`LookupSpec`）。実際にどのシート・どの列に結びつくかは
  ここでは決めない（アプリ側の都合なので ``routers.excel`` が解決する）。

翻訳できる範囲を、あえて狭く切ってある:

* 数式列が参照できるのは **同じ行の、取り込む列** だけ（`=D2*E2` を2行目のデータ行として
  読む）。このアプリの行は並べ替え・絞り込みで動くので、A1 という「場所」の概念が無い。
  他の行を指す式は、翻訳した瞬間に意味が変わってしまうので **翻訳しない**。
* 関数は `lib/formula.ts` のエンジンが実装しているものだけ。知らない関数が1つでも
  混ざったら、その列はまるごと翻訳しない。
* 同じ行の横方向の範囲（`SUM(C2:F2)`）は、個別の引数に開いて渡す。
* LOOKUP は **完全一致** のものだけ。近似一致（VLOOKUP の第4引数 TRUE など）は、
  意味の違う別物になるので翻訳しない。

翻訳できないものは「翻訳しない」であって「取り込まない」ではない — 従来どおり計算結果を
値として取り込む。黙って半分だけ正しい式を作るより、そのほうがずっと安全。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.xlsx_tables import TableDef

#: lib/formula.ts の ARITY と同じ集合（ここに無い関数が出たら翻訳しない）。
SUPPORTED_FUNCTIONS = {
    "IF", "IFERROR", "AND", "OR", "NOT", "ISBLANK",
    "SUM", "AVERAGE", "COUNT", "MIN", "MAX",
    "ABS", "INT", "ROUND", "ROUNDUP", "ROUNDDOWN",
    "LEN", "LEFT", "RIGHT", "MID", "CONCAT", "TRIM",
    "TODAY", "DAYS", "DATE", "YEAR", "MONTH", "DAY",
}

#: Excel 側の別名 → このアプリの関数名。
FUNCTION_ALIASES = {
    "CONCATENATE": "CONCAT",
}

#: 引数を「同じ行の横方向の範囲」で受け取れる関数（範囲を個別の引数に開く）。
RANGE_FUNCTIONS = {"SUM", "AVERAGE", "COUNT", "MIN", "MAX", "CONCAT"}

#: 名前（関数名・テーブル名・ワークシート名）。日本語のシート名／テーブル名も通す。
_NAME = r"[^\W\d][\w.]*"

# セル参照 / 範囲 / 構造化参照 / 関数名 / 文字列 / 数値 / 演算子
#
# 構造化参照（`[@数量]` / `テーブル[列]`）は名前より先に置く — 後ろに回すと
# `マスタ[品番]` が「名前 + 読めない記号」に割れてしまう。
_TOKEN_RE = re.compile(
    rf"""
    (?P<str>"(?:[^"]|"")*")                       # "文字列"（""でエスケープ）
  | (?P<sref>(?:'[^']*'|{_NAME})?\[(?:[^\[\]]|\[[^\[\]]*\])*\])   # [@数量] / テーブル[列]
  | (?P<sheet>(?:'[^']*'|{_NAME})!)                # Sheet1! / '別 表'! / マスタ!
  | (?P<range>\$?[A-Z]{{1,3}}\$?\d+:\$?[A-Z]{{1,3}}\$?\d+)
  | (?P<ref>\$?[A-Z]{{1,3}}\$?\d+)
  | (?P<colrange>\$?[A-Z]{{1,3}}:\$?[A-Z]{{1,3}})  # A:A（列まるごと）
  | (?P<name>{_NAME})                              # 関数名 / 名前付き範囲
  | (?P<num>\d+(?:\.\d+)?)
  | (?P<op><=|>=|<>|[-+*/^&=<>(),%])
  | (?P<space>\s+)
    """,
    re.VERBOSE,
)


class Untranslatable(Exception):
    """翻訳できない理由（日本語。そのまま画面に出す）。"""


class NotALookup(Untranslatable):
    """そもそも LOOKUP 1つで出来ている式ではない、というだけの合図。

    `=[@数量]*XLOOKUP(…)` のように LOOKUP を **含む** 式はここに来る。断る理由としては
    「XLOOKUP の形ではありません」より「対応していない関数です：XLOOKUP」（数式列として
    落ちた理由）のほうが分かりやすいので、呼び出し側はこれを見て黙る。
    """


@dataclass
class LookupSpec:
    """XLOOKUP / VLOOKUP を「参照列の設定」の形に読み替えたもの。

    まだ **Excel の言葉** で書いてある（ワークシート名・見出し名・列位置）。これを
    アプリのシートID・列IDに解決するのは ``routers.excel``。参照先が取り込まれて
    いなければ解決できないので、その判断はDBを見られる側でしかできない。
    """

    #: 引くキーになる、このシートの列位置（0始まり）。
    local_index: int
    #: 参照先のワークシート名。
    target_worksheet: str
    #: 参照先で照合する列。見出し名が分かるとき（テーブル参照）だけ入る。
    match_column: str | None
    #: 参照先で照合する列の位置（0始まり）。分からなければ None。
    match_index: int | None
    #: 参照先から取ってくる列。見出し名が分かるときだけ入る。
    return_column: str | None
    #: 参照先から取ってくる列の位置（0始まり）。分からなければ None。
    return_index: int | None


@dataclass
class Translation:
    """1列ぶんの翻訳結果。"""

    #: `[単価] * [数量]` の形。翻訳できなければ None。
    expr: str | None
    #: 翻訳できなかった理由（expr が None のときだけ）。
    reason: str | None
    #: この列で見つかった Excel 数式の例（画面に出す）。
    sample: str | None
    #: 数式セルの数（数式かどうかの判定と、警告の文面に使う）。
    formula_cells: int
    #: 参照列にできるときの中身（XLOOKUP / VLOOKUP）。
    lookup: LookupSpec | None = None


def col_letters_to_index(letters: str) -> int:
    """'A' → 0, 'Z' → 25, 'AA' → 26。"""
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _split_ref(ref: str) -> tuple[str, int, bool]:
    """'$D$2' → ('D', 2, True)。3つめは「行が絶対参照か」。"""
    body = ref.replace("$", "")
    m = re.match(r"([A-Z]{1,3})(\d+)", body)
    if not m:
        raise Untranslatable(f"読み取れない参照です：{ref}")
    row_absolute = "$" in ref[ref.index(m.group(1)) + len(m.group(1)) :]
    return m.group(1), int(m.group(2)), row_absolute


def is_formula(value) -> bool:
    """openpyxl が `data_only=False` で返す数式セルか。"""
    return isinstance(value, str) and value.startswith("=")


# --------------------------------------------------------------------------- #
# 構造化参照（テーブルの書き方）
# --------------------------------------------------------------------------- #
def _unquote_name(raw: str) -> str:
    """`'別 表'` → `別 表`。クォートされていなければそのまま。"""
    s = raw.strip()
    if len(s) >= 2 and s.startswith("'") and s.endswith("'"):
        return s[1:-1].replace("''", "'")
    return s


def _split_top_level(s: str, sep: str = ",") -> list[str]:
    """括弧・角括弧・文字列の中を無視して `sep` で割る。"""
    out: list[str] = []
    depth = 0
    in_str = False
    buf: list[str] = []
    opens, closes = "([", ")]"
    for ch in s:
        if in_str:
            buf.append(ch)
            if ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            buf.append(ch)
            continue
        if ch in opens:
            depth += 1
        elif ch in closes:
            depth -= 1
        if ch == sep and depth == 0:
            out.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    out.append("".join(buf))
    return out


def _is_balanced(s: str) -> bool:
    """括弧がきちんと閉じているか（文字列の中は数えない）。

    `XLOOKUP(a,b,c)+XLOOKUP(d,e,f)` のような式は、正規表現から見ると「XLOOKUP( … )」に
    見えてしまう。中身が閉じ切っているかを別に確かめないと、足し算を1つの参照だと
    読み違える。
    """
    depth = 0
    in_str = False
    for ch in s:
        if in_str:
            if ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


#: 構造化参照の「指定子」— 列名ではなく、表のどの部分かを指す。
_SPECIFIERS = {"#all", "#data", "#headers", "#totals", "#this row"}


@dataclass
class StructuredRef:
    """`テーブル[[#This Row],[数量]]` を分解したもの。"""

    table: str
    #: 同じ行を指しているか（`@` または `#This Row`）。
    this_row: bool
    #: 指している列名の並び（`[列1]:[列3]` なら2つ）。表全体なら空。
    columns: list[str]


def parse_structured_ref(text: str) -> StructuredRef:
    """`マスタ[品番]` / `[@数量]` / `T[[#This Row],[数 量]]` を分解する。"""
    open_at = text.index("[")
    table = _unquote_name(text[:open_at])
    body = text[open_at + 1 : text.rindex("]")]

    this_row = False
    if body.startswith("@"):
        this_row = True
        body = body[1:]
        # `[@[数 量]]` のように、@ のあとがさらに角括弧で包まれていることがある。

    columns: list[str] = []
    for part in _split_top_level(body):
        item = part.strip()
        if not item:
            continue
        if item.startswith("[") and item.endswith("]"):
            item = item[1:-1]
        # Excel は列名の中の [ ] # ' を ' でエスケープする。
        item = re.sub(r"'(.)", r"\1", item).strip()
        if item.casefold() in _SPECIFIERS:
            if item.casefold() == "#this row":
                this_row = True
            continue
        if item:
            columns.append(item)
    return StructuredRef(table=table, this_row=this_row, columns=columns)


# --------------------------------------------------------------------------- #
# 数式列への翻訳
# --------------------------------------------------------------------------- #
def translate_formula(
    formula: str,
    data_row: int,
    names_by_index: dict[int, str],
    *,
    worksheet: str = "",
    tables: dict[str, TableDef] | None = None,
) -> str:
    """1セルの Excel 数式を `[列名]` 式に翻訳する。できなければ Untranslatable。

    `data_row` はその数式が入っている **ワークシートの行番号**（1始まり）。同じ行を
    指す参照だけを列名に置き換える。`names_by_index` は 0 始まりの列位置 → 取り込み後の
    列名。ここに無い列を指していたら翻訳しない（その列は取り込まれないので、参照しても
    値が出ない）。

    `worksheet` と `tables` を渡すと、テーブルの書き方（`[@数量]`）も翻訳できる。
    """
    src = formula[1:] if formula.startswith("=") else formula
    if not src.strip():
        raise Untranslatable("空の数式です")

    index_by_name = {}
    for i, nm in names_by_index.items():
        index_by_name.setdefault(nm.strip().casefold(), i)

    out: list[str] = []
    pos = 0
    # 直前に読んだ関数名（範囲を開いてよいか判断するため）。丸括弧の深さごとに積む。
    fn_stack: list[str] = []
    pending_fn: str | None = None

    while pos < len(src):
        m = _TOKEN_RE.match(src, pos)
        if not m:
            raise Untranslatable(f"読み取れない書き方です：{src[pos:pos + 12]}")
        pos = m.end()
        kind = m.lastgroup
        text = m.group()

        if kind == "space":
            continue
        if kind == "sheet":
            raise Untranslatable("他のワークシートを参照しています")
        if kind == "colrange":
            raise Untranslatable(f"列全体の参照は扱えません：{text}")
        if kind == "str":
            out.append(text)
            continue
        if kind == "num":
            out.append(text)
            continue

        if kind == "sref":
            out.append(
                _translate_sref(text, index_by_name, names_by_index, worksheet, tables)
            )
            continue

        if kind == "name":
            upper = text.upper()
            if upper in ("TRUE", "FALSE"):
                out.append(upper)
                continue
            fn = FUNCTION_ALIASES.get(upper, upper)
            if fn not in SUPPORTED_FUNCTIONS:
                raise Untranslatable(f"対応していない関数です：{text}")
            out.append(fn)
            pending_fn = fn
            continue

        if kind == "ref":
            letters, row, _abs_row = _split_ref(text)
            if row != data_row:
                raise Untranslatable(f"別の行を参照しています：{text}")
            idx = col_letters_to_index(letters)
            name = names_by_index.get(idx)
            if not name:
                raise Untranslatable(f"取り込まない列を参照しています：{text}")
            out.append(f"[{name}]")
            continue

        if kind == "range":
            left, right = text.split(":")
            l_letters, l_row, _ = _split_ref(left)
            r_letters, r_row, _ = _split_ref(right)
            if l_row != data_row or r_row != data_row:
                raise Untranslatable(f"複数の行にまたがる範囲です：{text}")
            current_fn = fn_stack[-1] if fn_stack else None
            if current_fn not in RANGE_FUNCTIONS:
                raise Untranslatable(f"この場所に範囲は書けません：{text}")
            a, b = col_letters_to_index(l_letters), col_letters_to_index(r_letters)
            if a > b:
                a, b = b, a
            parts: list[str] = []
            for i in range(a, b + 1):
                name = names_by_index.get(i)
                if not name:
                    raise Untranslatable(f"取り込まない列を含む範囲です：{text}")
                parts.append(f"[{name}]")
            out.append(",".join(parts))
            continue

        # 演算子
        if text == "%":
            raise Untranslatable("パーセント記号（%）は扱えません")
        if text == "(":
            fn_stack.append(pending_fn or "")
            pending_fn = None
        elif text == ")":
            if fn_stack:
                fn_stack.pop()
        out.append(text)

    expr = "".join(out).strip()
    if not expr:
        raise Untranslatable("空の数式です")
    return expr


def _translate_sref(
    text: str,
    index_by_name: dict[str, int],
    names_by_index: dict[int, str],
    worksheet: str,
    tables: dict[str, TableDef] | None,
) -> str:
    """構造化参照 → `[列名]`。同じ行・1列だけを指しているときに限る。"""
    sref = parse_structured_ref(text)
    if sref.table:
        table = (tables or {}).get(sref.table)
        if table is not None and worksheet and table.worksheet != worksheet:
            raise Untranslatable(f"他のワークシートのテーブルを参照しています：{text}")
    if not sref.this_row:
        raise Untranslatable(f"同じ行以外のテーブル参照は扱えません：{text}")
    if len(sref.columns) != 1:
        raise Untranslatable(f"複数の列にまたがるテーブル参照です：{text}")
    idx = index_by_name.get(sref.columns[0].strip().casefold())
    if idx is None:
        raise Untranslatable(f"取り込まない列を参照しています：{text}")
    return f"[{names_by_index[idx]}]"


# --------------------------------------------------------------------------- #
# 参照列（LOOKUP）への読み替え
# --------------------------------------------------------------------------- #
#: 見つからなかったときの逃げを被せただけの式は、中身だけ見る。参照列はもともと
#: 「見つからなければ空」なので、意味はほぼ変わらない。
_WRAPPERS = ("IFERROR", "IFNA")


def _strip_wrappers(src: str) -> str:
    """`IFERROR(XLOOKUP(...), "")` → `XLOOKUP(...)`。"""
    for _ in range(3):  # 二重三重に包む人もいる。念のため数回だけ剥がす。
        m = re.match(rf"^\s*({'|'.join(_WRAPPERS)})\s*\((.*)\)\s*$", src, re.IGNORECASE | re.DOTALL)
        if not m or not _is_balanced(m.group(2)):
            return src.strip()
        args = _split_top_level(m.group(2))
        if len(args) < 2:
            return src.strip()
        src = args[0]
    return src.strip()


def _call_args(src: str, fn: str) -> list[str] | None:
    """`src` がちょうど `fn(...)` の呼び出しなら、その引数。違えば None。"""
    m = re.match(rf"^\s*(?:_xlfn\.)?{fn}\s*\((.*)\)\s*$", src, re.IGNORECASE | re.DOTALL)
    # 中身が閉じ切っていなければ、`fn(…)` 全体ではなく式の一部（`XLOOKUP(…)+XLOOKUP(…)`）。
    if not m or not _is_balanced(m.group(1)):
        return None
    return [a.strip() for a in _split_top_level(m.group(1))]


def _is_exact_zero(arg: str) -> bool:
    return arg.strip() in ("0", "")


def _same_row_index(
    arg: str, data_row: int, index_by_name: dict[str, int]
) -> int | None:
    """引数が「同じ行のセル」なら、その列位置（0始まり）。違えば None。"""
    arg = arg.strip()
    m = re.fullmatch(r"\$?([A-Z]{1,3})\$?(\d+)", arg)
    if m:
        return col_letters_to_index(m.group(1)) if int(m.group(2)) == data_row else None
    if "[" in arg:
        try:
            sref = parse_structured_ref(arg)
        except ValueError:
            return None
        if sref.this_row and len(sref.columns) == 1:
            return index_by_name.get(sref.columns[0].strip().casefold())
    return None


@dataclass
class _Array:
    """LOOKUP の引数に出てくる「1列ぶんの範囲」。"""

    worksheet: str
    first_col: int
    last_col: int
    #: 列名が分かるとき（テーブル参照）だけ。位置だけ分かることもある。
    column: str | None
    table: TableDef | None


def _parse_array(
    arg: str, worksheet: str, tables: dict[str, TableDef] | None
) -> _Array | None:
    """`マスタ!$A:$A` / `マスタ!$A$2:$A$99` / `マスタ[品番]` / `マスタ` を読む。"""
    arg = arg.strip()
    tables = tables or {}

    # テーブル参照 — 列名がそのまま書いてあるので、いちばん確か。
    if "[" in arg:
        try:
            sref = parse_structured_ref(arg)
        except ValueError:
            return None
        table = tables.get(sref.table)
        if table is None or sref.this_row or len(sref.columns) != 1:
            return None
        idx = table.column_index(sref.columns[0])
        if idx is None:
            return None
        return _Array(table.worksheet, idx, idx, sref.columns[0], table)

    # テーブル名だけ（VLOOKUP の第2引数によくある形）。
    table = tables.get(arg)
    if table is not None and table.columns:
        return _Array(
            table.worksheet,
            table.first_col,
            table.first_col + len(table.columns) - 1,
            None,
            table,
        )

    m = re.fullmatch(
        rf"(?:(?P<sheet>'[^']*'|{_NAME})!)?"
        r"\$?(?P<c1>[A-Z]{1,3})(?:\$?\d+)?:\$?(?P<c2>[A-Z]{1,3})(?:\$?\d+)?",
        arg,
    )
    if not m:
        return None
    ws = _unquote_name(m.group("sheet") or "") or worksheet
    a, b = col_letters_to_index(m.group("c1")), col_letters_to_index(m.group("c2"))
    if a > b:
        a, b = b, a
    return _Array(ws, a, b, None, None)


def extract_lookup(
    formula: str,
    data_row: int,
    names_by_index: dict[int, str],
    *,
    worksheet: str = "",
    tables: dict[str, TableDef] | None = None,
) -> LookupSpec:
    """`=XLOOKUP(…)` / `=VLOOKUP(…)` を参照列の設定に読み替える。

    参照列は「このシートのキー列の値で、別の表の照合列を **完全一致** で探し、その行の
    取得列を返す」もの。この形にぴったり当てはまる式だけを引き受け、外れたら
    Untranslatable にする（近似一致・複数条件・配列を返すものなど）。
    """
    src = _strip_wrappers(formula[1:] if formula.startswith("=") else formula)
    index_by_name = {}
    for i, nm in names_by_index.items():
        index_by_name.setdefault(nm.strip().casefold(), i)

    args = _call_args(src, "XLOOKUP")
    if args is not None:
        return _from_xlookup(args, data_row, index_by_name, worksheet, tables)
    args = _call_args(src, "VLOOKUP")
    if args is not None:
        return _from_vlookup(args, data_row, index_by_name, worksheet, tables)
    raise NotALookup("XLOOKUP / VLOOKUP の形ではありません")


def _local_or_fail(arg: str, data_row: int, index_by_name: dict[str, int]) -> int:
    idx = _same_row_index(arg, data_row, index_by_name)
    if idx is None:
        raise Untranslatable(f"探す値が同じ行の列ではありません：{arg.strip()}")
    return idx


def _from_xlookup(
    args: list[str],
    data_row: int,
    index_by_name: dict[str, int],
    worksheet: str,
    tables: dict[str, TableDef] | None,
) -> LookupSpec:
    if len(args) < 3:
        raise Untranslatable("XLOOKUP の引数が足りません")
    # 第5引数（一致モード）。0 = 完全一致。それ以外は意味が変わるので引き受けない。
    if len(args) >= 5 and not _is_exact_zero(args[4]):
        raise Untranslatable("完全一致（一致モード 0）以外の XLOOKUP は扱えません")
    # 第6引数（検索モード）。-1 / -2 は「最後の一致」— 参照列は先頭一致なので違う。
    if len(args) >= 6 and args[5].strip().startswith("-"):
        raise Untranslatable("末尾から探す XLOOKUP は扱えません")

    local = _local_or_fail(args[0], data_row, index_by_name)
    match = _parse_array(args[1], worksheet, tables)
    ret = _parse_array(args[2], worksheet, tables)
    if match is None or ret is None:
        raise Untranslatable("参照する範囲を読み取れませんでした")
    if match.first_col != match.last_col or ret.first_col != ret.last_col:
        raise Untranslatable("参照する範囲が1列ではありません")
    if match.worksheet != ret.worksheet:
        raise Untranslatable("照合する表と取得する表が別のワークシートです")
    return LookupSpec(
        local_index=local,
        target_worksheet=match.worksheet,
        match_column=match.column,
        match_index=match.first_col,
        return_column=ret.column,
        return_index=ret.first_col,
    )


def _from_vlookup(
    args: list[str],
    data_row: int,
    index_by_name: dict[str, int],
    worksheet: str,
    tables: dict[str, TableDef] | None,
) -> LookupSpec:
    if len(args) < 3:
        raise Untranslatable("VLOOKUP の引数が足りません")
    # 第4引数を省く／TRUE にすると近似一致。並び順しだいで結果が変わる別物なので断る。
    exact = len(args) >= 4 and args[3].strip().upper() in ("FALSE", "0")
    if not exact:
        raise Untranslatable("完全一致（第4引数 FALSE）以外の VLOOKUP は扱えません")

    local = _local_or_fail(args[0], data_row, index_by_name)
    area = _parse_array(args[1], worksheet, tables)
    if area is None:
        raise Untranslatable("参照する範囲を読み取れませんでした")
    try:
        col_no = int(args[2].strip())
    except ValueError:
        raise Untranslatable(f"取り出す列の番号が数字ではありません：{args[2].strip()}")
    if col_no < 1:
        raise Untranslatable(f"取り出す列の番号が範囲外です：{col_no}")
    return_index = area.first_col + col_no - 1
    if return_index > area.last_col:
        raise Untranslatable(f"取り出す列の番号が範囲を越えています：{col_no}")
    table = area.table

    def name_at(idx: int) -> str | None:
        if table is None:
            return None
        pos = idx - table.first_col
        return table.columns[pos] if 0 <= pos < len(table.columns) else None

    return LookupSpec(
        local_index=local,
        target_worksheet=area.worksheet,
        # VLOOKUP は必ず範囲の左端で照合する。
        match_column=name_at(area.first_col),
        match_index=area.first_col,
        return_column=name_at(return_index),
        return_index=return_index,
    )


# --------------------------------------------------------------------------- #
# 列まるごと
# --------------------------------------------------------------------------- #
def translate_column(
    formulas: list[tuple[int, object]],
    names_by_index: dict[int, str],
    *,
    worksheet: str = "",
    tables: dict[str, TableDef] | None = None,
) -> Translation:
    """1列ぶん。`formulas` は (ワークシート行番号, セルの生値) の並び。

    列として数式（または参照）にできるのは、**入っている数式が全部おなじ式** のとき
    （＝Excel で下にフィルした列）だけ。行ごとに違う式が入っている列は、行ごとに違う
    意味を持つので1つの列定義では表せない。

    数式列として翻訳できなかったときだけ、参照列（LOOKUP）として読めないか試す。
    XLOOKUP は `SUPPORTED_FUNCTIONS` に無いので数式としては必ず落ちる — その落ち方を
    「対応していない関数です」で終わらせず、参照列に拾い上げるのがここ。
    """
    cells = [(row, v) for row, v in formulas if is_formula(v)]
    if not cells:
        return Translation(expr=None, reason=None, sample=None, formula_cells=0)

    sample = str(cells[0][1])
    exprs: set[str] = set()
    reason: str | None = None
    for row, raw in cells:
        try:
            exprs.add(
                translate_formula(
                    str(raw), row, names_by_index, worksheet=worksheet, tables=tables
                )
            )
        except Untranslatable as e:
            reason = str(e)
            break
        if len(exprs) > 1:
            reason = "行によって式が違うため、1つの数式列にまとめられません"
            break

    if reason is None and len(exprs) == 1:
        return Translation(
            expr=exprs.pop(), reason=None, sample=sample, formula_cells=len(cells)
        )

    lookup, lookup_reason = _column_lookup(cells, names_by_index, worksheet, tables)
    return Translation(
        expr=None,
        # 参照列として読めたなら、数式列として落ちた話（「対応していない関数です：
        # XLOOKUP」）はもう出さない — 断られたと読めてしまうので。読めなかったときは、
        # XLOOKUP らしき式ならそっちの理由のほうが直しようがある。
        reason=None if lookup else (lookup_reason or reason),
        sample=sample,
        formula_cells=len(cells),
        lookup=lookup,
    )


def _column_lookup(
    cells: list[tuple[int, object]],
    names_by_index: dict[int, str],
    worksheet: str,
    tables: dict[str, TableDef] | None,
) -> tuple[LookupSpec | None, str | None]:
    """列全体が「同じ1つの参照」になるかどうか。(設定, 断った理由) を返す。

    **全部** の行が LOOKUP のときだけ引き受ける。掛け算の行と LOOKUP の行が混ざって
    いる列は、そもそも1つの列定義にできない — そこで参照の話を持ち出すと、本当の理由
    （行によって式が違う／対応していない関数）が見えなくなる。
    """
    looks_like = all(
        re.search(r"\b(X|V)LOOKUP\b", str(v), re.IGNORECASE) for _row, v in cells
    )
    if not looks_like:
        return None, None
    specs: set[tuple] = set()
    spec: LookupSpec | None = None
    for row, raw in cells:
        try:
            spec = extract_lookup(
                str(raw), row, names_by_index, worksheet=worksheet, tables=tables
            )
        except NotALookup:
            return None, None
        except Untranslatable as e:
            return None, str(e)
        specs.add(
            (
                spec.local_index,
                spec.target_worksheet,
                spec.match_column,
                spec.match_index,
                spec.return_column,
                spec.return_index,
            )
        )
        if len(specs) > 1:
            return None, "行によって参照先が違うため、1つの参照列にまとめられません"
    return spec, None
