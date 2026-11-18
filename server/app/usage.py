"""R32 사용자별 하루 AI 호출 한도.

Every AI call the user starts (follow-up question, [다른 질문 보기], material analysis,
re-analysis; later drafts and re-writes) takes one call from today's quota (KST date),
in the same transaction that records the AI request. Over the limit → DailyLimitError:
nothing is recorded and the AI is not called.

Not counted: the 30 shared daily questions (made once a day for everyone) and suggestion
recomputes (started by the server, not the user; R30).

The limit is the AI_DAILY_LIMIT setting (provisional until the team decides it from C's
measurements, 정할 것 1번).
"""

from psycopg import AsyncConnection

from app.config import get_settings

KST_TODAY = "(now() at time zone 'Asia/Seoul')::date"


class DailyLimitError(Exception):
    """'오늘 사용할 수 있는 횟수를 다 썼어요' → HTTP 429 `daily_limit`."""


async def take_ai_call(conn: AsyncConnection) -> None:
    """Count one AI call for the caller today, or raise DailyLimitError.

    Run it in the same transaction as the ai_requests insert: if that rolls back, the
    call is not counted. The row lock on today's counter serialises concurrent calls.
    """
    row = await (await conn.execute(
        f"""
        insert into ai_usage (user_id, day, calls) values (auth.uid(), {KST_TODAY}, 1)
        on conflict (user_id, day) do update set calls = ai_usage.calls + 1
        returning calls
        """
    )).fetchone()
    if row["calls"] > get_settings().ai_daily_limit:
        raise DailyLimitError


async def usage_today(conn: AsyncConnection) -> dict:
    """{'ai_calls_today': n, 'ai_daily_limit': limit, 'daily_limit_reached': bool}"""
    row = await (await conn.execute(
        f"select coalesce((select calls from ai_usage where user_id = auth.uid() "
        f"and day = {KST_TODAY}), 0) as calls"
    )).fetchone()
    limit = get_settings().ai_daily_limit
    return {"ai_calls_today": row["calls"], "ai_daily_limit": limit,
            "daily_limit_reached": row["calls"] >= limit}
