"""R27 소재함과 소재 관리 — M110 소재함, M120 보관, M130 소재 상세, M131 더보기, M132 기록 삭제.

Screen flow:
  M120 [소재함에 보관]   POST /records/{id}/material  (AI 후보를 고친 값과 함께) → 보관 확정
  M120 [직접 정리하기]   POST /records/{id}/material  (후보가 없으면 직접 쓴 값으로 새 소재)
  M110 소재함            GET  /materials
  N110 관련 소재 추천    GET  /materials/related?selected=…  (R29, AI 없이 주제·키워드로)
  M130 소재 상세         GET  /materials/{id}
  M131 소재 정보 고치기   PATCH /materials/{id}  (요약·키워드·주제만)
  M131 다시 분석         POST /materials/{id}/reanalyze → GET /materials/{id} 의 `reanalysis`
                          [바꾸기] POST /materials/{id}/reanalysis/apply
                          [그대로 두기] POST /materials/{id}/reanalysis/dismiss
  M131 소재 삭제         DELETE /materials/{id}  (논리 삭제; 원본 기록은 남음)
  M130 보관한 원본        GET  /records/{id}/original (원문) + GET /records/{id}/analysis (버튼)
  M132 기록 삭제         DELETE /records/{id}  (보관 확정한 소재가 없는 원본만)

'보관 확정' = materials.confirmed_at (ERD rule 8). Only confirmed, not deleted materials
count for 고르기·추천·제안·사용 횟수.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response, status
from psycopg import AsyncConnection
from pydantic import BaseModel, Field, StringConstraints

from app.ai import MaterialAI, SuggestAI, get_material_ai, get_suggest_ai
from app.analysis import expire_if_stale, run_analysis, set_topics, start_analysis
from app.auth import CurrentUser, current_user
from app.db import require_consent, user_tx
from app.routers.analysis import Topic
from app.suggestions import recompute_topics

router = APIRouter(tags=["materials"])

User = Annotated[CurrentUser, Depends(current_user)]
AI = Annotated[MaterialAI, Depends(get_material_ai)]
SuggestAIDep = Annotated[SuggestAI, Depends(get_suggest_ai)]

PREVIEW = 80  # characters of the original shown on a card
Summary = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, max_length=50)]
Keyword = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=30)]
TopicIds = Annotated[list[int], Field(min_length=1, max_length=10,
                                      description="Topic ids (1–10); one or more")]

# text shown on cards: free writing body, or the Q&A answers
_PREVIEW_SQL = f"""left(coalesce(nullif(r.body, ''),
    (select string_agg(q.answer, ' ' order by q.seq) from qna_messages q
      where q.record_id = r.id and q.answer is not null), ''), {PREVIEW})"""

_TOPICS_SQL = """coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name)
                                    order by t.sort_order)
                            from material_topics mt join topics t on t.id = mt.topic_id
                           where mt.material_id = m.id), '[]')"""


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class RecordCard(BaseModel):
    record_id: UUID
    record_type: str  # free / qna
    title: str | None
    preview: str
    status: str  # draft / saved
    analysis_status: str
    # 확인 대기 card label: analyzing / to_confirm / empty / failed
    # 원본만 보관 badge: analyzing / to_confirm / null
    label: str | None
    date: datetime  # saved_at (saved) or updated_at (draft)


class MaterialCard(BaseModel):
    id: UUID
    record_id: UUID
    title: str | None
    summary: str | None
    topics: list[Topic]
    created_at: datetime
    essay_count: int  # '글 N편에 사용'


class RelatedMaterial(MaterialCard):
    shared_topics: list[str]  # 고른 소재와 같은 주제 ('같은 주제: 가족')
    shared_keywords: list[str]  # 고른 소재와 같은 키워드


class MaterialBox(BaseModel):
    pending: list[RecordCard]  # 확인 대기 (맨 위)
    drafts: list[RecordCard]  # 임시 저장 기록 (맨 위)
    materials: list[MaterialCard]  # 보관한 소재 (최근 순). 주제 칩은 topics로 거른다
    kept_originals: list[RecordCard]  # 원본만 보관한 기록 (맨 아래 접힌 구역)


class Message(BaseModel):
    seq: int
    question: str
    answer: str


class Original(BaseModel):
    record_id: UUID
    record_type: str
    title: str | None
    body: str | None  # free writing
    messages: list[Message]  # Q&A (answered pairs)
    saved_at: datetime | None


class EssayRef(BaseModel):
    id: UUID
    title: str | None


class Candidate(BaseModel):
    title: str | None
    summary: str
    evidence: str
    keywords: list[str]
    topics: list[Topic]


class Reanalysis(BaseModel):
    status: str  # analyzing / done / empty / failed
    result: Candidate | None  # done: shown next to the current material


class MaterialDetail(BaseModel):
    id: UUID
    title: str | None
    summary: str | None
    evidence: str | None
    keywords: list[str]
    topics: list[Topic]
    origin: str
    confirmed_at: datetime
    user_edited_at: datetime | None
    created_at: datetime
    original: Original
    essays: list[EssayRef]  # 사용한 글
    reanalysis: Reanalysis | None  # M131 다시 분석 진행·결과 (없으면 null)


class ConfirmIn(BaseModel):
    title: Title | None = None
    summary: Summary
    keywords: list[Keyword] = Field(default_factory=list, max_length=10)
    topics: TopicIds


class EditIn(BaseModel):
    """M131 소재 정보 고치기: 요약·키워드·주제만. Send only what changed."""
    summary: Summary | None = None
    keywords: list[Keyword] | None = Field(default=None, max_length=10)
    topics: TopicIds | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _not_found(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail=detail)


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, detail=detail)


async def _topics_of(conn: AsyncConnection, material_id: UUID) -> set[int]:
    rows = await (await conn.execute(
        "select topic_id from material_topics where material_id = %s", (material_id,),
    )).fetchall()
    return {r["topic_id"] for r in rows}


def _recompute(background: BackgroundTasks, user_id: UUID, topics: set[int],
               ai: SuggestAI) -> None:
    """R30: after this request commits, recompute the suggestions of these topics."""
    if topics:
        background.add_task(recompute_topics, user_id, topics, ai)


def _dedupe(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


async def _check_topics(conn: AsyncConnection, topic_ids: list[int]) -> list[int]:
    ids = sorted(set(topic_ids))
    found = await (await conn.execute(
        "select count(*) n from topics where id = any(%s)", (ids,))).fetchone()
    if found["n"] != len(ids):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="unknown_topic")
    return ids


async def _live_material(conn: AsyncConnection, material_id: UUID, lock: bool = False) -> dict:
    row = await (await conn.execute(
        "select id, record_id, summary, keywords from materials "
        "where id = %s and user_id = auth.uid() and confirmed_at is not null "
        "and deleted_at is null" + (" for update" if lock else ""),
        (material_id,),
    )).fetchone()
    if row is None:
        raise _not_found("material_not_found")
    return row


async def _original(conn: AsyncConnection, record_id: UUID) -> Original:
    rec = await (await conn.execute(
        "select id, type, title, body, saved_at from records "
        "where id = %s and user_id = auth.uid() and status = 'saved'",
        (record_id,),
    )).fetchone()
    if rec is None:
        raise _not_found("record_not_found")
    msgs = await (await conn.execute(
        "select seq, question, answer from qna_messages "
        "where record_id = %s and not is_replaced and answer is not null order by seq",
        (record_id,),
    )).fetchall()
    return Original(record_id=rec["id"], record_type=rec["type"], title=rec["title"],
                    body=rec["body"], messages=[Message(**m) for m in msgs],
                    saved_at=rec["saved_at"])


async def _reanalysis(conn: AsyncConnection, record_id: UUID,
                      confirmed_at: datetime) -> Reanalysis | None:
    """The latest analysis started after the material was confirmed, until decided."""
    row = await (await conn.execute(
        "select a.status, a.result from records r "
        "join ai_requests a on a.id = r.latest_analysis_request_id "
        "where r.id = %s and a.started_at > %s",
        (record_id, confirmed_at),
    )).fetchone()
    if row is None:
        return None
    result = row["result"]
    if row["status"] == "running":
        return Reanalysis(status="analyzing", result=None)
    if row["status"] in ("failed", "timeout") and not (result or {}).get("dismissed"):
        return Reanalysis(status="failed", result=None)
    if row["status"] == "ok" and result is not None and "material" in result:
        m = result["material"]
        if m is None:
            return Reanalysis(status="empty", result=None)
        names = await (await conn.execute(
            "select id, name from topics where id = any(%s) order by sort_order",
            (m["topics"],))).fetchall()
        return Reanalysis(status="done", result=Candidate(
            title=m["title"], summary=m["summary"], evidence=m["evidence"],
            keywords=m["keywords"], topics=[Topic(**t) for t in names]))
    return None


async def _detail(conn: AsyncConnection, material_id: UUID) -> MaterialDetail:
    m = await (await conn.execute(
        f"""
        select m.id, m.record_id, m.title, m.summary, m.evidence, m.keywords, m.origin,
               m.confirmed_at, m.user_edited_at, m.created_at, {_TOPICS_SQL} as topics
          from materials m
         where m.id = %s and m.user_id = auth.uid()
           and m.confirmed_at is not null and m.deleted_at is null
        """,
        (material_id,),
    )).fetchone()
    if m is None:
        raise _not_found("material_not_found")
    await expire_if_stale(conn, m["record_id"])
    essays = await (await conn.execute(
        "select e.id, e.title from essay_materials em join essays e on e.id = em.essay_id "
        "where em.material_id = %s order by e.updated_at desc",
        (material_id,),
    )).fetchall()
    return MaterialDetail(
        **{k: v for k, v in m.items() if k != "record_id"},
        original=await _original(conn, m["record_id"]),
        essays=[EssayRef(**e) for e in essays],
        reanalysis=await _reanalysis(conn, m["record_id"], m["confirmed_at"]),
    )


# ---------------------------------------------------------------------------
# M120 [소재함에 보관] / [직접 정리하기]
# ---------------------------------------------------------------------------
@router.post("/records/{record_id}/material", response_model=MaterialDetail,
             status_code=status.HTTP_201_CREATED,
             responses={200: {"description": "Already confirmed (retry): the material"}})
async def confirm_material(record_id: UUID, data: ConfirmIn, user: User, response: Response,
                           background: BackgroundTasks, suggest_ai: SuggestAIDep
                           ) -> MaterialDetail:
    """[소재함에 보관]: 보관 확정. AI 후보가 있으면 고친 값으로 확정하고, 없으면
    ([직접 정리하기]) 직접 쓴 값으로 새 소재(origin = manual)를 만든다.

    Safe to retry: already confirmed → 200 with the material, unchanged.
    409 `material_deleted` if this record's material was deleted.
    """
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        rec = await (await conn.execute(
            "select id from records where id = %s and user_id = auth.uid() "
            "and status = 'saved' for update",
            (record_id,),
        )).fetchone()
        if rec is None:
            raise _not_found("record_not_found")
        topics = await _check_topics(conn, data.topics)
        keywords = _dedupe(data.keywords)
        title = data.title or None

        mat = await (await conn.execute(
            "select id, title, summary, keywords, confirmed_at, deleted_at from materials "
            "where record_id = %s for update",
            (record_id,),
        )).fetchone()
        if mat is not None and mat["deleted_at"] is not None:
            raise _conflict("material_deleted")
        if mat is not None and mat["confirmed_at"] is not None:
            response.status_code = status.HTTP_200_OK
            return await _detail(conn, mat["id"])

        if mat is None:  # [직접 정리하기]
            mat = await (await conn.execute(
                "insert into materials (user_id, record_id, title, summary, keywords, origin, "
                "confirmed_at) values (auth.uid(), %s, %s, %s, %s, 'manual', now()) "
                "returning id",
                (record_id, title, data.summary, keywords),
            )).fetchone()
        else:  # AI 후보를 (고쳐서) 보관
            row = await (await conn.execute(
                "select array_agg(topic_id order by topic_id) t from material_topics "
                "where material_id = %s", (mat["id"],))).fetchone()
            old_topics = row["t"] or []
            edited = (title != mat["title"] or data.summary != mat["summary"]
                      or keywords != mat["keywords"] or topics != old_topics)
            await conn.execute(
                "update materials set title = %s, summary = %s, keywords = %s, "
                "confirmed_at = now(), user_edited_at = case when %s then now() end "
                "where id = %s",
                (title, data.summary, keywords, edited, mat["id"]),
            )
        await set_topics(conn, mat["id"], topics)
        # R33 ② 소재 보관 확정
        await conn.execute(
            "insert into events (user_id, name, record_id) "
            "values (auth.uid(), 'material_confirmed', %s)",
            (record_id,),
        )
        detail = await _detail(conn, mat["id"])
    _recompute(background, user.id, set(topics), suggest_ai)  # R30
    return detail


# ---------------------------------------------------------------------------
# M110 소재함
# ---------------------------------------------------------------------------
@router.get("/materials", response_model=MaterialBox)
async def material_box(user: User) -> MaterialBox:
    """M110: 확인 대기 · 임시 저장 기록 · 보관한 소재 · 원본만 보관한 기록 (ERD rules 4, 5)."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        has_candidate = ("exists (select 1 from materials c where c.record_id = r.id "
                         "and c.confirmed_at is null)")
        no_confirmed = ("not exists (select 1 from materials c where c.record_id = r.id "
                        "and c.confirmed_at is not null)")
        cols = (f"r.id as record_id, r.type as record_type, r.title, {_PREVIEW_SQL} as preview, "
                "r.status, r.analysis_status")

        pending = await (await conn.execute(
            f"""
            select {cols}, r.saved_at as date,
                   case when r.analysis_status = 'analyzing' then 'analyzing'
                        when {has_candidate} then 'to_confirm'
                        when r.analysis_status = 'empty' then 'empty'
                        else 'failed' end as label
              from records r
             where r.user_id = auth.uid() and r.status = 'saved' and r.original_kept_at is null
               and r.analysis_status in ('analyzing', 'done', 'empty', 'failed')
               and {no_confirmed}
             order by r.saved_at desc
            """
        )).fetchall()
        drafts = await (await conn.execute(
            f"""
            select {cols}, r.updated_at as date, null as label
              from records r
             where r.user_id = auth.uid() and r.status = 'draft'
             order by r.updated_at desc
            """
        )).fetchall()
        kept = await (await conn.execute(
            f"""
            select {cols}, r.saved_at as date,
                   case when r.analysis_status = 'analyzing' then 'analyzing'
                        when {has_candidate} then 'to_confirm' end as label
              from records r
             where r.user_id = auth.uid() and r.status = 'saved'
               and r.original_kept_at is not null and {no_confirmed}
             order by r.original_kept_at desc
            """
        )).fetchall()
        materials = await (await conn.execute(
            f"""
            select m.id, m.record_id, m.title, m.summary, m.created_at, {_TOPICS_SQL} as topics,
                   (select count(*) from essay_materials em where em.material_id = m.id)
                     as essay_count
              from materials m
             where m.user_id = auth.uid() and m.confirmed_at is not null and m.deleted_at is null
             order by m.created_at desc
            """
        )).fetchall()
    return MaterialBox(
        pending=[RecordCard(**r) for r in pending],
        drafts=[RecordCard(**r) for r in drafts],
        materials=[MaterialCard(**m) for m in materials],
        kept_originals=[RecordCard(**r) for r in kept],
    )


# ---------------------------------------------------------------------------
# N110 관련 소재 추천 (R29)
# ---------------------------------------------------------------------------
KEYWORD_WEIGHT = 2  # a shared keyword is more specific than one of the 10 topics
TOPIC_WEIGHT = 1


@router.get("/materials/related", response_model=list[RelatedMaterial])
async def related_materials(
    user: User,
    selected: Annotated[list[UUID], Query(max_length=20, description="고른 소재 id")] = [],  # noqa: B006
    limit: Annotated[int, Query(ge=1, le=20)] = 5,
) -> list[RelatedMaterial]:
    """N110 '함께 쓰면 좋은 소재': 고른 소재와 주제나 키워드가 같은 보관 확정 소재.

    No AI call. Score = 2 × shared keywords + 1 × shared topics (keywords compared without
    case and surrounding spaces); ties → newest first; at most 5 by default.
    Criteria confirmed by 유진 (분석가) on 2026-11-18. Known limit, to be noted in the
    quality review: exact keyword match misses similar words ("엄마" vs "어머니"). Selected, deleted and unconfirmed
    materials are left out. Nothing selected → []. 404 if a selected id is not the
    caller's usable material.
    """
    if not selected:
        return []
    ids = list(dict.fromkeys(selected))
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        n = await (await conn.execute(
            "select count(*) n from materials where id = any(%s) and user_id = auth.uid() "
            "and confirmed_at is not null and deleted_at is null", (ids,))).fetchone()
        if n["n"] != len(ids):
            raise _not_found("material_not_found")
        rows = await (await conn.execute(
            f"""
            with sel_topics as (
              select distinct topic_id from material_topics where material_id = any(%(ids)s)
            ), sel_keywords as (
              select distinct lower(btrim(k)) as k
                from materials, unnest(keywords) as k where id = any(%(ids)s)
            ), cand as (
              select m.*,
                     array(select t.name from material_topics mt join topics t on t.id = mt.topic_id
                            where mt.material_id = m.id
                              and mt.topic_id in (select topic_id from sel_topics)
                            order by t.sort_order) as shared_topics,
                     array(select k from unnest(m.keywords) as k
                            where lower(btrim(k)) in (select k from sel_keywords)) as shared_keywords
                from materials m
               where m.user_id = auth.uid() and m.confirmed_at is not null
                 and m.deleted_at is null and m.id <> all(%(ids)s)
            )
            select c.id, c.record_id, c.title, c.summary, c.created_at, c.shared_topics,
                   c.shared_keywords, {_TOPICS_SQL.replace("m.id", "c.id")} as topics,
                   (select count(*) from essay_materials em where em.material_id = c.id)
                     as essay_count
              from cand c
             where cardinality(c.shared_topics) > 0 or cardinality(c.shared_keywords) > 0
             order by {KEYWORD_WEIGHT} * cardinality(c.shared_keywords)
                      + {TOPIC_WEIGHT} * cardinality(c.shared_topics) desc,
                      c.created_at desc
             limit %(limit)s
            """,
            {"ids": ids, "limit": limit},
        )).fetchall()
    return [RelatedMaterial(**r) for r in rows]


# ---------------------------------------------------------------------------
# M130 / M131
# ---------------------------------------------------------------------------
@router.get("/materials/{material_id}", response_model=MaterialDetail)
async def material_detail(material_id: UUID, user: User) -> MaterialDetail:
    """M130 소재 상세: 소재 정보, 원문(읽기 전용), 사용한 글, 다시 분석 진행·결과."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        return await _detail(conn, material_id)


@router.patch("/materials/{material_id}", response_model=MaterialDetail)
async def edit_material(material_id: UUID, data: EditIn, user: User,
                        background: BackgroundTasks, suggest_ai: SuggestAIDep) -> MaterialDetail:
    """M131 소재 정보 고치기: 요약·키워드·주제만 (원본은 그대로).
    R30: suggestions of the old and the new topics are recomputed."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        await _live_material(conn, material_id, lock=True)
        before = await _topics_of(conn, material_id)
        if data.summary is not None:
            await conn.execute("update materials set summary = %s where id = %s",
                               (data.summary, material_id))
        if data.keywords is not None:
            await conn.execute("update materials set keywords = %s where id = %s",
                               (_dedupe(data.keywords), material_id))
        if data.topics is not None:
            await set_topics(conn, material_id, await _check_topics(conn, data.topics))
        if data.model_fields_set & {"summary", "keywords", "topics"}:
            await conn.execute("update materials set user_edited_at = now() where id = %s",
                               (material_id,))
        topics = before | await _topics_of(conn, material_id)
        detail = await _detail(conn, material_id)
    _recompute(background, user.id, topics, suggest_ai)
    return detail


@router.post("/materials/{material_id}/reanalyze", response_model=MaterialDetail,
             status_code=status.HTTP_202_ACCEPTED,
             responses={200: {"description": "Already analyzing: nothing new started"}})
async def reanalyze_material(material_id: UUID, user: User, ai: AI,
                             background: BackgroundTasks, response: Response) -> MaterialDetail:
    """M131 다시 분석: 같은 원본으로 다시 추출. 결과는 소재를 바꾸지 않고 `reanalysis`에
    나란히 보여 준다 → [바꾸기] / [그대로 두기]."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        mat = await _live_material(conn, material_id)
        await expire_if_stale(conn, mat["record_id"])
        request_id = await start_analysis(conn, mat["record_id"])
        if request_id is None:
            response.status_code = status.HTTP_200_OK
        detail = await _detail(conn, material_id)
    if request_id is not None:
        background.add_task(run_analysis, user.id, mat["record_id"], request_id, ai)
    return detail


async def _latest_result(conn: AsyncConnection, record_id: UUID) -> dict | None:
    return await (await conn.execute(
        "select a.id, a.status, a.result from records r "
        "join ai_requests a on a.id = r.latest_analysis_request_id where r.id = %s for update",
        (record_id,),
    )).fetchone()


@router.post("/materials/{material_id}/reanalysis/apply", response_model=MaterialDetail)
async def apply_reanalysis(material_id: UUID, user: User, background: BackgroundTasks,
                           suggest_ai: SuggestAIDep) -> MaterialDetail:
    """[바꾸기]: 다시 분석한 결과로 소재 정보를 바꾼다. 409 `no_result` if there is none.
    R30: suggestions of the old and the new topics are recomputed."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        mat = await _live_material(conn, material_id, lock=True)
        before = await _topics_of(conn, material_id)
        req = await _latest_result(conn, mat["record_id"])
        m = (req or {}).get("result") or {}
        if req is None or req["status"] != "ok" or not m.get("material"):
            raise _conflict("no_result")
        m = m["material"]
        await conn.execute(
            "update materials set title = %s, summary = %s, evidence = %s, keywords = %s, "
            "origin = 'ai' where id = %s",
            (m["title"], m["summary"], m["evidence"], m["keywords"], material_id),
        )
        await set_topics(conn, material_id, m["topics"])
        # ERD rule 12: the AI result is cleared once it is saved
        await conn.execute("update ai_requests set result = null where id = %s", (req["id"],))
        topics = before | await _topics_of(conn, material_id)
        detail = await _detail(conn, material_id)
    _recompute(background, user.id, topics, suggest_ai)
    return detail


@router.post("/materials/{material_id}/reanalysis/dismiss", response_model=MaterialDetail)
async def dismiss_reanalysis(material_id: UUID, user: User) -> MaterialDetail:
    """[그대로 두기] (or closing the 소재 없음·실패 notice): keep the material as it is."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        mat = await _live_material(conn, material_id, lock=True)
        req = await _latest_result(conn, mat["record_id"])
        if req is not None and req["status"] != "running":
            await conn.execute(
                "update ai_requests set result = '{\"dismissed\": true}' where id = %s",
                (req["id"],))
        return await _detail(conn, material_id)


@router.delete("/materials/{material_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_material(material_id: UUID, user: User, background: BackgroundTasks,
                          suggest_ai: SuggestAIDep) -> Response:
    """M131 소재 삭제: 논리 삭제 (ERD rule 7). 원본 기록과 이미 쓴 글은 남고, 글에는
    '삭제된 소재'로 표시된다. 새 제안·새 글·다시 만들기에는 쓰지 않는다."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        await _live_material(conn, material_id, lock=True)
        topics = await _topics_of(conn, material_id)
        await conn.execute("update materials set deleted_at = now() where id = %s",
                           (material_id,))
    _recompute(background, user.id, topics, suggest_ai)  # R30: its topics lose a material
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# M130 보관한 원본, M132 기록 삭제
# ---------------------------------------------------------------------------
@router.get("/records/{record_id}/original", response_model=Original)
async def get_original(record_id: UUID, user: User) -> Original:
    """원문 (읽기 전용): 자유 기록 본문 또는 문답 (답한 질문만)."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        return await _original(conn, record_id)


@router.delete("/records/{record_id}", status_code=status.HTTP_204_NO_CONTENT,
               responses={409: {"description": "material_confirmed / material_deleted"}})
async def delete_record(record_id: UUID, user: User) -> Response:
    """M132 기록 삭제 (ERD rule 6): 보관 확정한 소재가 없는 저장된 원본만 실제로 지운다.
    문답·확정 전 소재·관련 AI 요청도 지우고, 이벤트의 record_id는 비운다.

    팀 결정 (11/18): 소재 없음·실패로 남은 원본은 지울 수 있다. 소재를 삭제한 원본은
    목록에 보이지 않고 개별 삭제도 안 된다 (409 `material_deleted`); [모든 기록 지우기]나
    1달 자동 정리로만 지워진다."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        rec = await (await conn.execute(
            "select id from records where id = %s and user_id = auth.uid() "
            "and status = 'saved' for update",
            (record_id,),
        )).fetchone()
        if rec is None:
            raise _not_found("record_not_found")
        confirmed = await (await conn.execute(
            "select deleted_at from materials where record_id = %s and confirmed_at is not null",
            (record_id,),
        )).fetchone()
        if confirmed is not None:
            raise _conflict("material_deleted" if confirmed["deleted_at"] else
                            "material_confirmed")
        await conn.execute(
            "delete from ai_requests where target_type = 'record' and target_id = %s",
            (record_id,))
        await conn.execute("delete from records where id = %s", (record_id,))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
