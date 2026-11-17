from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    supabase_url: str = ""
    # Legacy HS256 secret. When empty, tokens are verified with the project's JWKS.
    supabase_jwt_secret: str = ""
    jwt_audience: str = "authenticated"
    cors_origins: str = "http://localhost:3000"

    # AI (C). "stub" = fixed sample questions, no external calls (until C's code is in).
    ai_provider: str = "stub"
    ai_question_timeout_seconds: float = 30
    # R28: the AI call gives up a little before the 60-second limit (expire_ai_requests),
    # so the user sees '분석하지 못했어요' within 60 seconds either way.
    ai_extract_timeout_seconds: float = 55

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
