"""日付セルの読み取りと正規化（保存形は常に 'YYYY-MM-DD'）。

要望: Excel から取り込むと日付列が「自由入力」になってしまい、値も
`2025-10-18 00:00:00` のように時刻付きで入る。あとから列の型を日付に変えても
時刻が残ったまま。

原因は2つあって、どちらもここで断つ:

1. 日付として認識できる書き方が ISO の `2025-10-18` だけだった。日本語の Excel に
   よくある `2025/10/18` や `2025年10月18日`、文字列化された `2025-10-18 00:00:00`
   が読めず、1セルでも混ざると列全体が「自由入力」に落ちていた。
2. 自由入力に落ちた列は Python の `str()` でそのまま文字列化していたので、
   Excel の日時セルが `2025-10-18 00:00:00` として保存されていた。

時刻は捨てる。このアプリの日付列は「日」までしか扱わない（週次グリッド・
マイルストン・期間計算がすべて日単位）。
"""
from __future__ import annotations

import re
from datetime import date, datetime

__all__ = ["parse_date_value", "normalize_date_text", "is_date_placeholder"]

#: 「日付なし」を意味する記号だけのセル（全角/半角ダッシュなど）。取り込み元の表では
#: 空欄の代わりによく使われる。フロントの並べ替えも同じ扱い（lib/format.ts）。
_PLACEHOLDER = re.compile(r"^[-‐-―－−ー~〜\s]+$")

# 2025/10/18 ・ 2025.10.18 ・ 2025年10月18日（1桁月日も可）
_YMD = re.compile(r"^(\d{4})\s*[/.\-年]\s*(\d{1,2})\s*[/.\-月]\s*(\d{1,2})\s*日?$")


def is_date_placeholder(raw) -> bool:
    """「-」だけのセルなど、日付が入っていないことを表す値か。"""
    return isinstance(raw, str) and bool(raw.strip()) and bool(_PLACEHOLDER.match(raw.strip()))


def parse_date_value(raw) -> date | None:
    """セルの値 → `date`。日付として読めなければ None（時刻は切り捨てる）。

    Excel のシリアル値（44000 のような数値）は解釈しない — ただの数値列が日付に
    化けるほうが害が大きい。openpyxl は書式付きの日付セルを datetime で返す。
    """
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    if not isinstance(raw, str):
        return None

    s = raw.strip()
    if not s or is_date_placeholder(s):
        return None

    # ISO（日付のみ／時刻つき／T 区切り）。'2025-10-18 00:00:00' はここで拾う。
    try:
        return date.fromisoformat(s)
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(s.replace("/", "-")).date()
    except ValueError:
        pass

    m = _YMD.match(s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def normalize_date_text(raw) -> str | None:
    """日付列に保存する文字列（'YYYY-MM-DD'）。

    読めない値は **壊さずそのまま残す**（取り込んだ備考が消えるより、変な値が見えて
    直せるほうがよい）。空欄・「-」だけのセルは None（未入力）。
    """
    if raw is None:
        return None
    parsed = parse_date_value(raw)
    if parsed is not None:
        return parsed.isoformat()
    if isinstance(raw, str):
        s = raw.strip()
        return None if not s or is_date_placeholder(s) else s
    return str(raw).strip() or None
