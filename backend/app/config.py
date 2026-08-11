"""Application settings, loaded from environment variables / .env."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "FantasyPrem API"
    environment: str = "development"

    # Kept as a plain string: pydantic-settings JSON-decodes list-typed fields
    # straight from .env, which breaks on comma-separated input.
    cors_origins: str = "http://localhost:3000"

    # Supabase
    supabase_url: str | None = None
    supabase_service_role_key: str | None = None
    supabase_jwt_secret: str | None = None

    # Postgres (unused for now — reserved for when models are added)
    database_url: str | None = None

    # Email reminders. Without an API key the reminder job is a no-op, so
    # everything else runs fine with email unconfigured.
    resend_api_key: str | None = None
    reminder_from: str = "FatBoysFantasy <noreply@fatboysfantasy.com>"
    site_url: str = "https://fatboysfantasy.com"

    @property
    def cors_origin_list(self) -> list[str]:
        """CORS_ORIGINS parsed from its comma-separated form."""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_supabase_configured(self) -> bool:
        return bool(self.supabase_url) or bool(self.supabase_jwt_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
