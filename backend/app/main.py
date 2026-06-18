"""FastAPI application entrypoint."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.db import Base, engine
from app.routers import (
    aggregate,
    auth,
    columns,
    effort,
    export,
    members,
    milestones,
    org,
    rows,
    sheets,
    snapshots,
)

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Import models so their tables register on Base.metadata before create_all.
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)

    # Lightweight in-place migrations for columns added after the initial
    # create_all (which never ALTERs existing tables). Idempotent.
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE row_milestones "
                    "ADD COLUMN IF NOT EXISTS done boolean NOT NULL DEFAULT false"
                )
            )
            conn.execute(
                text(
                    "ALTER TABLE sheets "
                    "ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb"
                )
            )
            # Allow duplicate key_value within a sheet (reuse the same ID for
            # repeated work). Drop the legacy uniqueness constraint if present.
            conn.execute(
                text("ALTER TABLE rows DROP CONSTRAINT IF EXISTS uq_rows_sheet_key")
            )
        logger.info("Schema migration check complete.")
    except Exception:  # pragma: no cover - migration must never block startup
        logger.exception("Schema migration failed (continuing startup).")

    if settings.SEED_ON_STARTUP:
        try:
            from app.seed import maybe_seed

            maybe_seed()
            logger.info("Seed check complete.")
        except Exception:  # pragma: no cover - seed must never block startup
            logger.exception("Seed failed (continuing startup).")
    yield


app = FastAPI(title="工数スケジュール管理 API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SESSION_SECRET,
    https_only=settings.COOKIE_SECURE,  # true in prod (HTTPS); false for local dev
    same_site="lax",
)

# Order matters only for documentation grouping; paths are disjoint.
app.include_router(auth.router)
app.include_router(org.router)
app.include_router(members.router)
app.include_router(sheets.router)
app.include_router(columns.router)
app.include_router(rows.router)
app.include_router(effort.router)
app.include_router(milestones.router)
app.include_router(snapshots.router)
app.include_router(aggregate.router)
app.include_router(export.router)


@app.get("/api/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}
