"""FastAPI application entrypoint."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.version import VERSION, build_info
from app.routers import (
    aggregate,
    auth,
    backup,
    columns,
    effort,
    excel,
    export,
    imports,
    members,
    milestones,
    notifications,
    org,
    rows,
    search,
    sheets,
    snapshots,
    worklog,
)

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.SEED_ON_STARTUP:
        try:
            from app.seed import maybe_seed

            maybe_seed()
            logger.info("Seed check complete.")
        except Exception:  # pragma: no cover - seed must never block startup
            logger.exception("Seed failed (continuing startup).")
    yield


app = FastAPI(title="工数スケジュール管理 API", version=VERSION, lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SESSION_SECRET,
    https_only=settings.COOKIE_SECURE,  # true in prod (HTTPS); false for local dev
    same_site="lax",
)

# Order matters only for documentation grouping; paths are disjoint.
app.include_router(auth.router)
app.include_router(backup.router)
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
app.include_router(excel.router)
app.include_router(imports.router)
app.include_router(worklog.router)
app.include_router(notifications.router)
app.include_router(search.router)


@app.get("/api/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok", **build_info()}


@app.get("/api/version", tags=["health"])
def version() -> dict[str, str]:
    """サーバ側で実際に動いているバージョン。画面のバージョン表示が、これと自分
    （フロント）を突き合わせて「片方だけ古い」を検出する。認証不要 — ログインできない
    ときこそ知りたい情報なので。"""
    return build_info()
