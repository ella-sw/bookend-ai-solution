"""R31 첫 실행 동의·모든 기록 지우기 / R02 마지막 접속 시각."""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.db import ConsentedConn, UserConn

router = APIRouter(prefix="/me", tags=["me"])


class Me(BaseModel):
    id: UUID
    ai_consent_at: datetime | None
    last_seen_at: datetime
    data_cleared_at: datetime | None


@router.get("", response_model=Me)
async def get_me(conn: UserConn) -> dict:
    """Returns the caller and records this visit. 404 = not consented yet (show O110)."""
    row = await (
        await conn.execute(
            "update users set last_seen_at = now() where id = auth.uid() "
            "returning id, ai_consent_at, last_seen_at, data_cleared_at"
        )
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_consented")
    return row


@router.post("/consent", response_model=Me)
async def consent(conn: UserConn) -> dict:
    """Creates the user row on first consent. Calling it again keeps the first consent time."""
    return await (
        await conn.execute(
            """
            insert into users (id, ai_consent_at) values (auth.uid(), now())
            on conflict (id) do update set last_seen_at = now()
            returning id, ai_consent_at, last_seen_at, data_cleared_at
            """
        )
    ).fetchone()


@router.delete("/data", response_model=Me)
async def clear_all(conn: ConsentedConn) -> dict:
    """S120 모든 기록 지우기 (ERD rule 14): 원본 기록·문답·임시 저장·소재·주제 연결·글·버전·
    글쓰기 제안·AI 요청 기록·이벤트를 지운다. 사용자 행과 동의 시각은 남긴다 (다시 묻지 않음).

    AI results that arrive afterwards are not saved: their request rows are gone, and
    results are applied only to a request that is still running. Safe to call twice.
    """
    await conn.execute("select clear_user_data(auth.uid())")
    return await (await conn.execute(
        "select id, ai_consent_at, last_seen_at, data_cleared_at from users where id = auth.uid()"
    )).fetchone()
