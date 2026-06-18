"""Week-normalization helpers. Weeks are anchored to Monday (ISO week)."""
from __future__ import annotations

from datetime import date, timedelta


def week_start_of(d: date, week_start_weekday: int = 1) -> date:
    """Return the start-of-week date for ``d``.

    ``week_start_weekday`` uses ISO numbering 1=Monday .. 7=Sunday (org setting).
    """
    # Python's date.isoweekday(): Monday=1 .. Sunday=7
    iso = d.isoweekday()
    delta = (iso - week_start_weekday) % 7
    return d - timedelta(days=delta)


def current_week_start(week_start_weekday: int = 1, today: date | None = None) -> date:
    return week_start_of(today or date.today(), week_start_weekday)
