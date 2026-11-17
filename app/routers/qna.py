"""R05 AI 질문에 답하기 (W210 / W211 / W212, H121 이어 쓰기 확인).

Agreed with A in `W210_문답기록_규칙_회신.md` (수정 대기 목록 17번):

  status   meaning
  active   a conversation in progress (first answer ~ before [임시 저장]); not shown anywhere else
  draft    [임시 저장]ed conversation, one per user; resumed in place with a checkpoint (방법 나)
  saved    [소재로 저장]ed; frozen

Screen flow:
  W210 enter         GET /qna/active  → open it (≤ 1 hour since last activity) or null
                     GET /qna/draft   → H121 "이어서 쓰시겠습니까?" if not null
                     GET /daily-questions/today → first question list (1/30 …)
  first answer       POST /qna                      → active + next question
  next answers       POST /qna/{id}/answers
  AI failed          response has ai_failed = true → [다시 시도] POST /qna/{id}/next
  [다른 질문 보기]    POST /qna/{id}/replace  (6 per conversation)
  [임시 저장]         POST /qna/{id}/draft
  [저장하지 않고 나가기] DELETE /qna/{id} (active) or POST /qna/{id}/discard-changes (draft)
  [소재로 저장]       POST /qna/{id}/save  (2+ answers)

The AI is called outside any transaction: the answer is committed first, so an AI
failure never loses an answer, and a slow AI never holds a DB connection.
"""

import asyncio
from datetime import date, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from psycopg import AsyncConnection
from pydantic import BaseModel, StringConstraints

from app.ai import AIError, QuestionAI, Turn, get_question_ai
from app.auth import CurrentUser, current_user
from app.config import get_settings
from app.db import owner_tx, require_consent, user_tx
from app.routers.records import COLUMNS as RECORD_COLUMNS
from app.routers.records import Record

router = APIRouter(tags=["qna"])

MAX_ANSWERS = 7
MIN_ANSWERS_TO_SAVE = 2
MAX_REPLACES = 6
DAILY_COUNT = 30
STALE = "interval '1 hour'"
KST_TODAY = "(now() at time zone 'Asia/Seoul')::date"

User = Annotated[CurrentUser, Depends(current_user)]
AI = Annotated[QuestionAI, Depends(get_question_ai)]
Answer = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=5000)]


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class Message(BaseModel):
    id: UUID
    seq: int
    question: str
    question_source: str
    answer: str | None


class QnaState(BaseModel):
    record_id: UUID
    status: str
    updated_at: datetime
    messages: list[Message]  # shown in order; replaced questions are left out
    pending_question: Message | None  # the question waiting for an answer
    answer_count: int  # progress (3/7)
    replace_left: int  # [다른 질문 보기 N]
    finished: bool  # 7 answers → W212 마무리
    can_save: bool  # [소재로 저장] enabled (2+ answers)
    ai_failed: bool = False  # next question could not be made → [다시 시도] POST /next


class DailyQuestion(BaseModel):
    id: UUID
    seq: int
    question: str


class DailyQuestions(BaseModel):
    date: date
    questions: list[DailyQuestion]


class FirstAnswerIn(BaseModel):
    daily_question_id: UUID
    answer: Answer


class AnswerIn(BaseModel):
    question_id: UUID  # the pending question being answered (blocks double submits)
    answer: Answer


class ReplaceIn(BaseModel):
    question_id: UUID  # the pending follow-up question to replace


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _conflict(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, detail=detail)


async def _lock_open_record(conn: AsyncConnection, record_id: UUID) -> dict:
    """The caller's active/draft Q&A record, locked for this transaction. 404 otherwise."""
    row = await (await conn.execute(
        "select id, status, updated_at, checkpoint_seq from records "
        "where id = %s and user_id = auth.uid() and type = 'qna' "
        "and status in ('active', 'draft') for update",
        (record_id,),
    )).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="conversation_not_found")
    return row


async def _messages(conn: AsyncConnection, record_id: UUID) -> list[dict]:
    return await (await conn.execute(
        "select id, seq, question, question_source, answer, is_replaced "
        "from qna_messages where record_id = %s order by seq",
        (record_id,),
    )).fetchall()


def _summary(msgs: list[dict]) -> dict:
    live = [m for m in msgs if not m["is_replaced"]]
    answered = [m for m in live if m["answer"] is not None]
    pending = next((m for m in reversed(live) if m["answer"] is None), None)
    return {
        "live": live,
        "answer_count": len(answered),
        "replaced": sum(1 for m in msgs if m["is_replaced"]),
        "pending": pending,
        "max_seq": max((m["seq"] for m in msgs), default=0),
    }


async def _state(conn: AsyncConnection, record_id: UUID, ai_failed: bool = False) -> QnaState:
    rec = await (await conn.execute(
        "select id, status, updated_at from records where id = %s and user_id = auth.uid()",
        (record_id,),
    )).fetchone()
    if rec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="conversation_not_found")
    s = _summary(await _messages(conn, record_id))
    return QnaState(
        record_id=rec["id"],
        status=rec["status"],
        updated_at=rec["updated_at"],
        messages=[Message(**m) for m in s["live"]],
        pending_question=Message(**s["pending"]) if s["pending"] else None,
        answer_count=s["answer_count"],
        replace_left=max(0, MAX_REPLACES - s["replaced"]),
        finished=s["answer_count"] >= MAX_ANSWERS,
        can_save=s["answer_count"] >= MIN_ANSWERS_TO_SAVE,
        ai_failed=ai_failed,
    )


async def _state_for(user: CurrentUser, record_id: UUID, ai_failed: bool = False) -> QnaState:
    async with user_tx(user.id) as conn:
        return await _state(conn, record_id, ai_failed)


async def _delete_record(conn: AsyncConnection, record_id: UUID) -> None:
    """Hard delete with its Q&A and AI request rows (분석가 확인: AI 요청 기록도 같이 지움)."""
    await conn.execute(
        "delete from ai_requests where target_type = 'record' and target_id = %s", (record_id,))
    await conn.execute("delete from records where id = %s and user_id = auth.uid()", (record_id,))


async def _generate_question(
    user: CurrentUser, record_id: UUID, ai: QuestionAI, replace_of: UUID | None = None,
) -> bool:
    """Ask the AI for the next (or a replacement) question and store it.

    Returns False when the AI failed or the result arrived too late (B·C 규칙 3);
    the conversation is then unchanged and the screen offers [다시 시도].
    """
    async with user_tx(user.id) as conn:
        msgs = await _messages(conn, record_id)
        req = await (await conn.execute(
            "insert into ai_requests (user_id, kind, target_type, target_id) "
            "values (auth.uid(), 'question', 'record', %s) returning id",
            (record_id,),
        )).fetchone()
    turns = [Turn(m["question"], m["answer"]) for m in msgs
             if not m["is_replaced"] and m["answer"] is not None]
    avoid = [m["question"] for m in msgs if m["is_replaced"] or m["id"] == replace_of]

    try:
        result = await asyncio.wait_for(
            ai.next_question(turns, avoid), get_settings().ai_question_timeout_seconds)
        if not result.text or not result.text.strip():
            raise AIError("empty question")
    except (AIError, TimeoutError, Exception) as e:  # noqa: BLE001 - any AI failure
        timed_out = isinstance(e, TimeoutError)
        async with user_tx(user.id) as conn:
            await conn.execute(
                "update ai_requests set status = %s, finished_at = now(), failure_reason = %s "
                "where id = %s and status = 'running'",
                ("timeout" if timed_out else "failed", type(e).__name__, req["id"]),
            )
        return False

    async with user_tx(user.id) as conn:
        # B·C 규칙 3: apply only if this request is still running
        ok = await (await conn.execute(
            "update ai_requests set status = 'ok', finished_at = now(), "
            "input_tokens = %s, output_tokens = %s where id = %s and status = 'running' "
            "returning id",
            (result.input_tokens, result.output_tokens, req["id"]),
        )).fetchone()
        rec = await (await conn.execute(
            "select id from records where id = %s and user_id = auth.uid() and type = 'qna' "
            "and status in ('active', 'draft') for update",
            (record_id,),
        )).fetchone()
        s = _summary(await _messages(conn, record_id))
        still_valid = (
            ok is not None and rec is not None and s["answer_count"] < MAX_ANSWERS
            and (s["pending"]["id"] == replace_of if replace_of else s["pending"] is None)
        )
        if not still_valid:
            await conn.execute(
                "update ai_requests set status = 'discarded' where id = %s", (req["id"],))
            return False
        if replace_of:
            await conn.execute(
                "update qna_messages set is_replaced = true where id = %s", (replace_of,))
        await conn.execute(
            "insert into qna_messages (record_id, seq, question, question_source) "
            "values (%s, %s, %s, 'followup')",
            (record_id, s["max_seq"] + 1, result.text.strip()),
        )
    return True


# ---------------------------------------------------------------------------
# 오늘의 질문
# ---------------------------------------------------------------------------
@router.get("/daily-questions/today", response_model=DailyQuestions)
async def daily_questions_today(user: User, ai: AI) -> DailyQuestions:
    """오늘(KST)의 공통 첫 질문 30개. 그날 처음 부르면 AI로 만든다."""
    async with owner_tx() as conn:
        today = (await (await conn.execute(f"select {KST_TODAY} as d")).fetchone())["d"]
        n = (await (await conn.execute(
            "select count(*) as n from daily_questions where question_date = %s", (today,),
        )).fetchone())["n"]

    if n < DAILY_COUNT:
        try:
            made = await asyncio.wait_for(ai.daily_questions(today), 60)
            qs = [q.strip() for q in made.questions if q and q.strip()]
            if len(qs) != DAILY_COUNT:
                raise AIError(f"expected {DAILY_COUNT} questions, got {len(qs)}")
        except Exception:  # noqa: BLE001
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail="ai_failed") from None
        async with owner_tx() as conn:
            for i, q in enumerate(qs, start=1):
                await conn.execute(
                    "insert into daily_questions (question_date, seq, question) "
                    "values (%s, %s, %s) on conflict (question_date, seq) do nothing",
                    (today, i, q),
                )

    async with owner_tx() as conn:
        rows = await (await conn.execute(
            "select id, seq, question from daily_questions where question_date = %s "
            "order by seq", (today,),
        )).fetchall()
    return DailyQuestions(date=today, questions=[DailyQuestion(**r) for r in rows])


# ---------------------------------------------------------------------------
# Open conversations
# ---------------------------------------------------------------------------
@router.get("/qna/active", response_model=QnaState | None)
async def get_active(user: User) -> QnaState | None:
    """W210 진입: 마지막 활동이 1시간 이내인 진행 중 대화. 오래된 것은 지우고 null."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        rec = await (await conn.execute(
            f"select id, updated_at < now() - {STALE} as stale from records "
            "where user_id = auth.uid() and type = 'qna' and status = 'active'"
        )).fetchone()
        if rec is None:
            return None
        if rec["stale"]:
            await _delete_record(conn, rec["id"])
            return None
        return await _state(conn, rec["id"])


@router.get("/qna/draft", response_model=QnaState | None)
async def get_draft(user: User) -> QnaState | None:
    """H121: 문답 임시 저장. 이어 쓰다 1시간 넘게 그냥 두었으면 기준점으로 되돌린 뒤 돌려준다."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        rec = await (await conn.execute(
            f"select id, updated_at < now() - {STALE} as stale from records "
            "where user_id = auth.uid() and type = 'qna' and status = 'draft'"
        )).fetchone()
        if rec is None:
            return None
        if rec["stale"]:
            await conn.execute("select revert_qna_draft(%s)", (rec["id"],))
        return await _state(conn, rec["id"])


# ---------------------------------------------------------------------------
# Answering
# ---------------------------------------------------------------------------
@router.post("/qna", response_model=QnaState, status_code=status.HTTP_201_CREATED)
async def first_answer(data: FirstAnswerIn, user: User, ai: AI) -> QnaState:
    """첫 답변: 새 대화(active)를 만들고 다음 질문을 받는다. 이전 진행 중 대화는 지운다."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        dq = await (await conn.execute(
            f"select id, question from daily_questions where id = %s "
            f"and question_date between {KST_TODAY} - 1 and {KST_TODAY}",
            (data.daily_question_id,),
        )).fetchone()
        if dq is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                detail="invalid_daily_question")
        old = await (await conn.execute(
            "select id from records where user_id = auth.uid() and type = 'qna' "
            "and status = 'active'"
        )).fetchone()
        if old:
            await _delete_record(conn, old["id"])
        rec = await (await conn.execute(
            "insert into records (user_id, type, status) values (auth.uid(), 'qna', 'active') "
            "returning id"
        )).fetchone()
        await conn.execute(
            "insert into qna_messages (record_id, seq, question, question_source, "
            "daily_question_id, answer) values (%s, 1, %s, 'daily', %s, %s)",
            (rec["id"], dq["question"], dq["id"], data.answer),
        )

    ok = await _generate_question(user, rec["id"], ai)
    return await _state_for(user, rec["id"], ai_failed=not ok)


@router.post("/qna/{record_id}/answers", response_model=QnaState)
async def answer(record_id: UUID, data: AnswerIn, user: User, ai: AI) -> QnaState:
    """후속 답변. 7번째 답변이면 더 묻지 않는다 (finished = true → W212)."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        await _lock_open_record(conn, record_id)
        s = _summary(await _messages(conn, record_id))
        if s["answer_count"] >= MAX_ANSWERS:
            raise _conflict("finished")
        if s["pending"] is None or s["pending"]["id"] != data.question_id:
            raise _conflict("not_pending_question")
        await conn.execute(
            "update qna_messages set answer = %s where id = %s", (data.answer, data.question_id))

    if s["answer_count"] + 1 >= MAX_ANSWERS:
        return await _state_for(user, record_id)
    ok = await _generate_question(user, record_id, ai)
    return await _state_for(user, record_id, ai_failed=not ok)


@router.post("/qna/{record_id}/next", response_model=QnaState)
async def next_question(record_id: UUID, user: User, ai: AI) -> QnaState:
    """[다시 시도]: 답을 기다리는 질문이 없을 때만 새 질문을 만든다. 있으면 그대로 돌려준다."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        await _lock_open_record(conn, record_id)
        s = _summary(await _messages(conn, record_id))
    if s["pending"] is not None or s["answer_count"] >= MAX_ANSWERS:
        return await _state_for(user, record_id)
    ok = await _generate_question(user, record_id, ai)
    return await _state_for(user, record_id, ai_failed=not ok)


@router.post("/qna/{record_id}/replace", response_model=QnaState)
async def replace_question(record_id: UUID, data: ReplaceIn, user: User, ai: AI) -> QnaState:
    """[다른 질문 보기]: 지금 후속 질문을 새 질문으로 바꾼다. 대화당 6회. 실패하면 그대로."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        await _lock_open_record(conn, record_id)
        s = _summary(await _messages(conn, record_id))
        pending = s["pending"]
        if pending is None or pending["id"] != data.question_id:
            raise _conflict("not_pending_question")
        if pending["question_source"] != "followup":
            raise _conflict("first_question_not_replaceable")
        if s["replaced"] >= MAX_REPLACES:
            raise _conflict("replace_limit")

    ok = await _generate_question(user, record_id, ai, replace_of=data.question_id)
    return await _state_for(user, record_id, ai_failed=not ok)


# ---------------------------------------------------------------------------
# Leaving and saving
# ---------------------------------------------------------------------------
@router.post("/qna/{record_id}/draft", response_model=QnaState)
async def save_draft(record_id: UUID, user: User) -> QnaState:
    """[임시 저장]: 이전 문답 임시 저장을 지우고 이 대화를 임시 저장으로. 기준점을 기록한다."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        rec = await _lock_open_record(conn, record_id)
        s = _summary(await _messages(conn, record_id))
        if rec["status"] == "active":
            old = await (await conn.execute(
                "select id from records where user_id = auth.uid() and type = 'qna' "
                "and status = 'draft'"
            )).fetchone()
            if old:
                await _delete_record(conn, old["id"])
        await conn.execute(
            "update records set status = 'draft', checkpoint_seq = %s, "
            "checkpoint_pending_id = %s, checkpoint_at = now() where id = %s",
            (s["max_seq"], s["pending"]["id"] if s["pending"] else None, record_id),
        )
        return await _state(conn, record_id)


@router.post("/qna/{record_id}/discard-changes", response_model=QnaState)
async def discard_changes(record_id: UUID, user: User) -> QnaState:
    """이어 쓰다 [저장하지 않고 나가기]: 마지막 [임시 저장] 시점으로 되돌린다."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        rec = await _lock_open_record(conn, record_id)
        if rec["status"] != "draft":
            raise _conflict("not_draft")
        await conn.execute("select revert_qna_draft(%s)", (record_id,))
        return await _state(conn, record_id)


@router.delete("/qna/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
async def discard_active(record_id: UUID, user: User) -> Response:
    """새 대화에서 [저장하지 않고 나가기]: 진행 중 대화(active)만 지운다."""
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        rec = await _lock_open_record(conn, record_id)
        if rec["status"] != "active":
            raise _conflict("not_active")
        await _delete_record(conn, record_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/qna/{record_id}/save", response_model=Record,
             status_code=status.HTTP_201_CREATED,
             responses={200: {"description": "Already saved (retry): the saved record"}})
async def save_record(record_id: UUID, user: User, response: Response) -> dict:
    """[소재로 저장]: 답변 2개부터. 답을 기다리던 질문은 빼고 저장한다. 이후 고칠 수 없다.

    Safe to retry: if this conversation is already saved, 200 with the saved record.
    Material analysis (R28) starts from this saved record; that comes with C's AI part.
    """
    async with user_tx(user.id) as conn:
        await require_consent(conn)
        # Lock first (any status) so a retry running at the same time waits, then sees 'saved'
        current = await (await conn.execute(
            f"select {RECORD_COLUMNS} from records where id = %s and user_id = auth.uid() "
            "and type = 'qna' for update",
            (record_id,),
        )).fetchone()
        if current is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="conversation_not_found")
        if current["status"] == "saved":
            response.status_code = status.HTTP_200_OK
            return current
        s = _summary(await _messages(conn, record_id))
        if s["answer_count"] < MIN_ANSWERS_TO_SAVE:
            raise _conflict("need_more_answers")
        if s["pending"] is not None:
            await conn.execute("delete from qna_messages where id = %s", (s["pending"]["id"],))
        row = await (await conn.execute(
            "update records set status = 'saved', saved_at = now(), "
            "checkpoint_seq = null, checkpoint_pending_id = null, checkpoint_at = null "
            f"where id = %s returning {RECORD_COLUMNS}",
            (record_id,),
        )).fetchone()
        await conn.execute(
            "insert into events (user_id, name, record_id) values (auth.uid(), 'record_saved', %s)",
            (record_id,),
        )
    return row
