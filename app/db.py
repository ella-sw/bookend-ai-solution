"""Database access.

Every request that touches user data runs in one transaction as the `app_user`
role with the caller's id as the JWT claim, so the RLS policies in
supabase/migrations apply to server queries too. Still filter by user in SQL:
RLS is the safety net, not the only check.
"""

import json
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, HTTPException, status
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.auth import CurrentUser, current_user

_pool: AsyncConnectionPool | None = None


async def open_pool(database_url: str) -> None:
    global _pool
    _pool = AsyncConnectionPool(
        database_url,
        min_size=1,
        max_size=10,
        open=False,
        # prepare_threshold=None keeps it working behind Supabase's pooler
        kwargs={"row_factory": dict_row, "prepare_threshold": None},
    )
    await _pool.open()


async def close_pool() -> None:
    if _pool is not None:
        await _pool.close()


def pool() -> AsyncConnectionPool:
    if _pool is None:
        raise RuntimeError("database pool is not open")
    return _pool


async def user_conn(
    user: Annotated[CurrentUser, Depends(current_user)],
) -> AsyncIterator[AsyncConnection]:
    """FastAPI dependency: a connection acting as the calling user, in one transaction."""
    async with pool().connection() as conn, conn.transaction():
        await conn.execute("set local role app_user")
        await conn.execute(
            "select set_config('request.jwt.claims', %s, true)",
            (json.dumps({"sub": str(user.id), "role": "authenticated"}),),
        )
        yield conn


UserConn = Annotated[AsyncConnection, Depends(user_conn)]


async def consented_conn(conn: UserConn) -> AsyncConnection:
    """Like UserConn, but 403 `not_consented` until the caller agreed on O110 (users row exists)."""
    if await (await conn.execute("select 1 from users where id = auth.uid()")).fetchone() is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_consented")
    return conn


ConsentedConn = Annotated[AsyncConnection, Depends(consented_conn)]
