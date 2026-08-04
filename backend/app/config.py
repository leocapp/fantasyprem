"""Application settings, loaded from environment variables / .env."""

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "FantasyPrem API"
    environment: str = "development"

    cors_origins: list[str] = ["http://localhost:3000"]

    # Supabase
    supabase_url: str | None = None
    supabase_service_role_key: str | None = None
    supabase_jwt_secret: str | None = None

    # Postgres (unused for now — reserved for when models are added)
    database_url: str | None = None

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @property
    def is_supabase_configured(self) -> bool:
        return bool(self.supabase_url) or bool(self.supabase_jwt_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
