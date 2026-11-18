"""R33 최소 사용 이벤트: 화면에서만 알 수 있는 이벤트를 받는다.

The server records these itself, so the screen must NOT send them:
  record_saved (기록 저장), material_confirmed (소재 보관 확정), essay_saved (사용자 글 저장)

The screen sends these (POST /events):
  name                 when                                         fields
  record_started       자유 기록·AI 질문 화면 진입                    record_id (이어 쓰기일 때)
  writing_started      직접 쓰기 / AI 초안 시작                       write_mode, entry_path,
                                                                     material_count, suggestion_id?
  suggestion_shown     홈 카드·N130이 보였을 때                       suggestion_id
  suggestion_selected  [이 주제로 글쓰기]                             suggestion_id
  body_shared          [복사] 성공 / 공유창 정상 종료 (취소·실패는 X)   essay_id, share_method

No text of records or essays goes into events.
"""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.db import ConsentedConn

router = APIRouter(tags=["events"])

ClientEvent = Literal["record_started", "writing_started", "suggestion_shown",
                      "suggestion_selected", "body_shared"]

# name → (required fields, allowed optional fields)
RULES: dict[str, tuple[set[str], set[str]]] = {
    "record_started": (set(), {"record_id"}),
    "writing_started": ({"write_mode", "entry_path", "material_count"}, {"suggestion_id"}),
    "suggestion_shown": ({"suggestion_id"}, set()),
    "suggestion_selected": ({"suggestion_id"}, set()),
    "body_shared": ({"essay_id", "share_method"}, set()),
}
FIELDS = ("record_id", "essay_id", "suggestion_id", "write_mode", "material_count",
          "entry_path", "share_method")


class EventIn(BaseModel):
    name: ClientEvent
    record_id: UUID | None = None
    essay_id: UUID | None = None
    suggestion_id: UUID | None = None
    write_mode: Literal["direct", "ai"] | None = None
    material_count: Annotated[int, Field(ge=0, le=100)] | None = None
    entry_path: Literal["home", "materials", "material_detail", "suggestion",
                        "no_material"] | None = None
    share_method: Literal["copy", "share_sheet"] | None = None


def _invalid(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


@router.post("/events", status_code=status.HTTP_204_NO_CONTENT,
             responses={422: {"description": "missing_field / unexpected_field"},
                        404: {"description": "record/essay/suggestion not found"}})
async def record_event(data: EventIn, conn: ConsentedConn) -> Response:
    """R33: record one screen event. Ids must be the caller's own."""
    required, optional = RULES[data.name]
    given = {f for f in FIELDS if getattr(data, f) is not None}
    if missing := required - given:
        raise _invalid(f"missing_field: {', '.join(sorted(missing))}")
    if extra := given - required - optional:
        raise _invalid(f"unexpected_field: {', '.join(sorted(extra))}")

    # Foreign keys are checked without RLS, so check ownership here (R02)
    for field, table in (("record_id", "records"), ("essay_id", "essays"),
                         ("suggestion_id", "suggestions")):
        value = getattr(data, field)
        if value is not None and await (await conn.execute(
                f"select 1 from {table} where id = %s and user_id = auth.uid()",
                (value,))).fetchone() is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"{field.removesuffix('_id')}_not_found")

    await conn.execute(
        f"insert into events (user_id, name, {', '.join(FIELDS)}) "
        f"values (auth.uid(), %s, {', '.join(['%s'] * len(FIELDS))})",
        (data.name, *(getattr(data, f) for f in FIELDS)),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
