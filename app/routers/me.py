"""R31 첫 실행 동의 / R02 마지막 접속 시각."""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.db import UserConn

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
