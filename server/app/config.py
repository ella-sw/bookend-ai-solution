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
    # R32: AI calls per user per day (KST). Provisional until the team decides (정할 것 1번).
    ai_daily_limit: int = 50

    @property
    def cors_origin_list(self) -> list[str]:
        # Browsers send the origin without a trailing slash ("https://x.vercel.app"),
        # so "https://x.vercel.app/" copied from the address bar would never match.
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
