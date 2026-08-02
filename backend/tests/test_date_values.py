"""日付セルの読み取り（DB 不要の単体テスト）。"""
from __future__ import annotations

from datetime import date, datetime

import pytest

from app.date_values import is_date_placeholder, normalize_date_text, parse_date_value


@pytest.mark.parametrize(
    "raw, expected",
    [
        (date(2025, 10, 18), date(2025, 10, 18)),
        (datetime(2025, 10, 18), date(2025, 10, 18)),
        # 時刻つきの日時セル・文字列は「日」まで。要望: 2025-10-18 00:00:00 になる件。
        (datetime(2025, 10, 18, 9, 30), date(2025, 10, 18)),
        ("2025-10-18 00:00:00", date(2025, 10, 18)),
        ("2025-10-18T09:30:00", date(2025, 10, 18)),
        ("2025-10-18", date(2025, 10, 18)),
        # 日本語 Excel でよくある書き方。
        ("2025/10/18", date(2025, 10, 18)),
        ("2025/1/8", date(2025, 1, 8)),
        ("2025.10.18", date(2025, 10, 18)),
        ("2025年10月18日", date(2025, 10, 18)),
        (" 2025/10/18 ", date(2025, 10, 18)),
    ],
)
def test_reads_the_date_formats_that_actually_show_up(raw, expected):
    assert parse_date_value(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "   ",
        "-",
        "－",
        "未定",
        "2025/13/01",  # 13月は日付ではない
        "2025/10",
        44000,  # Excel のシリアル値は解釈しない（数値列が日付に化けないように）
        3.5,
        True,
    ],
)
def test_leaves_non_dates_alone(raw):
    assert parse_date_value(raw) is None


def test_placeholder_dashes_mean_no_date():
    assert is_date_placeholder("-") and is_date_placeholder("－") and is_date_placeholder("ー")
    assert not is_date_placeholder("2025-10-18")
    assert not is_date_placeholder("")


def test_normalize_keeps_what_it_cannot_read():
    assert normalize_date_text(datetime(2025, 10, 18, 9, 30)) == "2025-10-18"
    assert normalize_date_text("2025/10/18") == "2025-10-18"
    # 読めない値は消さずに残す（取り込んだ注記が消えるほうが困る）。
    assert normalize_date_text("未定") == "未定"
    assert normalize_date_text("-") is None
    assert normalize_date_text("") is None
    assert normalize_date_text(None) is None
