"""R07 직접 쓰기 · R08 버전 저장 · R10 내 서재 (N140, L110, L120, L121, L122).

Screen flow:
  N140 enter          GET  /essays/draft → H121 "이어서 쓰시겠습니까?" (404 = start empty)
  [임시 저장]         POST /essays/draft  (one per user; send `essay_id` when continuing)
  [저장] (첫 저장)     POST /essays        → v1, then L120
  L110 내 서재         GET  /essays        (임시 저장 맨 위, 나머지 최근 수정 순)
  L120 글 상세         GET  /essays/{id}   (버전들, 사용한 소재; 처음엔 가장 최근 버전)
  L122 덮어쓰기        PUT  /essays/{id}/versions/{version_id}
  L122 새 버전 저장    POST /essays/{id}/versions → 다음 번호
  L121 글 삭제         DELETE /essays/{id}

Rules (ERD 1, 7, 12, 13, 16):
- Direct writing has no 초안: the first save is v1. AI essays (coming with C's part) start
  with 초안 = version 0.
- Saving twice with the same `save_token` makes one version (retry-safe).
- Overwriting changes the viewed version in place; the old text is not kept.
- essays.title is a copy of the latest version's title.
- Deleted or unconfirmed materials can't be used for a new essay.
- essay_saved (R33) is recorded for first save, new version and overwrite.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status
from psycopg import AsyncConnection
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, Field, StringConstraints

from app.db import ConsentedConn

router = APIRouter(prefix="/essays", tags=["essays"])

MAX_BODY = 20_000
Title = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
Body = Annotated[str, StringConstraints(max_length=MAX_BODY)]
Direction = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
MaterialIds = Annotated[list[UUID], Field(max_length=20,
                                          description="고른 소재 id, 고른 순서대로")]


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class DraftIn(BaseModel):
    essay_id: UUID | None = Field(default=None, description="이어 쓰는 임시 저장 id")
    title: Title | None = None
    body: Body = ""
    direction: Direction | None = None
    material_ids: MaterialIds = Field(default_factory=list)
    suggestion_id: UUID | None = None


class FirstSaveIn(DraftIn):
    save_token: UUID = Field(description="N140을 열 때 한 번 만들고, [다시 시도]에도 같은 값")


class VersionIn(BaseModel):
    title: Title | None = None
    body: Body


class NewVersionIn(VersionIn):
    based_on_version_id: UUID = Field(description="고치기 시작한 (보고 있던) 버전")
    save_token: UUID = Field(description="[완료]를 누를 때 한 번 만들고, [다시 시도]에도 같은 값")


class MaterialRef(BaseModel):
    id: UUID
    title: str | None
    summary: str | None
    deleted: bool  # '삭제된 소재' (누를 수 없음)


class Draft(BaseModel):
    id: UUID
    title: str | None
    body: str
    direction: str | None
    materials: list[MaterialRef]
    suggestion_id: UUID | None
    updated_at: datetime


LENGTHS = {"short": (300, 500), "long": (1000, 1500)}  # 단문 / 장문, 본문 글자 수


def in_length_range(length: str | None, char_count: int) -> bool | None:
    """AI 글이 고른 길이 범위 안인지. 직접 쓴 글(length 없음)은 None."""
    if length not in LENGTHS:
        return None
    lo, hi = LENGTHS[length]
    return lo <= char_count <= hi


class Version(BaseModel):
    id: UUID
    version_no: int
    label: str  # 초안 / v1 / v2 …
    kind: str  # direct_first / direct_new / ai_first / ai_regen
    title: str | None
    body: str
    char_count: int  # 본문만, 공백 포함, 제목 제외
    style: str | None  # 감성적 / 담백함 (AI일 때)
    length: str | None  # short / long (AI일 때)
    in_length_range: bool | None  # 범위 밖이면 false → 실제 글자 수를 보여 줌
    regen_count: int  # 몇 번째로 다시 만든 글인지 (0 = 다시 만들기 아님)
    created_at: datetime
    updated_at: datetime


class Essay(BaseModel):
    id: UUID
    method: str  # direct / ai
    title: str | None
    direction: str | None
    created_at: datetime
    updated_at: datetime
    materials: list[MaterialRef]
    versions: list[Version]  # 초안 → v1 → v2 … (마지막이 가장 최근)


class EssayCard(BaseModel):
    id: UUID
    title: str | None
    method: str
    state: str  # 임시 저장 / 초안 / v2 …
    is_draft: bool
    updated_at: datetime
    material_count: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _label(version_no: int) -> str:
    return "초안" if version_no == 0 else f"v{version_no}"


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail=detail)


def _check_body(body: str) -> None:
    if not body.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="empty_body")


async def _check_refs(conn: AsyncConnection, data: DraftIn) -> list[UUID]:
    ids = list(dict.fromkeys(data.material_ids))
    if ids:
        n = await (await conn.execute(
            "select count(*) n from materials where id = any(%s) and user_id = auth.uid() "
            "and confirmed_at is not null and deleted_at is null",
            (ids,),
        )).fetchone()
        if n["n"] != len(ids):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                detail="material_not_available")
    if data.suggestion_id is not None and await (await conn.execute(
            "select 1 from suggestions where id = %s and user_id = auth.uid()",
            (data.suggestion_id,))).fetchone() is None:
        raise _not_found("suggestion_not_found")
    return ids


async def _set_materials(conn: AsyncConnection, essay_id: UUID, ids: list[UUID]) -> None:
    await conn.execute("delete from essay_materials where essay_id = %s", (essay_id,))
    await conn.execute(
        "insert into essay_materials (essay_id, material_id, seq) "
        "select %s, m, n from unnest(%s::uuid[]) with ordinality as t(m, n)",
        (essay_id, ids),
    )


async def _materials(conn: AsyncConnection, essay_id: UUID) -> list[MaterialRef]:
    rows = await (await conn.execute(
        "select m.id, m.title, m.summary, m.deleted_at is not null as deleted "
        "from essay_materials em join materials m on m.id = em.material_id "
        "where em.essay_id = %s order by em.seq",
        (essay_id,),
    )).fetchall()
    return [MaterialRef(**r) for r in rows]


async def _essay(conn: AsyncConnection, essay_id: UUID) -> Essay:
    e = await (await conn.execute(
        "select id, method, title, direction, created_at, updated_at from essays "
        "where id = %s and user_id = auth.uid() and status = 'saved'",
        (essay_id,),
    )).fetchone()
    if e is None:
        raise _not_found("essay_not_found")
    versions = await (await conn.execute(
        "select id, version_no, kind, title, body, char_count, style, length, regen_count, "
        "created_at, updated_at from essay_versions where essay_id = %s order by version_no",
        (essay_id,),
    )).fetchall()
    return Essay(**e, materials=await _materials(conn, essay_id),
                 versions=[Version(**v, label=_label(v["version_no"]),
                                   in_length_range=in_length_range(v["length"], v["char_count"]))
                           for v in versions])


async def _lock_essay(conn: AsyncConnection, essay_id: UUID) -> dict:
    e = await (await conn.execute(
        "select id, method from essays where id = %s and user_id = auth.uid() "
        "and status = 'saved' for update",
        (essay_id,),
    )).fetchone()
    if e is None:
        raise _not_found("essay_not_found")
    return e


async def _after_save(conn: AsyncConnection, essay_id: UUID, method: str) -> None:
    """essays.title = latest version's title (ERD 13), bump updated_at, R33 essay_saved."""
    await conn.execute(
        "update essays set title = (select title from essay_versions where essay_id = %s "
        "order by version_no desc limit 1) where id = %s",
        (essay_id, essay_id),
    )
    await conn.execute(
        "insert into events (user_id, name, essay_id, write_mode, material_count) "
        "values (auth.uid(), 'essay_saved', %s, %s, "
        "(select count(*) from essay_materials where essay_id = %s))",
        (essay_id, method, essay_id),
    )


async def _version_by_token(conn: AsyncConnection, token: UUID) -> dict | None:
    """The caller's version already saved with this token (retry)."""
    return await (await conn.execute(
        "select essay_id from essay_versions where save_token = %s", (token,),
    )).fetchone()


async def _insert_version(conn: AsyncConnection, sql: str, params: tuple) -> None:
    """Insert a version. The token is unique across all users and RLS hides other users'
    rows, so a token someone else already used shows up only here → 409."""
    try:
        async with conn.transaction():  # savepoint: the request can still answer 409
            await conn.execute(sql, params)
    except UniqueViolation as e:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="save_token_used") from e


# ---------------------------------------------------------------------------
# N140 직접 쓰기
# ---------------------------------------------------------------------------
@router.get("/draft", response_model=Draft)
async def get_draft(conn: ConsentedConn) -> Draft:
    """H121: the one direct-writing draft. 404 `no_draft` when there is none."""
    row = await (await conn.execute(
        "select id, title, coalesce(draft_body, '') as body, direction, suggestion_id, "
        "updated_at from essays where user_id = auth.uid() and status = 'draft'"
    )).fetchone()
    if row is None:
        raise _not_found("no_draft")
    return Draft(**row, materials=await _materials(conn, row["id"]))


@router.post("/draft", response_model=Draft)
async def save_draft(data: DraftIn, conn: ConsentedConn) -> Draft:
    """[임시 저장]: create the one draft or overwrite it (ERD 16). Body may be empty.
    Continuing a draft: send its id as `essay_id` (404 `draft_not_found` if it was saved)."""
    ids = await _check_refs(conn, data)
    values = (data.title or None, data.body, data.direction or None, data.suggestion_id)
    if data.essay_id is not None:
        row = await (await conn.execute(
            "update essays set title = %s, draft_body = %s, direction = %s, suggestion_id = %s "
            "where id = %s and user_id = auth.uid() and status = 'draft' returning id",
            (*values, data.essay_id),
        )).fetchone()
        if row is None:
            raise _not_found("draft_not_found")
    else:
        row = await (await conn.execute(
            """
            insert into essays (user_id, method, status, title, draft_body, direction,
                                suggestion_id)
            values (auth.uid(), 'direct', 'draft', %s, %s, %s, %s)
            on conflict (user_id) where status = 'draft'
            do update set title = excluded.title, draft_body = excluded.draft_body,
                          direction = excluded.direction, suggestion_id = excluded.suggestion_id
            returning id
            """,
            values,
        )).fetchone()
    await _set_materials(conn, row["id"], ids)
    return await get_draft(conn)


@router.post("", response_model=Essay, status_code=status.HTTP_201_CREATED,
             responses={200: {"description": "Already saved (retry): the essay"}})
async def first_save(data: FirstSaveIn, conn: ConsentedConn, response: Response) -> Essay:
    """N140 [저장]: 처음 저장하면 v1 (직접 쓴 글에는 초안이 없다). Then open L120.

    Continuing a draft: send its id as `essay_id`; the draft becomes this essay.
    Safe to retry: the same `save_token` (or an `essay_id` already saved) → 200, one v1.
    """
    _check_body(data.body)
    if (done := await _version_by_token(conn, data.save_token)) is not None:
        response.status_code = status.HTTP_200_OK
        return await _essay(conn, done["essay_id"])
    ids = await _check_refs(conn, data)
    values = (data.title or None, data.direction or None, data.suggestion_id)

    if data.essay_id is not None:
        row = await (await conn.execute(
            "update essays set status = 'saved', title = %s, direction = %s, "
            "suggestion_id = %s, draft_body = null "
            "where id = %s and user_id = auth.uid() and status = 'draft' returning id",
            (*values, data.essay_id),
        )).fetchone()
        if row is None:
            if await (await conn.execute(
                    "select 1 from essays where id = %s and user_id = auth.uid() "
                    "and status = 'saved'", (data.essay_id,))).fetchone():
                response.status_code = status.HTTP_200_OK  # saved from another tab/retry
                return await _essay(conn, data.essay_id)
            raise _not_found("draft_not_found")
    else:
        row = await (await conn.execute(
            "insert into essays (user_id, method, status, title, direction, suggestion_id) "
            "values (auth.uid(), 'direct', 'saved', %s, %s, %s) returning id",
            values,
        )).fetchone()

    essay_id = row["id"]
    await _set_materials(conn, essay_id, ids)
    await _insert_version(
        conn,
        "insert into essay_versions (essay_id, version_no, kind, title, body, char_count, "
        "save_token) values (%s, 1, 'direct_first', %s, %s, %s, %s)",
        (essay_id, data.title or None, data.body, len(data.body), data.save_token),
    )
    await _after_save(conn, essay_id, "direct")
    return await _essay(conn, essay_id)


# ---------------------------------------------------------------------------
# L110 내 서재, L120 글 상세
# ---------------------------------------------------------------------------
@router.get("", response_model=list[EssayCard])
async def my_essays(conn: ConsentedConn) -> list[EssayCard]:
    """L110: 직접 쓰기 임시 저장(1개)은 맨 위, 나머지는 최근 수정 순."""
    rows = await (await conn.execute(
        """
        select e.id, e.title, e.method, e.status = 'draft' as is_draft, e.updated_at,
               (select count(*) from essay_materials em where em.essay_id = e.id)
                 as material_count,
               (select max(version_no) from essay_versions v where v.essay_id = e.id) as latest
          from essays e
         where e.user_id = auth.uid()
         order by e.status = 'draft' desc, e.updated_at desc
        """
    )).fetchall()
    return [EssayCard(
        **{k: v for k, v in r.items() if k != "latest"},
        state="임시 저장" if r["is_draft"] else _label(r["latest"] or 0),
    ) for r in rows]


@router.get("/{essay_id}", response_model=Essay)
async def get_essay(essay_id: UUID, conn: ConsentedConn) -> Essay:
    """L120: 버전들(초안 → v1 → …)과 사용한 소재. 삭제된 소재는 deleted = true.
    The draft is opened with GET /essays/draft instead (404 here)."""
    return await _essay(conn, essay_id)


# ---------------------------------------------------------------------------
# L122 저장 방식 선택
# ---------------------------------------------------------------------------
@router.put("/{essay_id}/versions/{version_id}", response_model=Essay)
async def overwrite_version(essay_id: UUID, version_id: UUID, data: VersionIn,
                            conn: ConsentedConn) -> Essay:
    """[저장 후 덮어쓰기]: 보고 있던 버전(초안·v1 등)의 내용을 바꾼다. 이전 내용은 남지 않는다.
    Sending the same text again changes nothing else, so a retry is safe."""
    _check_body(data.body)
    e = await _lock_essay(conn, essay_id)
    row = await (await conn.execute(
        "update essay_versions set title = %s, body = %s, char_count = %s "
        "where id = %s and essay_id = %s returning id",
        (data.title or None, data.body, len(data.body), version_id, essay_id),
    )).fetchone()
    if row is None:
        raise _not_found("version_not_found")
    await _after_save(conn, essay_id, e["method"])
    return await _essay(conn, essay_id)


@router.post("/{essay_id}/versions", response_model=Essay,
             status_code=status.HTTP_201_CREATED,
             responses={200: {"description": "Already saved (retry): the essay"}})
async def save_new_version(essay_id: UUID, data: NewVersionIn, conn: ConsentedConn,
                           response: Response) -> Essay:
    """[새 버전으로 저장]: 다음 번호로 보관 (초안 다음은 v1). Same `save_token` → one version."""
    _check_body(data.body)
    e = await _lock_essay(conn, essay_id)
    if (done := await _version_by_token(conn, data.save_token)) is not None:
        response.status_code = status.HTTP_200_OK
        return await _essay(conn, done["essay_id"])
    if await (await conn.execute(
            "select 1 from essay_versions where id = %s and essay_id = %s",
            (data.based_on_version_id, essay_id))).fetchone() is None:
        raise _not_found("version_not_found")
    await _insert_version(
        conn,
        """
        insert into essay_versions (essay_id, version_no, kind, title, body, char_count,
                                    based_on_version_id, save_token)
        select %s, coalesce(max(version_no), 0) + 1, 'direct_new', %s, %s, %s, %s, %s
          from essay_versions where essay_id = %s
        """,
        (essay_id, data.title or None, data.body, len(data.body), data.based_on_version_id,
         data.save_token, essay_id),
    )
    await _after_save(conn, essay_id, e["method"])
    return await _essay(conn, essay_id)


# ---------------------------------------------------------------------------
# L121 글 삭제
# ---------------------------------------------------------------------------
@router.delete("/{essay_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_essay(essay_id: UUID, conn: ConsentedConn) -> Response:
    """글·모든 버전·소재 연결을 지운다. 소재는 소재함에 남는다. Works for the draft too."""
    row = await (await conn.execute(
        "delete from essays where id = %s and user_id = auth.uid() returning id", (essay_id,),
    )).fetchone()
    if row is None:
        raise _not_found("essay_not_found")
    await conn.execute(
        "delete from ai_requests where target_type = 'essay' and target_id = %s", (essay_id,))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
