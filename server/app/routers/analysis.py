"""R28 소재 분석 — 소재 확인 (M120), 보관한 원본 (M130).

Screen flow:
  [소재로 저장]          POST /records/free or POST /qna/{id}/save
                         → analysis starts by itself (analysis_status = analyzing)
  M120 loading          GET /records/{id}/analysis  (poll every 2–3 seconds while analyzing)
    done                → candidate `material` (요약·키워드·주제·근거) → R27 [소재함에 보관]
    empty  (소재 없음)   → [직접 정리하기] / [새 대화 시작하기]·[새로 기록하기] / [원본만 보관]
    failed (분석 실패)   → [다시 분석] / [직접 정리하기] / [원본만 보관]
  [다시 분석]           POST /records/{id}/analysis  (only when failed)
  [원본만 보관]          POST /records/{id}/keep-original
  [새 대화 시작하기]/[새로 기록하기] also call keep-original first (ERD rule 5).

Closing the screen does not stop the analysis; GET shows the current state later.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from psycopg import AsyncConnection
from pydantic import BaseModel

from app.ai import MaterialAI, get_material_ai
from app.analysis import expire_if_stale, run_analysis, start_analysis
from app.auth import CurrentUser, current_user
from app.db import require_consent, user_tx

router = APIRouter(prefix="/records", tags=["analysis"])

User = Annotated[CurrentUser, Depends(current_user)]
AI = Annotated[MaterialAI, Depends(get_material_ai)]


class Topic(BaseModel):
    id: int
    name: str


class Material(BaseModel):
    id: UUID
    title: str | None
    summary: str | None
    evidence: str | None
    keywords: list[str]
    topics: list[Topic]
    origin: str  # ai / manual
    confirmed_at: datetime | None  # null = 후보 (보관 전)


class AnalysisState(BaseModel):
    record_id: UUID
    record_type: str  # free → [새로 기록하기], qna → [새 대화 시작하기]
    analysis_status: str  # none / analyzing / done / empty / failed
    original_kept_at: datetime | None
    can_reanalyze: bool  # show [다시 분석]
    material: Material | None


async def _state(conn: AsyncConnection, record_id: UUID) -> AnalysisState:
    rec = await (await conn.execute(
        "select id, type, analysis_status, original_kept_at from records "
        "where id = %s and user_id = auth.uid() and status = 'saved'",
        (record_id,),
    )).fetchone()
    if rec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="record_not_found")
    mat = await (await conn.execute(
        """
        select m.id, m.title, m.summary, m.evidence, m.keywords, m.origin, m.confirmed_at,
               coalesce(json_agg(json_build_object('id', t.id, 'name', t.name)
                                 order by t.sort_order) filter (where t.id is not null),
                        '[]') as topics
          from materials m
          left join material_topics mt on mt.material_id = m.id
          left join topics t on t.id = mt.topic_id
         where m.record_id = %s and m.deleted_at is null
         group by m.id
        """,
        (record_id,),
    )).fetchone()
    return AnalysisState(
        record_id=rec["id"],
        record_type=rec["type"],
        analysis_status=rec["analysis_status"],
        original_kept_at=rec["original_kept_at"],
        can_reanalyze=rec["analysis_status"] in ("failed", "none"),
        material=Material(**mat) if mat else None,
    )


@router.get("/{record_id}/analysis", response_model=AnalysisState)
async def get_analysis(record_id: UUID, user: User) -> AnalysisState:
    """M120: analysis state and the material candidate. 404 for a draft or another
    user's record. An analysis running over 60 seconds turns into 'failed' here."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        await expire_if_stale(conn, record_id)
        return await _state(conn, record_id)


@router.post("/{record_id}/analysis", response_model=AnalysisState,
             status_code=status.HTTP_202_ACCEPTED,
             responses={200: {"description": "Already analyzing: nothing new started"},
                        409: {"description": "cannot_reanalyze (done or empty)"}})
async def reanalyze(record_id: UUID, user: User, ai: AI, background: BackgroundTasks,
                    response: Response) -> AnalysisState:
    """[다시 분석]: only after a failure (소재 없음 has no [다시 분석]: same text, same
    result). While an analysis is running, no new request is made (200)."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        await expire_if_stale(conn, record_id)
        state = await _state(conn, record_id)
        if state.analysis_status == "analyzing":
            response.status_code = status.HTTP_200_OK
            return state
        if not state.can_reanalyze:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="cannot_reanalyze")
        deleted = await (await conn.execute(
            "select 1 from materials where record_id = %s and deleted_at is not null",
            (record_id,))).fetchone()
        if deleted is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="material_deleted")
        request_id = await start_analysis(conn, record_id)
        state = await _state(conn, record_id)
    if request_id is not None:
        background.add_task(run_analysis, user.id, record_id, request_id, ai)
    return state


@router.post("/{record_id}/keep-original", response_model=AnalysisState)
async def keep_original(record_id: UUID, user: User) -> AnalysisState:
    """[원본만 보관] (also before [새 대화 시작하기]/[새로 기록하기]): the record moves to
    '원본만 보관한 기록' at the bottom of the 소재함. Safe to call twice.
    409 `material_confirmed` when its material is already in the 소재함."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        state = await _state(conn, record_id)
        if state.material is not None and state.material.confirmed_at is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="material_confirmed")
        await conn.execute(
            "update records set original_kept_at = coalesce(original_kept_at, now()) "
            "where id = %s",
            (record_id,),
        )
        return await _state(conn, record_id)
