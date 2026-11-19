"""R07 AI 초안·다시 만들기 · R08 다시 만든 결과 저장 (W310–W341, L120 [다시 만들기]).

Screen flow:
  N120 → W310 문체 → W320 길이 → [에세이 만들기]
        POST /essays/ai                     → 초안 (version 0) 자동 보관, W330
  [다시 만들기] (W330, W340, L120)
        POST /essays/{id}/regenerate        → 저장 안 된 결과 (W340, '다시 만들기 N회째')
          based_on_version_id: 보고 있던 버전 / based_on_request_id: 직전 다시 만든 결과
  W341 [저장하기]
        POST /essays/{id}/regenerations/{request_id}/save → 다음 번호 버전 → L120

Rules (requirements R07·R08, ERD 1, 7, 11, 12):
- AI input: the chosen materials in order (요약·근거 + 원본 up to 1,500 characters),
  direction, style, length. Deleted materials are never sent; for 다시 만들기 the text being
  rewritten is sent as it is. What was sent is kept in generation_input.
- Length = body characters, spaces included, title excluded (단문 300–500, 장문 1,000–1,500).
  Out of range → one automatic retry; still out → shown with in_length_range = false.
- The AI is called outside any transaction and must finish within 55 seconds in total
  (expire_ai_requests times requests out after 60). A late result is not used.
- One user action = one call from the daily limit (R32); the length retry is free.
- 초안 is kept automatically and does not count as essay_saved (R33); saving a 다시 만든
  결과 does. A result that is not saved just stays unused.
"""

import asyncio
import time
from dataclasses import asdict, replace
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Response, status
from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, StringConstraints

from app.ai import AIError, AIEssay, DraftInput, EssayAI, MaterialInput, get_essay_ai
from app.auth import CurrentUser, current_user
from app.config import get_settings
from app.db import require_consent, user_tx
from app.routers.essays import (
    LENGTHS,
    Essay,
    _after_save,
    _essay,
    _insert_version,
    _version_by_token,
    in_length_range,
)
from app.usage import take_ai_call

router = APIRouter(prefix="/essays", tags=["ai essays"])

User = Annotated[CurrentUser, Depends(current_user)]
AI = Annotated[EssayAI, Depends(get_essay_ai)]

ORIGINAL_LIMIT = 1_500  # 원본은 소재당 1,500자까지 (ERD rule 11)
RETRY_MIN_SECONDS = 5  # don't start the length retry with less time than this left
Style = Literal["감성적", "담백함"]
Length = Literal["short", "long"]
Direction = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class FirstDraftIn(BaseModel):
    material_ids: Annotated[list[UUID], Field(min_length=1, max_length=20,
                                              description="고른 소재 (1개 이상), 고른 순서대로")]
    direction: Direction | None = None
    style: Style
    length: Length
    suggestion_id: UUID | None = None
    save_token: UUID = Field(description="[에세이 만들기]를 누를 때 한 번 만들고, "
                                         "[다시 시도]에도 같은 값")


class RegenerateIn(BaseModel):
    based_on_version_id: UUID | None = Field(default=None, description="보고 있던 버전")
    based_on_request_id: int | None = Field(default=None,
                                            description="직전에 다시 만든 (저장 안 한) 결과")
    style: Style
    length: Length


class RegenResult(BaseModel):
    request_id: int  # [저장하기]에 쓰는 번호
    essay_id: UUID
    title: str
    body: str
    char_count: int
    in_length_range: bool
    style: str
    length: str
    regen_count: int  # '다시 만들기 N회째'
    based_on_version_id: UUID  # 저장하면 이 버전을 바탕으로 한 것으로 남는다
    deleted_materials_left_out: bool  # '삭제한 소재는 새로 넣지 않아요' 안내


class SaveRegenIn(BaseModel):
    save_token: UUID = Field(description="W341 [저장하기]를 누를 때 한 번 만들고 "
                                         "[다시 시도]에도 같은 값")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _ai_failed() -> HTTPException:
    """'에세이를 만들지 못했어요' + [다시 시도]."""
    return HTTPException(status.HTTP_502_BAD_GATEWAY, detail="ai_failed")


async def _material_inputs(conn: AsyncConnection, ids: list[UUID]) -> list[dict]:
    """The materials in the given order, with up to 1,500 characters of the original."""
    return await (await conn.execute(
        """
        select m.id::text, m.title, m.summary, m.evidence,
               left(coalesce(nullif(r.body, ''),
                    (select string_agg(q.answer, E'\\n' order by q.seq) from qna_messages q
                      where q.record_id = r.id and q.answer is not null), ''), %s) as original
          from materials m join records r on r.id = m.record_id
         where m.id = any(%s)
         order by array_position(%s::uuid[], m.id)
        """,
        (ORIGINAL_LIMIT, ids, ids),
    )).fetchall()


def _draft_input(materials: list[dict], direction: str | None, style: str, length: str,
                 base_title: str | None = None, base_body: str | None = None) -> DraftInput:
    lo, hi = LENGTHS[length]
    return DraftInput(
        materials=[MaterialInput(m["title"], m["summary"], m["evidence"], m["original"])
                   for m in materials],
        direction=direction, style=style, length=length, min_chars=lo, max_chars=hi,
        base_title=base_title, base_body=base_body,
    )


def _generation_input(inp: DraftInput, materials: list[dict], **base) -> dict:
    """The copy kept on the version (ERD rule 11): exactly what the AI was given."""
    sent = asdict(inp)
    for m, sent_m in zip(materials, sent["materials"], strict=True):
        sent_m["id"] = m["id"]
    return {**sent, **base}


async def _write(ai: EssayAI, inp: DraftInput) -> tuple[AIEssay, DraftInput, int, int]:
    """Call the AI; one automatic retry if the length is out of range and time is left.
    Returns (essay, input actually used, input tokens, output tokens)."""
    deadline = time.monotonic() + get_settings().ai_essay_deadline_seconds
    tokens_in = tokens_out = 0
    result = None
    for attempt in range(2):
        remaining = deadline - time.monotonic()
        if attempt and remaining < RETRY_MIN_SECONDS:
            break
        out = await asyncio.wait_for(ai.write_essay(inp), remaining)
        if not out.body or not out.body.strip():
            raise AIError("empty essay")
        tokens_in += out.input_tokens or 0
        tokens_out += out.output_tokens or 0
        result = out
        if in_length_range(inp.length, len(out.body)):
            break
        inp = replace(inp, last_char_count=len(out.body))
    return result, inp, tokens_in, tokens_out


async def _run(user: CurrentUser, request_id: int, ai: EssayAI, inp: DraftInput):
    """AI call outside any transaction. On failure the request is closed and 502 raised."""
    try:
        return await _write(ai, inp)
    except Exception as e:  # noqa: BLE001 - any AI failure → [다시 시도]
        async with user_tx(user.id) as conn:
            await conn.execute(
                "update ai_requests set status = %s, finished_at = now(), failure_reason = %s "
                "where id = %s and status = 'running'",
                ("timeout" if isinstance(e, TimeoutError) else "failed",
                 (str(e) if isinstance(e, AIError) else type(e).__name__)[:200], request_id),
            )
        raise _ai_failed() from None


async def _close_ok(conn: AsyncConnection, request_id: int, tokens_in: int, tokens_out: int,
                    result: dict | None = None) -> bool:
    """B·C 규칙 3: use the result only while the request is still running. A result that
    arrived after the time limit is kept as 'discarded' and False is returned; the caller
    raises ai_failed *after* this transaction commits, so the mark is not rolled back."""
    row = await (await conn.execute(
        "update ai_requests set status = 'ok', finished_at = now(), input_tokens = %s, "
        "output_tokens = %s, result = %s where id = %s and status = 'running' returning id",
        (tokens_in, tokens_out, Jsonb(result) if result is not None else None, request_id),
    )).fetchone()
    if row is None:
        await conn.execute(
            "update ai_requests set status = 'discarded', input_tokens = %s, output_tokens = %s "
            "where id = %s and status = 'timeout'",
            (tokens_in, tokens_out, request_id))
        return False
    return True


# ---------------------------------------------------------------------------
# W330 처음 만들기
# ---------------------------------------------------------------------------
@router.post("/ai", response_model=Essay, status_code=status.HTTP_201_CREATED,
             responses={200: {"description": "Already made (retry): the essay"},
                        422: {"description": "material_not_available"},
                        429: {"description": "daily_limit"},
                        502: {"description": "ai_failed → [다시 시도]"}})
async def first_draft(data: FirstDraftIn, user: User, ai: AI, response: Response) -> Essay:
    """[에세이 만들기]: AI 초안을 만들어 '초안'(version 0)으로 보관하고 글을 돌려준다.
    Same `save_token` again → 200 with the essay already made (no second AI call)."""
    ids = list(dict.fromkeys(data.material_ids))
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        if (done := await _version_by_token(conn, data.save_token)) is not None:
            response.status_code = status.HTTP_200_OK
            return await _essay(conn, done["essay_id"])
        n = await (await conn.execute(
            "select count(*) n from materials where id = any(%s) and user_id = auth.uid() "
            "and confirmed_at is not null and deleted_at is null", (ids,))).fetchone()
        if n["n"] != len(ids):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                detail="material_not_available")
        if data.suggestion_id is not None and await (await conn.execute(
                "select 1 from suggestions where id = %s and user_id = auth.uid()",
                (data.suggestion_id,))).fetchone() is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="suggestion_not_found")
        materials = await _material_inputs(conn, ids)
        essay_id = uuid4()
        await take_ai_call(conn)  # R32
        req = await (await conn.execute(
            "insert into ai_requests (user_id, kind, target_type, target_id) "
            "values (auth.uid(), 'draft', 'essay', %s) returning id", (essay_id,))).fetchone()

    inp = _draft_input(materials, data.direction or None, data.style, data.length)
    out, used, tokens_in, tokens_out = await _run(user, req["id"], ai, inp)

    async with user_tx(user.id) as conn:
        if not await _close_ok(conn, req["id"], tokens_in, tokens_out):
            essay = None
        else:
            essay = await _save_first_draft(conn, essay_id, ids, data, out, used, materials,
                                            req["id"])
    if essay is None:
        raise _ai_failed()
    return essay


async def _save_first_draft(conn: AsyncConnection, essay_id: UUID, ids: list[UUID],
                            data: FirstDraftIn, out: AIEssay, used: DraftInput,
                            materials: list[dict], request_id: int) -> Essay:
    """Insert the essay, its materials and 초안 (version 0)."""
    await conn.execute(
        "insert into essays (id, user_id, method, status, title, direction, suggestion_id) "
        "values (%s, auth.uid(), 'ai', 'saved', %s, %s, %s)",
        (essay_id, out.title.strip() or None, data.direction or None, data.suggestion_id))
    await conn.execute(
        "insert into essay_materials (essay_id, material_id, seq) "
        "select %s, m, n from unnest(%s::uuid[]) with ordinality as t(m, n)",
        (essay_id, ids))
    await _insert_version(
        conn,
        "insert into essay_versions (essay_id, version_no, kind, title, body, char_count, "
        "style, length, ai_request_id, generation_input, save_token) "
        "values (%s, 0, 'ai_first', %s, %s, %s, %s, %s, %s, %s, %s)",
        (essay_id, out.title.strip() or None, out.body, len(out.body), data.style,
         data.length, request_id, Jsonb(_generation_input(used, materials)),
         data.save_token),
    )
    return await _essay(conn, essay_id)


# ---------------------------------------------------------------------------
# W340 다시 만들기
# ---------------------------------------------------------------------------
@router.post("/{essay_id}/regenerate", response_model=RegenResult,
             responses={409: {"description": "no_result (based_on_request_id is not usable)"},
                        429: {"description": "daily_limit"},
                        502: {"description": "ai_failed → [다시 시도]"}})
async def regenerate(essay_id: UUID, data: RegenerateIn, user: User, ai: AI) -> RegenResult:
    """[다시 만들기]: 지금 보고 있는 글을 바탕으로 다시 쓴다. 결과는 저장하지 않는다
    ([저장하기] 전까지). 직접 쓴 글도 가능. 삭제한 소재는 넘기지 않는다."""
    if (data.based_on_version_id is None) == (data.based_on_request_id is None):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            detail="send based_on_version_id or based_on_request_id")
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        essay = await (await conn.execute(
            "select id, direction from essays where id = %s and user_id = auth.uid() "
            "and status = 'saved' for update", (essay_id,))).fetchone()
        if essay is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="essay_not_found")

        if data.based_on_version_id is not None:
            base = await (await conn.execute(
                "select id, title, body from essay_versions where id = %s and essay_id = %s",
                (data.based_on_version_id, essay_id))).fetchone()
            if base is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, detail="version_not_found")
            base_title, base_body, version_id, count = base["title"], base["body"], base["id"], 1
        else:
            prev = await (await conn.execute(
                "select result from ai_requests where id = %s and kind = 'regen' "
                "and target_id = %s and status = 'ok' and result is not null",
                (data.based_on_request_id, essay_id))).fetchone()
            if prev is None or "body" not in prev["result"]:
                raise HTTPException(status.HTTP_409_CONFLICT, detail="no_result")
            r = prev["result"]
            base_title, base_body = r["title"], r["body"]
            version_id, count = UUID(r["based_on_version_id"]), r["regen_count"] + 1
            await _require_version(conn, essay_id, version_id)  # L121: may have been deleted

        rows = await (await conn.execute(
            "select em.material_id, m.deleted_at is not null as deleted from essay_materials em "
            "join materials m on m.id = em.material_id where em.essay_id = %s order by em.seq",
            (essay_id,))).fetchall()
        live = [r["material_id"] for r in rows if not r["deleted"]]
        materials = await _material_inputs(conn, live) if live else []
        await take_ai_call(conn)  # R32
        req = await (await conn.execute(
            "insert into ai_requests (user_id, kind, target_type, target_id) "
            "values (auth.uid(), 'regen', 'essay', %s) returning id", (essay_id,))).fetchone()

    inp = _draft_input(materials, essay["direction"], data.style, data.length,
                       base_title=base_title, base_body=base_body)
    out, used, tokens_in, tokens_out = await _run(user, req["id"], ai, inp)
    result = {
        "title": out.title.strip() or base_title or "", "body": out.body,
        "char_count": len(out.body), "style": data.style, "length": data.length,
        "regen_count": count, "based_on_version_id": str(version_id),
        "generation_input": _generation_input(
            used, materials, based_on_version_id=str(version_id),
            based_on_request_id=data.based_on_request_id),
    }
    async with user_tx(user.id) as conn:
        ok = await _close_ok(conn, req["id"], tokens_in, tokens_out, result)
    if not ok:
        raise _ai_failed()
    return RegenResult(
        request_id=req["id"], essay_id=essay_id, title=result["title"], body=out.body,
        char_count=len(out.body), in_length_range=bool(in_length_range(data.length,
                                                                       len(out.body))),
        style=data.style, length=data.length, regen_count=count,
        based_on_version_id=version_id,
        deleted_materials_left_out=any(r["deleted"] for r in rows),
    )


async def _require_version(conn, essay_id: UUID, version_id) -> None:
    """404 version_not_found if the base version no longer exists (deleted in L121)."""
    if await (await conn.execute(
            "select 1 from essay_versions where id = %s and essay_id = %s",
            (version_id, essay_id))).fetchone() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="version_not_found")


# ---------------------------------------------------------------------------
# W341 [저장하기]
# ---------------------------------------------------------------------------
@router.post("/{essay_id}/regenerations/{request_id}/save", response_model=Essay,
             status_code=status.HTTP_201_CREATED,
             responses={200: {"description": "Already saved (retry): the essay"},
                        409: {"description": "no_result"}})
async def save_regeneration(essay_id: UUID, request_id: int, data: SaveRegenIn,
                            user: User, response: Response) -> Essay:
    """다시 만든 결과를 다음 번호 버전으로 저장한다 (초안 다음 첫 저장은 v1).
    두 번 눌러도 버전은 하나 (`save_token`)."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        essay = await (await conn.execute(
            "select id, method from essays where id = %s and user_id = auth.uid() "
            "and status = 'saved' for update", (essay_id,))).fetchone()
        if essay is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="essay_not_found")
        if (done := await _version_by_token(conn, data.save_token)) is not None:
            response.status_code = status.HTTP_200_OK
            return await _essay(conn, done["essay_id"])
        req = await (await conn.execute(
            "select result from ai_requests where id = %s and kind = 'regen' "
            "and target_id = %s and status = 'ok' and result is not null for update",
            (request_id, essay_id))).fetchone()
        if req is None or "body" not in req["result"]:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="no_result")
        r = req["result"]
        # L121: the version this result was based on may have been deleted meanwhile
        await _require_version(conn, essay_id, r["based_on_version_id"])
        await _insert_version(
            conn,
            """
            insert into essay_versions (essay_id, version_no, kind, title, body, char_count,
                                        style, length, regen_count, based_on_version_id,
                                        ai_request_id, generation_input, save_token)
            select %s, coalesce(max(version_no), 0) + 1, 'ai_regen', %s, %s, %s, %s, %s, %s,
                   %s, %s, %s, %s
              from essay_versions where essay_id = %s
            """,
            (essay_id, r["title"] or None, r["body"], r["char_count"], r["style"], r["length"],
             r["regen_count"], r["based_on_version_id"], request_id,
             Jsonb(r["generation_input"]), data.save_token, essay_id),
        )
        # ERD rule 12: the AI result is cleared once it is saved
        await conn.execute("update ai_requests set result = null where id = %s", (request_id,))
        await _after_save(conn, essay_id, essay["method"])
        return await _essay(conn, essay_id)
