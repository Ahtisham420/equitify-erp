from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_NAME: str = "EquitiFy"
    API_PREFIX: str = "/api/v1"

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/equitify"

    JWT_SECRET: str = "change-me"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_MINUTES: int = 480
    MFA_TOKEN_MINUTES: int = 10
    MFA_ENFORCED: bool = True
    MFA_ISSUER: str = "EquitiFy"

    CORS_ORIGINS: list[str] = ["http://localhost:3000"]
    STORAGE_DIR: str = "storage"
    SCHEDULER_ENABLED: bool = True  # periodic automations (app/core/scheduler.py)

    SEED_ADMIN_EMAIL: str = "admin@equitify.local"
    SEED_ADMIN_PASSWORD: str = "Admin@12345"

    # Platform (spec 36): deployment environment and at-rest encryption of integration credentials.
    ENVIRONMENT: str = "development"  # development | staging | production
    ENCRYPTION_KEY: str = ""  # Fernet key (urlsafe base64, 32 bytes). Derived from JWT_SECRET when empty (dev only).

    # Optional AI provider (Release 6). Without a key every AI feature degrades gracefully.
    ANTHROPIC_API_KEY: str = ""
    AI_MODEL: str = "claude-opus-5-5"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
