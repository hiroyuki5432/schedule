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


def test_column_stops_at_the_first_untranslatable_row():
    got = translate_column([(2, "=C2*D2"), (3, "=VLOOKUP(C3,A:B,2,0)")], NAMES)
    assert got.expr is None
    assert "対応していない関数" in (got.reason or "")
    assert got.sample == "=C2*D2"
