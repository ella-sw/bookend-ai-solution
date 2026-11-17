"""R04 자유롭게 기록하기 (W110 / W111 / W113, H121 이어 쓰기 확인).

Flow for the frontend:
  1. Start free writing → GET /records/free/draft
     200 = a draft exists → ask "이어서 쓰시겠습니까?"; 404 = start empty.
  2. [임시 저장] → POST /records/free/draft (creates or overwrites the one draft;
     send `record_id` when continuing a draft).
  3. [소재로 저장] → POST /records/free with a `save_token` made when W110 opened
     - continuing a draft: send its id as `record_id`, the draft becomes the saved record
     - started fresh ([아니오]): omit `record_id`, the old draft stays until the next [임시 저장]
     - [다시 시도] after a lost response: send the same body; an already saved record
       comes back as 200 instead of being saved twice
  4. [저장하지 않고 나가기] → no API call.
Saved records can never be edited (ERD rule 2, also blocked by a DB trigger).
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field, StringConstraints

from app.db import ConsentedConn

router = APIRouter(prefix="/records", tags=["records"])

MAX_BODY = 20_000  # characters; generous upper bound, not a product rule
MAX_TITLE = 100

Title = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_TITLE)]
Body = Annotated[str, StringConstraints(max_length=MAX_BODY)]

COLUMNS = ("id, type, title, body, status, analysis_status, original_kept_at, "
           "created_at, saved_at, updated_at")


class Record(BaseModel):
    id: UUID
    type: str
    title: str | None
    body: str | None
    status: str
    analysis_status: str
    original_kept_at: datetime | None
    created_at: datetime
    saved_at: datetime | None
    updated_at: datetime


class DraftIn(BaseModel):
    title: Title | None = None
    body: Body = ""  # a draft may be empty
    record_id: UUID | None = Field(
        default=None, description="Id of the draft being continued. Omit for a new draft.")


class SaveIn(BaseModel):
    title: Title | None = None
    body: Body = Field(description="Must contain text; whitespace only is rejected.")
    record_id: UUID | None = Field(
        default=None, description="Id of the free-writing draft being continued, if any.")
    save_token: UUID = Field(
        description="Made once when W110 opens; send the same value on [다시 시도].")


def _clean_title(title: str | None) -> str | None:
    return title or None  # "" → null (title is optional)


@router.get("/free/draft", response_model=Record)
async def get_free_draft(conn: ConsentedConn) -> dict:
    """H121: the caller's free-writing draft. 404 `no_draft` when there is none."""
    row = await (await conn.execute(
        f"select {COLUMNS} from records "
        "where user_id = auth.uid() and type = 'free' and status = 'draft'"
    )).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no_draft")
    return row


@router.post("/free/draft", response_model=Record)
async def save_free_draft(data: DraftIn, conn: ConsentedConn) -> dict:
    """W111 [임시 저장]: create the one draft, or overwrite the previous one.

    Continuing a draft: send its id as `record_id`. If that draft no longer exists
    (e.g. it was saved as a record in another tab), 404 `draft_not_found`.
    """
    if data.record_id is not None:
        row = await (await conn.execute(
            f"""
            update records set title = %s, body = %s
             where id = %s and user_id = auth.uid() and type = 'free' and status = 'draft'
            returning {COLUMNS}
            """,
            (_clean_title(data.title), data.body, data.record_id),
        )).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="draft_not_found")
        return row

    return await (await conn.execute(
        f"""
        insert into records (user_id, type, title, body)
        values (auth.uid(), 'free', %s, %s)
        on conflict (user_id, type) where status = 'draft'
        do update set title = excluded.title, body = excluded.body
        returning {COLUMNS}
        """,
        (_clean_title(data.title), data.body),
    )).fetchone()


@router.post("/free", response_model=Record, status_code=status.HTTP_201_CREATED,
             responses={200: {"description": "Already saved (retry): the saved record"}})
async def save_free_record(data: SaveIn, conn: ConsentedConn, response: Response) -> dict:
    """W110 [소재로 저장]: save the original record. It can't be edited afterwards.

    Safe to retry (e.g. the response was lost on a phone): 201 when saved now,
    200 with the same record when this `save_token` or `record_id` was already saved.
    Material analysis (R28) starts from this saved record; that API comes with C's AI part.
    """
    if not data.body.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="empty_body")
    title = _clean_title(data.title)

    async def already_saved(where: str, value: UUID) -> dict | None:
        return await (await conn.execute(
            f"select {COLUMNS} from records where {where} = %s and user_id = auth.uid() "
            "and type = 'free' and status = 'saved'",
            (value,),
        )).fetchone()

    if (row := await already_saved("save_token", data.save_token)) is not None:
        response.status_code = status.HTTP_200_OK
        return row

    if data.record_id is not None:
        row = await (await conn.execute(
            f"""
            update records
               set title = %s, body = %s, status = 'saved', saved_at = now(), save_token = %s
             where id = %s and user_id = auth.uid() and type = 'free' and status = 'draft'
            returning {COLUMNS}
            """,
            (title, data.body, data.save_token, data.record_id),
        )).fetchone()
        if row is None:
            if (row := await already_saved("id", data.record_id)) is not None:
                response.status_code = status.HTTP_200_OK
                return row
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="draft_not_found")
    else:
        row = await (await conn.execute(
            f"""
            insert into records (user_id, type, title, body, status, saved_at, save_token)
            values (auth.uid(), 'free', %s, %s, 'saved', now(), %s)
            on conflict (user_id, save_token) where save_token is not null do nothing
            returning {COLUMNS}
            """,
            (title, data.body, data.save_token),
        )).fetchone()
        if row is None:  # the same token was saved by a request running at the same time
            response.status_code = status.HTTP_200_OK
            return await already_saved("save_token", data.save_token)

    # R33 ① 기록 저장
    await conn.execute(
        "insert into events (user_id, name, record_id) values (auth.uid(), 'record_saved', %s)",
        (row["id"],),
    )
    return row


@router.get("/{record_id}", response_model=Record)
async def get_record(record_id: UUID, conn: ConsentedConn) -> dict:
    """One of the caller's records (원문 보기). 404 for missing or another user's record."""
    row = await (await conn.execute(
        f"select {COLUMNS} from records where id = %s and user_id = auth.uid()", (record_id,),
    )).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="record_not_found")
    return row
