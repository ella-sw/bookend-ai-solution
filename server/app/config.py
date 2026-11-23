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
    # R07: the whole draft (with one automatic retry for length) must finish within this,
    # below the 60-second limit after which expire_ai_requests() times a request out.
    ai_essay_deadline_seconds: float = 55
    # R30: a topic gets a suggestion once this many different records have a confirmed
    # material in it (provisional: 3, to be tuned after testing).
    suggest_min_records: int = 3
    ai_suggest_timeout_seconds: float = 55
    # R32: AI calls per user per day (KST). Provisional until the team decides (정할 것 1번).
    ai_daily_limit: int = 50
    # 시연 계정 (rec, guest): 심사위원 여러 명이 한 계정을 같이 쓰므로 한도를 따로 둔다.
    # Supabase Authentication > Users의 User UID를 쉼표로 이어 쓴다.
    demo_user_ids: str = ""
    ai_daily_limit_demo: int = 500

    @property
    def demo_user_id_set(self) -> set[str]:
        return {u.strip().lower() for u in self.demo_user_ids.split(",") if u.strip()}

    def daily_limit_for(self, user_id: object) -> int:
        """R32 limit for this user: demo accounts get ai_daily_limit_demo."""
        if str(user_id).lower() in self.demo_user_id_set:
            return self.ai_daily_limit_demo
        return self.ai_daily_limit

    @property
    def cors_origin_list(self) -> list[str]:
        # Browsers send the origin without a trailing slash ("https://x.vercel.app"),
        # so "https://x.vercel.app/" copied from the address bar would never match.
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
