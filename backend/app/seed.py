"""Idempotent demo seed.

Mirrors mockup/schedule.html sample data: one weekly-grid sheet with 7 rows,
phase segments converted to weekly planned/actual effort (with gap and change
weeks), milestones per phase boundary, and four demo members + an admin.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import (
    Column,
    EffortEntry,
    Organization,
    Row,
    RowMilestone,
    Sheet,
    User,
)
from app.security import hash_password

# --- Week grid (matches the mock) -------------------------------------------
# wk0 = 2026-03-30 (Monday). 54 weekly columns.
WK0 = date(2026, 3, 30)
N_WEEKS = 54
WEEKS = [WK0 + timedelta(weeks=i) for i in range(N_WEEKS)]

# Phase color palette (from the mock --p-* CSS vars).
PHASE_COLOR = {
    "design": "#D4E7DC",
    "impl": "#A7D0BE",
    "test": "#F1DBAC",
    "review": "#CBD9EE",
    "late": "#E8B6A6",
    "done": "#BFE2D3",
}
PHASE_JP = {
    "design": "設計",
    "impl": "実装",
    "test": "テスト",
    "review": "レビュー",
    "late": "対応",
    "done": "完了",
}
# Base hours per phase (BASE in the mock).
BASE_HOURS = {"design": 8, "impl": 16, "test": 12, "review": 6, "late": 10, "done": 8}

# Status color rules pairs from the mock (bg, fg) — used for column config.
STATUS_STYLE = {
    "進行中": ["#E3EFEA", "#266B53"],
    "未着手": ["#EFEDE4", "#6A675C"],
    "遅延": ["#FAE6E0", "#A8442B"],
    "完了": ["#E6F0DB", "#3E6D14"],
}

# "today" anchor used by the mock to split actual vs planned (2026-06-16).
TODAY = date(2026, 6, 16)


def _dt(m: int, day: int) -> date:
    """Mock helper: months < 4 belong to 2027, otherwise 2026."""
    year = 2027 if m < 4 else 2026
    return date(year, m, day)


def _widx(d: date) -> int:
    return (d - WEEKS[0]).days // 7


# Row sample data (id, title, assignee key, status, segments[(phase, start, end)]).
ROWS = [
    {
        "id": "P26-001", "ttl": "認証基盤", "asg": "浜", "sts": "進行中",
        "segs": [("design", _dt(4, 1), _dt(5, 15)), ("impl", _dt(5, 15), _dt(8, 31)), ("test", _dt(9, 1), _dt(9, 30))],
    },
    {
        "id": "P26-002", "ttl": "課金API連携", "asg": "佐", "sts": "未着手",
        "segs": [("design", _dt(6, 1), _dt(6, 30)), ("impl", _dt(7, 1), _dt(11, 30))],
    },
    {
        "id": "E26-001", "ttl": "データ移行", "asg": "田", "sts": "遅延",
        "segs": [("design", _dt(4, 10), _dt(4, 30)), ("late", _dt(4, 30), _dt(6, 16))],
    },
    {
        "id": "P26-003", "ttl": "管理画面リニューアル", "asg": "鈴", "sts": "完了",
        "segs": [("done", _dt(4, 1), _dt(4, 20))],
    },
    {
        "id": "P26-004", "ttl": "通知基盤", "asg": "浜", "sts": "進行中",
        "segs": [("impl", _dt(8, 1), _dt(1, 31)), ("test", _dt(2, 1), _dt(3, 15))],
    },
    {
        "id": "P26-005", "ttl": "帳票・レポート", "asg": "山", "sts": "進行中",
        "segs": [("design", _dt(5, 1), _dt(6, 15)), ("impl", _dt(6, 15), _dt(10, 31)), ("review", _dt(11, 1), _dt(11, 30))],
    },
    {
        "id": "E26-002", "ttl": "監査ログ整備", "asg": "佐", "sts": "未着手",
        "segs": [("design", _dt(11, 1), _dt(12, 15)), ("impl", _dt(12, 16), _dt(2, 28))],
    },
]

# Zero-hour gap weeks per row (GAPS in mock).
GAPS = {
    "P26-001": [_dt(7, 13), _dt(7, 20)],
    "P26-002": [_dt(9, 21)],
    "P26-004": [_dt(12, 28), _dt(1, 4)],
    "P26-005": [_dt(8, 10), _dt(8, 17)],
}
# Change-point weeks per row (CHG in mock) — hours bumped by 4.
CHG = {
    "P26-001": [_widx(_dt(5, 18))],
    "P26-002": [_widx(_dt(8, 3))],
    "P26-005": [_widx(_dt(7, 6))],
}

# Assignee key -> demo member email.
ASG_EMAIL = {
    "浜": settings.DEMO_ADMIN_EMAIL,
    "佐": "sato@demo.local",
    "田": "tanaka@demo.local",
    "鈴": "suzuki@demo.local",
    "山": "yamamoto@demo.local",
}

MEMBERS = [
    ("佐藤 太郎", "sato@demo.local"),
    ("田中 花子", "tanaka@demo.local"),
    ("鈴木 一郎", "suzuki@demo.local"),
    ("山本 美咲", "yamamoto@demo.local"),
]


def _build_effort(row_def: dict) -> dict[int, dict]:
    """Reproduce the mock's per-week cell computation: {week_idx: {phase, hours, chg}}."""
    gap_idx = {_widx(d) for d in GAPS.get(row_def["id"], [])}
    cells: dict[int, dict] = {}
    for si, (phase, start, end) in enumerate(row_def["segs"]):
        a, b = _widx(start), _widx(end)
        for i in range(a, min(b, N_WEEKS - 1) + 1):
            hours = 0 if i in gap_idx else BASE_HOURS[phase]
            cells[i] = {"phase": phase, "hours": hours, "first": (i == a and si > 0)}
    for i in CHG.get(row_def["id"], []):
        if i in cells and cells[i]["hours"] > 0:
            cells[i]["chg"] = True
            cells[i]["hours"] += 4
    return cells


def _build_milestones(row_def: dict) -> list[dict]:
    """Phase boundaries -> milestones. One per segment start, named by phase."""
    out: list[dict] = []
    for order, (phase, start, _end) in enumerate(row_def["segs"]):
        out.append(
            {
                "name": PHASE_JP.get(phase, phase),
                "boundary_date": start,
                "color": PHASE_COLOR.get(phase),
                "order": order,
            }
        )
    return out


def run_seed(db: Session) -> None:
    """Create the demo org/users/sheet/rows/effort/milestones if absent."""
    existing = db.execute(select(Organization).limit(1)).scalar_one_or_none()
    if existing is not None:
        return  # idempotent guard

    org = Organization(name="デモ組織", slug="demo", settings={"week_start_weekday": 1})
    db.add(org)
    db.flush()

    # Admin.
    admin = User(
        org_id=org.id,
        email=settings.DEMO_ADMIN_EMAIL,
        name="浜崎 寛幸",
        role="admin",
        password_hash=hash_password(settings.DEMO_ADMIN_PASSWORD),
    )
    db.add(admin)
    db.flush()

    # Members.
    email_to_user: dict[str, User] = {settings.DEMO_ADMIN_EMAIL: admin}
    for name, email in MEMBERS:
        u = User(
            org_id=org.id,
            email=email,
            name=name,
            role="member",
            password_hash=hash_password("demo1234"),
        )
        db.add(u)
        db.flush()
        email_to_user[email] = u

    # Sheet. Default milestones (phases) + frozen-column count live in settings.
    sheet = Sheet(
        org_id=org.id,
        name="開発スケジュール 2026",
        order=0,
        has_week_grid=True,
        numbering_rule={"prefix": "P26-", "digits": 3, "next_seq": 6},
        settings={
            "pinned_columns": 1,
            "default_milestones": [
                {"name": PHASE_JP["design"], "color": PHASE_COLOR["design"]},
                {"name": PHASE_JP["impl"], "color": PHASE_COLOR["impl"]},
                {"name": PHASE_JP["test"], "color": PHASE_COLOR["test"]},
                {"name": PHASE_JP["review"], "color": PHASE_COLOR["review"]},
            ],
        },
    )
    db.add(sheet)
    db.flush()

    # Columns: 件名(text), 担当(member), ステータス(status).
    col_title = Column(sheet_id=sheet.id, name="件名", order=0, type="text", config={})
    col_assignee = Column(sheet_id=sheet.id, name="担当", order=1, type="member", config={})
    col_status = Column(
        sheet_id=sheet.id,
        name="ステータス",
        order=2,
        type="status",
        config={
            "rules": [
                {
                    "conditions": [{"col_id": None, "op": "overdue", "value": True}],
                    "label": "遅延",
                    "color": STATUS_STYLE["遅延"][0],
                },
                {
                    "conditions": [{"col_id": None, "op": "done", "value": True}],
                    "label": "完了",
                    "color": STATUS_STYLE["完了"][0],
                },
                {
                    "conditions": [{"col_id": None, "op": "in_progress", "value": True}],
                    "label": "進行中",
                    "color": STATUS_STYLE["進行中"][0],
                },
                {
                    "conditions": [],
                    "label": "未着手",
                    "color": STATUS_STYLE["未着手"][0],
                },
            ],
            "options": [
                {"value": label, "color": style[0]} for label, style in STATUS_STYLE.items()
            ],
        },
    )
    db.add_all([col_title, col_assignee, col_status])
    db.flush()

    # Color basis = status column. No explicit key column (row.key_value is the ID).
    sheet.color_basis_column_id = col_status.id

    # Rows + effort + milestones.
    for row_def in ROWS:
        assignee_user = email_to_user.get(ASG_EMAIL.get(row_def["asg"], ""))
        data = {
            str(col_title.id): row_def["ttl"],
            str(col_assignee.id): assignee_user.id if assignee_user else None,
            str(col_status.id): row_def["sts"],
        }
        row = Row(
            sheet_id=sheet.id,
            key_value=row_def["id"],
            data=data,
            version=1,
            created_by=admin.id,
            updated_by=admin.id,
        )
        db.add(row)
        db.flush()

        cells = _build_effort(row_def)
        for week_idx, cell in cells.items():
            week_start = WEEKS[week_idx]
            hours = cell["hours"]
            # Past week => actual recorded; current/future => planned.
            if week_start < TODAY:
                planned = hours
                actual = hours
            else:
                planned = hours
                actual = None
            db.add(
                EffortEntry(
                    row_id=row.id,
                    week_start=week_start,
                    planned_hours=planned,
                    actual_hours=actual,
                    version=1,
                    updated_by=admin.id,
                )
            )

        for ms in _build_milestones(row_def):
            db.add(
                RowMilestone(
                    row_id=row.id,
                    name=ms["name"],
                    boundary_date=ms["boundary_date"],
                    color=ms["color"],
                    order=ms["order"],
                )
            )

    db.commit()


def maybe_seed() -> None:
    """Entry point used at startup."""
    if not settings.SEED_ON_STARTUP:
        return
    db = SessionLocal()
    try:
        run_seed(db)
    finally:
        db.close()
