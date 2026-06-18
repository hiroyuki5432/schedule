"""Application settings loaded from environment variables."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database
    DATABASE_URL: str = "postgresql+psycopg://app:app@localhost:5432/schedule"

    # Sessions
    SESSION_SECRET: str = "change-me-in-prod-please-use-a-long-random-string"
    # Set true in production (behind HTTPS) so the session cookie is Secure-only.
    COOKIE_SECURE: bool = False

    # Seeding
    SEED_ON_STARTUP: bool = True
    DEMO_ADMIN_EMAIL: str = "admin@demo.local"
    DEMO_ADMIN_PASSWORD: str = "demo1234"


settings = Settings()
