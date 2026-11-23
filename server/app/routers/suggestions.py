"""R30 글쓰기 제안 — H110 홈 카드, N130 제안 상세.

  홈            GET /suggestions        → computing (= '소재를 정리하고 있어요') + 제안 카드
  N130          GET /suggestions/{id}   → 제목·주제·방향·이유·사용할 소재
  [이 주제로 글쓰기] → N120 with `direction` and the materials prefilled; the screen sends
                      suggestion_selected (R33) and writing_started with suggestion_id.
  [소재 바꾸기]   → N110 with the suggestion's materials selected.
  [닫기]          → no API call ('다시 보지 않기' 없음).

Only `ready` suggestions are shown; none / failed / computing → no card (요구사항 R30).
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from psycopg import AsyncConnection
from pydantic import BaseModel

from app.auth import CurrentUser, current_user
from app.db import require_consent, user_tx
from app.routers.analysis import Topic
from app.suggestions import expire_stale

router = APIRouter(prefix="/suggestions", tags=["suggestions"])

User = Annotated[CurrentUser, Depends(current_user)]


class SuggestionMaterial(BaseModel):
    id: UUID
    title: str | None
    summary: str | None


class Suggestion(BaseModel):
    id: UUID
    topic: Topic
    title: str
    direction: str
    reason: str
    materials: list[SuggestionMaterial]  # 사용할 소재, 순서대로
    computed_at: datetime


class SuggestionList(BaseModel):
    computing: bool  # 홈 '소재를 정리하고 있어요'
    suggestions: list[Suggestion]  # 최근에 만든 순


_SQL = """
select s.id, s.title, s.direction, s.reason, s.computed_at,
       json_build_object('id', t.id, 'name', t.name) as topic,
       coalesce((select json_agg(json_build_object('id', m.id, 'title', m.title,
                                                   'summary', m.summary) order by sm.seq)
                   from suggestion_materials sm join materials m on m.id = sm.material_id
                  where sm.suggestion_id = s.id), '[]') as materials
  from suggestions s join topics t on t.id = s.topic_id
 where s.user_id = auth.uid() and s.status = 'ready'
"""


async def _list(conn: AsyncConnection) -> list[Suggestion]:
    rows = await (await conn.execute(_SQL + " order by s.computed_at desc")).fetchall()
    return [Suggestion(**r) for r in rows]


@router.get("", response_model=SuggestionList)
async def list_suggestions(user: User) -> SuggestionList:
    """H110 홈: 만들어진 제안 카드. 하나라도 계산 중이면 computing = true."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        await expire_stale(conn)
        computing = await (await conn.execute(
            "select exists (select 1 from suggestions where user_id = auth.uid() "
            "and status = 'computing') as c")).fetchone()
        return SuggestionList(computing=computing["c"], suggestions=await _list(conn))


@router.get("/{suggestion_id}", response_model=Suggestion)
async def get_suggestion(suggestion_id: UUID, user: User) -> Suggestion:
    """N130 제안 상세. 없거나 아직 준비되지 않았으면 404 `suggestion_not_found`."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        row = await (await conn.execute(_SQL + " and s.id = %s", (suggestion_id,))).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="suggestion_not_found")
    return Suggestion(**row)
