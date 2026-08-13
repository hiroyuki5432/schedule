"""Excel の数式を、このアプリの数式列（`[列名]` 参照）に翻訳する。

要望: Excel の数式もいい感じに取り込めないか。

これまで取り込みは `data_only=True` で開いていたので、数式セルは **計算結果だけ** が
入っていた。値としては正しいが、元データを直しても追従しない“焼き付いた数字”になる。
このモジュールは数式そのものを読み、翻訳できるものは数式列として作れるようにする。

翻訳できる範囲を、あえて狭く切ってある:

* 参照できるのは **同じ行の、取り込む列** だけ（`=D2*E2` を2行目のデータ行として読む）。
  このアプリの行は並べ替え・絞り込みで動くので、A1 という「場所」の概念が無い。他の行や
  他シートを指す式は、翻訳した瞬間に意味が変わってしまうので **翻訳しない**。
* 関数は `lib/formula.ts` のエンジンが実装しているものだけ。知らない関数が1つでも
  混ざったら、その列はまるごと翻訳しない。
* 同じ行の横方向の範囲（`SUM(C2:F2)`）は、個別の引数に開いて渡す。

翻訳できないものは「翻訳しない」であって「取り込まない」ではない — 従来どおり計算結果を
値として取り込む。黙って半分だけ正しい式を作るより、そのほうがずっと安全。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

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

# セル参照 / 範囲 / 関数名 / 文字列 / 数値 / 演算子
_TOKEN_RE = re.compile(
    r"""
    (?P<str>"(?:[^"]|"")*")                       # "文字列"（""でエスケープ）
  | (?P<sheet>(?:'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)!)  # Sheet1! / '別 表'!
  | (?P<range>\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+)
  | (?P<ref>\$?[A-Z]{1,3}\$?\d+)
  | (?P<colrange>\$?[A-Z]{1,3}:\$?[A-Z]{1,3})     # A:A（列まるごと）
  | (?P<name>[A-Za-z_][A-Za-z0-9_.]*)             # 関数名 / 名前付き範囲
  | (?P<num>\d+(?:\.\d+)?)
  | (?P<op><=|>=|<>|[-+*/^&=<>(),%])
  | (?P<space>\s+)
    """,
    re.VERBOSE,
)


class Untranslatable(Exception):
    """翻訳できない理由（日本語。そのまま画面に出す）。"""


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


def translate_formula(
    formula: str, data_row: int, names_by_index: dict[int, str]
) -> str:
    """1セルの Excel 数式を `[列名]` 式に翻訳する。できなければ Untranslatable。

    `data_row` はその数式が入っている **ワークシートの行番号**（1始まり）。同じ行を
    指す参照だけを列名に置き換える。`names_by_index` は 0 始まりの列位置 → 取り込み後の
    列名。ここに無い列を指していたら翻訳しない（その列は取り込まれないので、参照しても
    値が出ない）。
    """
    src = formula[1:] if formula.startswith("=") else formula
    if not src.strip():
        raise Untranslatable("空の数式です")

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


def translate_column(
    formulas: list[tuple[int, object]], names_by_index: dict[int, str]
) -> Translation:
    """1列ぶん。`formulas` は (ワークシート行番号, セルの生値) の並び。

    列として数式にできるのは、**入っている数式が全部おなじ式** のとき（＝Excel で下に
    フィルした列）だけ。行ごとに違う式が入っている列は、行ごとに違う意味を持つので
    1つの列定義では表せない。
    """
    cells = [(row, v) for row, v in formulas if is_formula(v)]
    if not cells:
        return Translation(expr=None, reason=None, sample=None, formula_cells=0)

    sample = str(cells[0][1])
    exprs: set[str] = set()
    for row, raw in cells:
        try:
            exprs.add(translate_formula(str(raw), row, names_by_index))
        except Untranslatable as e:
            return Translation(
                expr=None, reason=str(e), sample=sample, formula_cells=len(cells)
            )
        if len(exprs) > 1:
            return Translation(
                expr=None,
                reason="行によって式が違うため、1つの数式列にまとめられません",
                sample=sample,
                formula_cells=len(cells),
            )
    return Translation(
        expr=exprs.pop(), reason=None, sample=sample, formula_cells=len(cells)
    )
