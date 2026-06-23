"""Test fixtures. Runs against a SEPARATE Postgres database (`<db>_test`) so it
never touches real data. The test DB is created automatically if missing, and all
tables are truncated before each test for isolation.

Env is set BEFORE importing the app so its engine/settings bind to the test DB:
- DATABASE_URL  -> derived test DB (or TEST_DATABASE_URL if provided)
- SEED_ON_STARTUP=false so the demo seed doesn't run during tests.
"""
from __future__ import annotations

import os

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

_BASE = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://app:app@localhost:5432/schedule"
)
_u = make_url(_BASE)
# NOTE: str(URL) obfuscates the password as '***' — use render_as_string so the
# derived test URL keeps real credentials.
_TEST_URL = os.environ.get("TEST_DATABASE_URL") or _u.set(
    database=(_u.database or "schedule") + "_test"
).render_as_string(hide_password=False)
os.environ["DATABASE_URL"] = _TEST_URL
os.environ["SEED_ON_STARTUP"] = "false"


def _ensure_database(url: str) -> None:
    """Create the target database if it doesn't exist (connect to `postgres`)."""
    u = make_url(url)
    maint = u.set(database="postgres")
    eng = create_engine(maint, isolation_level="AUTOCOMMIT", future=True)
    try:
        with eng.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"),
                {"n": u.database},
            ).scalar()
            if not exists:
                conn.execute(text(f'CREATE DATABASE "{u.database}"'))
    finally:
        eng.dispose()


_ensure_database(_TEST_URL)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import models  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.security import hash_password  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _schema():
    Base.metadata.create_all(engine)
    yield


@pytest.fixture(autouse=True)
def _clean_tables():
    """Wipe every table before each test for a clean slate."""
    with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(text(f'TRUNCATE TABLE "{table.name}" RESTART IDENTITY CASCADE'))
    yield


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def org_admin(db):
    """An org + an admin user (worklog_required). Returns ids + login creds."""
    org = models.Organization(name="T", slug="t", settings={"week_start_weekday": 1})
    db.add(org)
    db.flush()
    admin = models.User(
        org_id=org.id,
        email="admin@t.local",
        name="Admin",
        role="admin",
        worklog_required=True,
        password_hash=hash_password("pw123456"),
    )
    db.add(admin)
    db.commit()
    return {
        "org_id": org.id,
        "admin_id": admin.id,
        "email": "admin@t.local",
        "password": "pw123456",
    }


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_client(client, org_admin):
    """A client logged in as the admin (session cookie persisted on the client)."""
    r = client.post(
        "/api/auth/login",
        json={"email": org_admin["email"], "password": org_admin["password"]},
    )
    assert r.status_code == 200, r.text
    client.org_admin = org_admin  # type: ignore[attr-defined]
    return client


def make_sheet(client: TestClient, name: str = "Sheet") -> int:
    r = client.post("/api/sheets", json={"name": name, "has_week_grid": True})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def make_row(client: TestClient, sheet_id: int, data: dict | None = None) -> dict:
    r = client.post(f"/api/sheets/{sheet_id}/rows", json={"data": data or {}})
    assert r.status_code in (200, 201), r.text
    return r.json()
