"""As-of snapshot resolution: nearest record <= week, with an honest fallback to
the OLDEST record (never the live current state) when the request predates all
snapshots — and the exact/as_of_week flags the UI relies on."""
from __future__ import annotations

from datetime import date

from app import models
from app.snapshot_service import snapshot_as_of


def _state(label: str) -> dict:
    """Minimal snapshot state distinguishable by a row key_value."""
    return {
        "columns": [],
        "rows": {
            "1": {
                "id": 1,
                "key_value": label,
                "data": {},
                "version": 1,
                "progress": None,
                "progress_week": None,
                "effort": [],
            }
        },
    }


def _sheet_with_snaps(db) -> models.Sheet:
    org = models.Organization(name="T", slug="t", settings={"week_start_weekday": 1})
    db.add(org)
    db.flush()
    sheet = models.Sheet(org_id=org.id, name="S", has_week_grid=True)
    db.add(sheet)
    db.flush()
    # Records for 06-15 (W-1) and 06-22 (W), mirroring the real-world repro.
    db.add(models.SheetSnapshot(sheet_id=sheet.id, for_week=date(2026, 6, 15), state=_state("w-15")))
    db.add(models.SheetSnapshot(sheet_id=sheet.id, for_week=date(2026, 6, 22), state=_state("w-22")))
    db.commit()
    return sheet


def test_exact_week_returns_that_record(db):
    sheet = _sheet_with_snaps(db)
    out = snapshot_as_of(db, sheet, date(2026, 6, 15))
    assert out["exact"] is True
    assert out["as_of_week"] == "2026-06-15"
    assert out["rows"][0]["key_value"] == "w-15"


def test_between_weeks_uses_nearest_earlier_record(db):
    sheet = _sheet_with_snaps(db)
    # 06-18 falls between records -> newest <= week is 06-15, but it's not exact.
    out = snapshot_as_of(db, sheet, date(2026, 6, 18))
    assert out["exact"] is False
    assert out["as_of_week"] == "2026-06-15"
    assert out["rows"][0]["key_value"] == "w-15"


def test_before_all_records_falls_back_to_oldest_not_live(db):
    sheet = _sheet_with_snaps(db)
    # 06-08 predates every snapshot. Must show the OLDEST record (06-15), NOT the
    # live current state (which would masquerade as the past).
    out = snapshot_as_of(db, sheet, date(2026, 6, 8))
    assert out["exact"] is False
    assert out["as_of_week"] == "2026-06-15"
    assert out["rows"][0]["key_value"] == "w-15"


def test_no_snapshots_reports_live(db):
    org = models.Organization(name="T2", slug="t2", settings={})
    db.add(org)
    db.flush()
    sheet = models.Sheet(org_id=org.id, name="S2", has_week_grid=True)
    db.add(sheet)
    db.commit()
    out = snapshot_as_of(db, sheet, date(2026, 6, 8))
    # Brand-new sheet with no records: as_of_week is None and exact is False.
    assert out["exact"] is False
    assert out["as_of_week"] is None
