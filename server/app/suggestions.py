"""R30 주제별 글쓰기 제안: recompute after confirmed materials change.

When:  a material is confirmed, edited (both old and new topics), re-analysed with
       [바꾸기], or deleted. The router schedules `recompute_topics` as a background task
       after its transaction commits, so the user never waits for the AI.
Rule:  a topic gets a suggestion when confirmed, not deleted materials from at least
       `suggest_min_records` different records are in it (one material per record, so
       materials = records). Fewer → the suggestion is removed.
Same:  basis_hash = every such material's (id, updated_at) (ERD rule 9). Same hash and
       already ready/none → the AI is not called again. failed → retried on the next change.
Late:  the result is applied only if the request is still running and the suggestion's
       basis_hash is still the one the request was made for (B·C 규칙 3).
Cost:  not counted in the daily limit (R32): the server starts it, not the user.
"""

import asyncio
import hashlib
import logging
from uuid import UUID

from psycopg import AsyncConnection

from app.ai import AIError, SuggestAI, SuggestMaterial
from app.config import get_settings
from app.db import user_tx

log = logging.getLogger(__name__)

MAX_SENT = 20  # newest materials of the topic sent to the AI
STALE = "interval '60 seconds'"  # same as expire_ai_requests()


def _hash(rows: list[dict]) -> str:
    text = "|".join(f"{r['id']}:{r['updated_at'].isoformat()}" for r in sorted(
        rows, key=lambda r: str(r["id"])))
    return hashlib.sha256(text.encode()).hexdigest()


async def _topic_materials(conn: AsyncConnection, topic_id: int) -> list[dict]:
    return await (await conn.execute(
        """
        select m.id, m.title, m.summary, m.evidence, m.keywords, m.updated_at
          from materials m join material_topics mt on mt.material_id = m.id
         where m.user_id = auth.uid() and mt.topic_id = %s
           and m.confirmed_at is not null and m.deleted_at is null
         order by m.updated_at desc
        """,
        (topic_id,),
    )).fetchall()


async def expire_stale(conn: AsyncConnection) -> None:
    """60-second limit for the caller's suggestion requests (the cron job is the backup)."""
    await conn.execute(
        f"""
        with expired as (
          update ai_requests set status = 'timeout', finished_at = now(),
                 failure_reason = 'timeout'
           where user_id = auth.uid() and kind = 'suggest' and status = 'running'
             and started_at < now() - {STALE}
          returning target_id
        )
        update suggestions set status = 'failed', computed_at = now()
         where id in (select target_id from expired) and status = 'computing'
        """
    )


async def _start(user_id: UUID, topic_id: int) -> tuple | None:
    """Decide in one transaction. Returns (suggestion id, request id, hash, topic name,
    materials) when the AI must be called, None otherwise."""
    async with user_tx(user_id) as conn:
        # one recompute per topic at a time
        await conn.execute("select pg_advisory_xact_lock(hashtext(auth.uid()::text), %s)",
                           (topic_id,))
        await expire_stale(conn)
        rows = await _topic_materials(conn, topic_id)
        if len(rows) < get_settings().suggest_min_records:
            await conn.execute(
                "delete from suggestions where user_id = auth.uid() and topic_id = %s",
                (topic_id,))
            return None
        basis = _hash(rows)
        cur = await (await conn.execute(
            "select id, status, basis_hash from suggestions "
            "where user_id = auth.uid() and topic_id = %s for update", (topic_id,))).fetchone()
        if cur is not None and cur["basis_hash"] == basis and cur["status"] != "failed":
            return None  # ready/none: reuse; computing: already on its way
        sug = await (await conn.execute(
            """
            insert into suggestions (user_id, topic_id, status, basis_hash)
            values (auth.uid(), %s, 'computing', %s)
            on conflict (user_id, topic_id)
            do update set status = 'computing', basis_hash = excluded.basis_hash
            returning id
            """,
            (topic_id, basis),
        )).fetchone()
        req = await (await conn.execute(
            "insert into ai_requests (user_id, kind, target_type, target_id) "
            "values (auth.uid(), 'suggest', 'suggestion', %s) returning id",
            (sug["id"],))).fetchone()
        topic = await (await conn.execute(
            "select name from topics where id = %s", (topic_id,))).fetchone()
        return sug["id"], req["id"], basis, topic["name"], rows[:MAX_SENT]


async def _recompute(user_id: UUID, topic_id: int, ai: SuggestAI) -> None:
    started = await _start(user_id, topic_id)
    if started is None:
        return
    sug_id, req_id, basis, topic, rows = started
    min_n = get_settings().suggest_min_records
    sent = {str(r["id"]) for r in rows}
    try:
        out = await asyncio.wait_for(
            ai.suggest(topic, [SuggestMaterial(str(r["id"]), r["title"], r["summary"],
                                               r["evidence"], r["keywords"]) for r in rows],
                       min_n),
            get_settings().ai_suggest_timeout_seconds)
        s = out.suggestion
        if s is not None:
            ids = list(dict.fromkeys(s.material_ids))
            if not (s.title.strip() and s.direction.strip() and s.reason.strip()):
                raise AIError("invalid_result: empty title, direction or reason")
            if not set(ids) <= sent or len(ids) < min_n:
                raise AIError(f"invalid_result: needs {min_n}+ materials from the given list")
    except Exception as e:  # noqa: BLE001 - any failure → failed, retried on the next change
        async with user_tx(user_id) as conn:
            await conn.execute(
                "update ai_requests set status = %s, finished_at = now(), failure_reason = %s "
                "where id = %s and status = 'running'",
                ("timeout" if isinstance(e, TimeoutError) else "failed",
                 (str(e) if isinstance(e, AIError) else type(e).__name__)[:200], req_id))
            await conn.execute(
                "update suggestions set status = 'failed', computed_at = now() "
                "where id = %s and basis_hash = %s and status = 'computing'", (sug_id, basis))
        return

    async with user_tx(user_id) as conn:
        cur = await (await conn.execute(
            "select basis_hash from suggestions where id = %s for update", (sug_id,))).fetchone()
        latest = cur is not None and cur["basis_hash"] == basis
        req = await (await conn.execute(
            "update ai_requests set status = case when status = 'running' and %s then 'ok' "
            "else 'discarded' end, finished_at = coalesce(finished_at, now()), "
            "input_tokens = %s, output_tokens = %s "
            "where id = %s and status in ('running', 'timeout') returning status",
            (latest, out.input_tokens, out.output_tokens, req_id))).fetchone()
        if req is None or req["status"] != "ok":
            # too late: don't leave this suggestion 'computing' (no card; retried next change)
            await conn.execute(
                "update suggestions set status = 'failed', computed_at = now() "
                "where id = %s and basis_hash = %s and status = 'computing'", (sug_id, basis))
            return
        if s is None:
            await conn.execute(
                "update suggestions set status = 'none', title = null, direction = null, "
                "reason = null, computed_at = now() where id = %s", (sug_id,))
            await conn.execute("delete from suggestion_materials where suggestion_id = %s",
                               (sug_id,))
            return
        await conn.execute(
            "update suggestions set status = 'ready', title = %s, direction = %s, reason = %s, "
            "computed_at = now() where id = %s",
            (s.title.strip(), s.direction.strip(), s.reason.strip(), sug_id))
        await conn.execute("delete from suggestion_materials where suggestion_id = %s",
                           (sug_id,))
        await conn.execute(
            "insert into suggestion_materials (suggestion_id, material_id, seq) "
            "select %s, m::uuid, n from unnest(%s::text[]) with ordinality as t(m, n)",
            (sug_id, ids))


async def recompute_topics(user_id: UUID, topic_ids: set[int] | list[int],
                           ai: SuggestAI) -> None:
    """Background task: recompute each topic; one topic's failure doesn't stop the others."""
    for topic_id in sorted(set(topic_ids)):
        try:
            await _recompute(user_id, topic_id, ai)
        except Exception:
            log.exception("suggestion recompute failed (topic %s)", topic_id)
