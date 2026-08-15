"""Excel の数式 → このアプリの `[列名]` 式 への翻訳。"""
from __future__ import annotations

import pytest

from app.xlsx_formula import (
    Untranslatable,
    col_letters_to_index,
    translate_column,
    translate_formula,
)

# 列位置(0始まり) → 取り込み後の列名
NAMES = {0: "ID", 2: "単価", 3: "数量", 4: "小計", 5: "税", 6: "開始日", 7: "完了日"}


def tr(formula: str, row: int = 2) -> str:
    return translate_formula(formula, row, NAMES)


def test_column_letters():
    assert col_letters_to_index("A") == 0
    assert col_letters_to_index("Z") == 25
    assert col_letters_to_index("AA") == 26
    assert col_letters_to_index("AB") == 27


def test_arithmetic_over_same_row():
    assert tr("=C2*D2") == "[単価]*[数量]"
    assert tr("=C2 * D2 + 100") == "[単価]*[数量]+100"


def test_absolute_column_is_still_the_same_column():
    # $C2 は「列を固定」しただけ。行は同じなので翻訳できる。
    assert tr("=$C2*$D$2") == "[単価]*[数量]"


def test_functions_and_strings():
    assert tr('=IF(C2="","",C2*D2)') == 'IF([単価]="","",[単価]*[数量])'
    assert tr("=ROUND(C2/D2,1)") == "ROUND([単価]/[数量],1)"
    assert tr('=CONCATENATE(C2," 円")') == 'CONCAT([単価]," 円")'


def test_same_row_range_expands_inside_sum():
    assert tr("=SUM(C2:E2)") == "SUM([単価],[数量],[小計])"


def test_date_difference():
    assert tr("=H2-G2") == "[完了日]-[開始日]"


def test_rejects_other_rows():
    with pytest.raises(Untranslatable, match="別の行"):
        tr("=C1*D2")


def test_rejects_other_sheets():
    with pytest.raises(Untranslatable, match="ワークシート"):
        tr("=Sheet2!C2")


def test_rejects_unknown_functions():
    with pytest.raises(Untranslatable, match="対応していない関数"):
        tr("=VLOOKUP(C2,A:B,2,FALSE)")


def test_rejects_columns_that_are_not_imported():
    with pytest.raises(Untranslatable, match="取り込まない列"):
        tr("=Z2*2")


def test_rejects_whole_column_ranges():
    with pytest.raises(Untranslatable, match="列全体"):
        tr("=SUM(C:C)")


def test_rejects_multi_row_ranges():
    with pytest.raises(Untranslatable, match="複数の行"):
        tr("=SUM(C2:C9)")


def test_rejects_percent():
    with pytest.raises(Untranslatable, match="パーセント"):
        tr("=C2*10%")


# --------------------------------------------------------------------------- #
# 列まるごと
# --------------------------------------------------------------------------- #
def test_column_of_filled_down_formulas():
    got = translate_column([(2, "=C2*D2"), (3, "=C3*D3"), (4, "=C4*D4")], NAMES)
    assert got.expr == "[単価]*[数量]"
    assert got.formula_cells == 3
    assert got.reason is None


def test_column_with_no_formulas():
    got = translate_column([(2, 100), (3, "文字")], NAMES)
    assert got.expr is None and got.formula_cells == 0 and got.reason is None


def test_column_where_rows_disagree():
    # 2行目は掛け算、3行目は足し算 — 1つの列定義では表せない。
    got = translate_column([(2, "=C2*D2"), (3, "=C3+D3")], NAMES)
    assert got.expr is None
    assert "行によって式が違う" in (got.reason or "")


# --------------------------------------------------------------------------- #
# 「黙って違う式になる」たぐいの回帰（検証で見つかったもの）
# --------------------------------------------------------------------------- #
def test_string_literals_are_left_alone():
    """`_xlfn.` / `@` を外す処理が、文字列の中まで書き換えていた。

    `=B2&"@example.com"` が `[単価]&"example.com"` になり、メールアドレスを組み立てる
    列が黙って壊れていた。しかも画面に出す「元の Excel 数式」も壊れた姿だったので、
    利用者が気づく手立てが無かった。
    """
    from app.xlsx_formula import strip_excel_internals

    assert strip_excel_internals('=C2&"@example.com"') == '=C2&"@example.com"'
    assert strip_excel_internals('=IF(C2="_xlfn.X",1,2)') == '=IF(C2="_xlfn.X",1,2)'
    # 式の側の目印はこれまでどおり外れる。
    assert strip_excel_internals("=_xlfn.XLOOKUP(A2,B:B,C:C)") == "=XLOOKUP(A2,B:B,C:C)"
    assert tr('=C2&"@example.com"') == '[単価]&"@example.com"'


def test_a_column_name_with_brackets_is_refused():
    """見出し `数量[個]` — `lib/formula.ts` は `[` を最初の `]` で閉じるので式にできない。

    以前は `[数量[個]]*100` という読めない式のまま列を作っていた（バックエンドは式を
    検証していない）ので、全セルがエラー表示になっていた。
    """
    with pytest.raises(Untranslatable) as e:
        translate_formula("=C2*100", 2, {0: "ID", 2: "数量[個]"})
    assert "[ ]" in str(e.value)


def test_column_stops_at_the_first_untranslatable_row():
    got = translate_column([(2, "=C2*D2"), (3, "=SUMIF(A:A,C3,D:D)")], NAMES)
    assert got.expr is None
    assert "対応していない関数" in (got.reason or "")
    assert got.sample == "=C2*D2"


def test_a_mixed_column_is_not_pulled_into_a_lookup():
    """掛け算の行と LOOKUP の行が混ざった列は、参照列として自動生成はしない。

    仕様変更（要望: XLOOKUP も参照が選べるものと選べないものがある。なぜ？）:
    以前はここで「対応していない関数です：VLOOKUP」— 数式列として落ちたときの理由 —
    をそのまま出していた。VLOOKUP を書いた本人には的外れなうえ、`has_lookup` が
    立たないので画面から「参照先を選ぶ…」も消え、理由の分からない差になっていた。
    いまは実態（一部の行だけ LOOKUP）を返し、手で参照先を選ぶ道は残す。
    """
    got = translate_column([(2, "=C2*D2"), (3, "=VLOOKUP(C3,A:B,2,0)")], NAMES)
    assert got.expr is None and got.lookup is None
    assert got.has_lookup is True
    assert "一部の行" in (got.reason or "")


def test_a_lookup_used_as_part_of_an_expression_keeps_the_entry_point():
    """`=[@数量]*XLOOKUP(…)` — LOOKUP 1つで出来た式ではないが、LOOKUP ではある。"""
    got = translate_column(
        [(2, "=D2*VLOOKUP(C2,A:B,2,0)"), (3, "=D3*VLOOKUP(C3,A:B,2,0)")], NAMES
    )
    assert got.expr is None and got.lookup is None
    assert got.has_lookup is True
    assert "式の一部" in (got.reason or "")


def test_a_plain_formula_column_reports_no_lookup():
    got = translate_column([(2, "=C2*D2"), (3, "=C3*D3")], NAMES)
    assert got.has_lookup is False
