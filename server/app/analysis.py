"""R28 소재 분석: run the AI on a saved record and store the result.

Flow (ERD rules 3–5, B·C 규칙 3):
  1. [소재로 저장] commits the record. Then `start_analysis` records an AI request
     (kind 'extract') and sets the record to 'analyzing' with that request number.
  2. The save response goes back at once. `run_analysis` runs after it (FastAPI
     background task), so closing the screen does not stop the analysis.
  3. The result is applied only if the request is still 'running' and is the record's
     latest analysis request; otherwise it is 'discarded'.
  4. Limits: the AI call gives up after `ai_extract_timeout_seconds` (55s). If the
     server dies mid-way, the request is timed out after 60s by `expire_if_stale`
     (when the screen asks) or the pg_cron job (every minute).
"""

import asyncio
import logging
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from app.ai import AIError, AIExtract, ExtractedMaterial, ExtractSource, MaterialAI, Turn
from app.config import get_settings
from app.db import user_tx

log = logging.getLogger(__name__)

ANALYSIS_LIMIT = "interval '60 seconds'"  # same as expire_ai_requests()
MAX_SUMMARY = 200
MAX_TITLE = 50
MAX_KEYWORDS = 10
MAX_KEYWORD = 30


# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------
async def start_analysis(conn: AsyncConnection, record_id: UUID) -> int | None:
    """Create the analysis request for a saved record of the caller.

    Returns the request number, or None when the record is not saved or an analysis is
    already running for it (같은 기록에 진행 중인 분석이 있으면 새 요청을 만들지 않는다).
    """
    rec = await (await conn.execute(
        "select analysis_status from records "
        "where id = %s and user_id = auth.uid() and status = 'saved' for update",
        (record_id,),
    )).fetchone()
    if rec is None or rec["analysis_status"] == "analyzing":
        return None
    req = await (await conn.execute(
        "insert into ai_requests (user_id, kind, target_type, target_id) "
        "values (auth.uid(), 'extract', 'record', %s) returning id",
        (record_id,),
    )).fetchone()
    await conn.execute(
        "update records set analysis_status = 'analyzing', latest_analysis_request_id = %s "
        "where id = %s",
        (req["id"], record_id),
    )
    return req["id"]


async def start_after_save(user_id: UUID, record_id: UUID) -> int | None:
    """Start the analysis right after [소재로 저장] committed.

    Agreed with A: if this fails, the save still succeeds and the record shows
    'failed' (분석하지 못했어요 + [다시 분석]).
    """
    try:
        async with user_tx(user_id) as conn:
            return await start_analysis(conn, record_id)
    except Exception:
        log.exception("could not start analysis for record %s", record_id)
        try:
            async with user_tx(user_id) as conn:
                await conn.execute(
                    "update records set analysis_status = 'failed' "
                    "where id = %s and analysis_status <> 'analyzing'",
                    (record_id,),
                )
        except Exception:
            log.exception("could not mark record %s as failed", record_id)
        return None


async def expire_if_stale(conn: AsyncConnection, record_id: UUID) -> None:
    """60-second limit, checked when the screen asks (the cron job is the backup)."""
    await conn.execute(
        f"""
        with expired as (
          update ai_requests a set status = 'timeout', finished_at = now(),
                 failure_reason = 'timeout'
            from records r
           where r.id = %s and a.id = r.latest_analysis_request_id
             and a.status = 'running' and a.started_at < now() - {ANALYSIS_LIMIT}
          returning a.id
        )
        update records set analysis_status = 'failed'
         where id = %s and analysis_status = 'analyzing'
           and latest_analysis_request_id in (select id from expired)
        """,
        (record_id, record_id),
    )


# ---------------------------------------------------------------------------
# Run (background)
# ---------------------------------------------------------------------------
async def _source(conn: AsyncConnection, record_id: UUID) -> ExtractSource | None:
    rec = await (await conn.execute(
        "select type, title, body from records where id = %s and user_id = auth.uid()",
        (record_id,),
    )).fetchone()
    if rec is None:
        return None
    turns = []
    if rec["type"] == "qna":
        rows = await (await conn.execute(
            "select question, answer from qna_messages "
            "where record_id = %s and not is_replaced and answer is not null order by seq",
            (record_id,),
        )).fetchall()
        turns = [Turn(r["question"], r["answer"]) for r in rows]
    return ExtractSource(rec["type"], rec["title"], rec["body"], turns)


def _squash(text: str) -> str:
    return " ".join(text.split())


def validate_material(m: ExtractedMaterial, source: ExtractSource,
                      topic_ids: dict[str, int]) -> dict:
    """Server checks on the AI result (R28). Raises AIError('invalid_result: ...')."""
    summary = (m.summary or "").strip()
    evidence = (m.evidence or "").strip()
    if not summary:
        raise AIError("invalid_result: empty summary")
    if not evidence or _squash(evidence) not in _squash(source.user_text()):
        raise AIError("invalid_result: evidence is not in the user's text")

    keywords: list[str] = []
    for k in m.keywords or []:
        k = (k or "").strip()[:MAX_KEYWORD]
        if k and k not in keywords:
            keywords.append(k)
    topics = sorted({topic_ids[t.strip()] for t in m.topics or [] if t.strip() in topic_ids})
    if not topics:
        raise AIError("invalid_result: no topic from the list")

    return {
        "title": (m.title or "").strip()[:MAX_TITLE] or None,
        "summary": summary[:MAX_SUMMARY],
        "evidence": evidence,
        "keywords": keywords[:MAX_KEYWORDS],
        "topics": topics,
    }


async def _finish_failed(user_id: UUID, record_id: UUID, request_id: int, reason: str,
                         timed_out: bool) -> None:
    async with user_tx(user_id) as conn:
        await conn.execute("select 1 from records where id = %s for update", (record_id,))
        await conn.execute(
            "update ai_requests set status = %s, finished_at = now(), failure_reason = %s "
            "where id = %s and status = 'running'",
            ("timeout" if timed_out else "failed", reason[:200], request_id),
        )
        await conn.execute(
            "update records set analysis_status = 'failed' "
            "where id = %s and latest_analysis_request_id = %s and analysis_status = 'analyzing'",
            (record_id, request_id),
        )


async def _apply(conn: AsyncConnection, record_id: UUID, material: dict | None,
                 result: AIExtract) -> None:
    existing = await (await conn.execute(
        "select id, confirmed_at from materials where record_id = %s for update", (record_id,),
    )).fetchone()
    if existing is not None and existing["confirmed_at"] is not None:
        # R27 다시 분석: a confirmed material is never overwritten. The new result waits on
        # the request until [바꾸기] (POST /materials/{id}/reanalysis/apply) or [그대로 두기].
        await conn.execute(
            "update ai_requests set result = %s where id = "
            "(select latest_analysis_request_id from records where id = %s)",
            (Jsonb({"material": material}), record_id),
        )
        await conn.execute(
            "update records set analysis_status = 'done' where id = %s", (record_id,))
        return

    if material is None:
        await conn.execute(
            "update records set analysis_status = 'empty' where id = %s", (record_id,))
        return

    row = await (await conn.execute(
        """
        insert into materials (user_id, record_id, title, summary, evidence, keywords, origin)
        values (auth.uid(), %(record)s, %(title)s, %(summary)s, %(evidence)s, %(keywords)s, 'ai')
        on conflict (record_id) do update
           set title = excluded.title, summary = excluded.summary,
               evidence = excluded.evidence, keywords = excluded.keywords, origin = 'ai'
        returning id
        """,
        {"record": record_id, **material},
    )).fetchone()
    await set_topics(conn, row["id"], material["topics"])
    await conn.execute(
        "update records set analysis_status = 'done' where id = %s", (record_id,))


async def set_topics(conn: AsyncConnection, material_id: UUID, topic_ids: list[int]) -> None:
    """Replace a material's topics (only rows that change, so updated_at moves only then)."""
    await conn.execute(
        "delete from material_topics where material_id = %s and topic_id <> all(%s::smallint[])",
        (material_id, topic_ids),
    )
    await conn.execute(
        "insert into material_topics (material_id, topic_id) "
        "select %s, unnest(%s::smallint[]) on conflict do nothing",
        (material_id, topic_ids),
    )


async def run_analysis(user_id: UUID, record_id: UUID, request_id: int, ai: MaterialAI) -> None:
    """Background task: call the AI outside any transaction, then apply the result."""
    try:
        async with user_tx(user_id) as conn:
            source = await _source(conn, record_id)
            topic_rows = await (await conn.execute("select id, name from topics")).fetchall()
        if source is None:  # record deleted meanwhile
            return
        topic_ids = {t["name"]: t["id"] for t in topic_rows}

        try:
            result = await asyncio.wait_for(
                ai.extract_material(source, list(topic_ids)),
                get_settings().ai_extract_timeout_seconds,
            )
            material = (validate_material(result.material, source, topic_ids)
                        if result.material is not None else None)
        except Exception as e:  # noqa: BLE001 - any AI failure ends as 'failed'
            reason = str(e) if isinstance(e, AIError) else type(e).__name__
            await _finish_failed(user_id, record_id, request_id, reason or "AIError",
                                 isinstance(e, TimeoutError))
            return

        async with user_tx(user_id) as conn:
            rec = await (await conn.execute(
                "select analysis_status, latest_analysis_request_id from records "
                "where id = %s for update",
                (record_id,),
            )).fetchone()
            latest = (rec is not None and rec["latest_analysis_request_id"] == request_id
                      and rec["analysis_status"] == "analyzing")
            # B·C 규칙 3: apply only while running and only the latest request.
            # A result that arrives after the time limit is kept as 'discarded'.
            req = await (await conn.execute(
                "update ai_requests set "
                "status = case when status = 'running' and %s then 'ok' else 'discarded' end, "
                "finished_at = coalesce(finished_at, now()), "
                "input_tokens = %s, output_tokens = %s "
                "where id = %s and status in ('running', 'timeout') returning status",
                (latest, result.input_tokens, result.output_tokens, request_id),
            )).fetchone()
            if req is not None and req["status"] == "ok":
                await _apply(conn, record_id, material, result)
    except Exception:
        # Leave it to the 60-second limit, which turns it into 'failed'.
        log.exception("analysis %s for record %s crashed", request_id, record_id)
