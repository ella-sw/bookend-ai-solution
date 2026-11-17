"""R05 AI 질문에 답하기 API (W210 문답 기록 규칙, 수정 대기 목록 17번)."""

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai import AIError, AIText, StubQuestionAI, get_question_ai
from app.main import app
from tests.conftest import TEST_URL, token_for


class FailingAI(StubQuestionAI):
    async def next_question(self, turns, avoid):
        raise AIError("simulated failure")


class LateAI(StubQuestionAI):
    """Returns a question, but only after the request was already marked timeout."""

    async def next_question(self, turns, avoid):
        with psycopg.connect(TEST_URL, autocommit=True) as c:
            c.execute("update ai_requests set status = 'timeout' where status = 'running'")
        return AIText("늦게 온 질문")


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def use_ai(ai):
    app.dependency_overrides[get_question_ai] = lambda: ai


def auth(uid):
    return {"Authorization": f"Bearer {token_for(uid)}"}


def first_q(client, uid):
    return client.get("/daily-questions/today", headers=auth(uid)).json()["questions"][0]


def start(client, uid, answer="엄마랑 통화했다"):
    r = client.post("/qna", headers=auth(uid),
                    json={"daily_question_id": first_q(client, uid)["id"], "answer": answer})
    assert r.status_code == 201, r.text
    return r.json()


def reply(client, uid, state, answer="답변"):
    r = client.post(f"/qna/{state['record_id']}/answers", headers=auth(uid),
                    json={"question_id": state["pending_question"]["id"], "answer": answer})
    assert r.status_code == 200, r.text
    return r.json()


def age(owner, record_id, hours=2):
    """Pretend the last activity was `hours` ago (triggers off, they would reset updated_at)."""
    owner.execute("set session_replication_role = replica")
    owner.execute("update records set updated_at = now() - make_interval(hours => %s) "
                  "where id = %s", (hours, record_id))
    owner.execute("set session_replication_role = default")


def replace(client, uid, state):
    return client.post(f"/qna/{state['record_id']}/replace", headers=auth(uid),
                       json={"question_id": state["pending_question"]["id"]})


# ---------------------------------------------------------------------------
# 오늘의 질문
# ---------------------------------------------------------------------------
def test_daily_questions(client, make_user):
    a = make_user()
    first = client.get("/daily-questions/today", headers=auth(a)).json()
    again = client.get("/daily-questions/today", headers=auth(a)).json()
    assert len(first["questions"]) == 30
    assert [q["seq"] for q in first["questions"]] == list(range(1, 31))
    assert again == first  # made once per day, shared


def test_daily_questions_need_token(client):
    assert client.get("/daily-questions/today").status_code == 401


# ---------------------------------------------------------------------------
# 첫 답변과 후속 답변
# ---------------------------------------------------------------------------
def test_first_answer_starts_active_conversation(client, make_user):
    a = make_user()
    s = start(client, a)
    assert s["status"] == "active" and s["answer_count"] == 1
    assert s["pending_question"]["question_source"] == "followup"
    assert s["replace_left"] == 6 and not s["can_save"] and not s["finished"]
    assert [m["seq"] for m in s["messages"]] == [1, 2]


def test_first_answer_validation(client, make_user):
    a = make_user()
    q = first_q(client, a)
    assert client.post("/qna", headers=auth(a),
                       json={"daily_question_id": q["id"], "answer": "   "}).status_code == 422
    r = client.post("/qna", headers=auth(a), json={
        "daily_question_id": "00000000-0000-0000-0000-000000000000", "answer": "x"})
    assert r.status_code == 422 and r.json()["detail"] == "invalid_daily_question"


def test_new_first_answer_replaces_old_active(client, make_user, owner):
    a = make_user()
    old = start(client, a)
    new = start(client, a, "다른 이야기")
    assert new["record_id"] != old["record_id"]
    assert client.get("/qna/active", headers=auth(a)).json()["record_id"] == new["record_id"]
    n = owner.execute("select count(*) n from ai_requests where target_id = %s",
                      (old["record_id"],)).fetchone()["n"]
    assert n == 0  # its AI request rows went with it


def test_seven_answers_then_finished(client, make_user):
    a = make_user()
    s = start(client, a)
    for _ in range(6):
        s = reply(client, a, s)
    assert s["answer_count"] == 7 and s["finished"] and s["pending_question"] is None
    r = client.post(f"/qna/{s['record_id']}/answers", headers=auth(a),
                    json={"question_id": s["messages"][-1]["id"], "answer": "더"})
    assert r.status_code == 409 and r.json()["detail"] == "finished"
    # /next does not ask more after 7 answers
    assert client.post(f"/qna/{s['record_id']}/next", headers=auth(a)).json()["finished"]


def test_double_submit_answers_once(client, make_user):
    a = make_user()
    s = start(client, a)
    reply(client, a, s)
    again = client.post(f"/qna/{s['record_id']}/answers", headers=auth(a),
                        json={"question_id": s["pending_question"]["id"], "answer": "또"})
    assert again.status_code == 409 and again.json()["detail"] == "not_pending_question"


# ---------------------------------------------------------------------------
# AI 실패 (3절)
# ---------------------------------------------------------------------------
def test_ai_failure_keeps_answer_and_retry_works(client, make_user, owner):
    a = make_user()
    use_ai(FailingAI())
    s = start(client, a)
    assert s["ai_failed"] and s["pending_question"] is None and s["answer_count"] == 1
    st = owner.execute("select status from ai_requests where target_id = %s",
                       (s["record_id"],)).fetchone()["status"]
    assert st == "failed"

    use_ai(StubQuestionAI())
    s = client.post(f"/qna/{s['record_id']}/next", headers=auth(a)).json()
    assert not s["ai_failed"] and s["pending_question"] is not None

    # /next with a pending question returns it as is
    again = client.post(f"/qna/{s['record_id']}/next", headers=auth(a)).json()
    assert again["pending_question"]["id"] == s["pending_question"]["id"]
    assert len(again["messages"]) == len(s["messages"])


def test_late_ai_result_is_discarded(client, make_user, owner):
    """B·C 규칙 3: a result for a request already marked timeout is not applied."""
    a = make_user()
    use_ai(LateAI())
    s = start(client, a)
    assert s["ai_failed"] and s["pending_question"] is None
    st = owner.execute("select status from ai_requests where target_id = %s",
                       (s["record_id"],)).fetchone()["status"]
    assert st == "discarded"


# ---------------------------------------------------------------------------
# [다른 질문 보기]
# ---------------------------------------------------------------------------
def test_replace_question_six_times(client, make_user):
    a = make_user()
    s = start(client, a)
    seen = {s["pending_question"]["question"]}
    for left in range(5, -1, -1):
        s = replace(client, a, s).json()
        assert s["replace_left"] == left and s["answer_count"] == 1
        assert s["pending_question"]["question"] not in seen  # new direction
        seen.add(s["pending_question"]["question"])
    r = replace(client, a, s)
    assert r.status_code == 409 and r.json()["detail"] == "replace_limit"
    # replaced questions are not shown
    assert len(s["messages"]) == 2


def test_replace_failure_keeps_question_and_count(client, make_user):
    a = make_user()
    s = start(client, a)
    use_ai(FailingAI())
    r = replace(client, a, s).json()
    assert r["ai_failed"]
    assert r["pending_question"]["id"] == s["pending_question"]["id"] and r["replace_left"] == 6


# ---------------------------------------------------------------------------
# [임시 저장], 이어 쓰기 (나) 기준점, 나가기
# ---------------------------------------------------------------------------
def test_draft_replaces_previous_draft(client, make_user):
    a = make_user()
    one = start(client, a)
    d1 = client.post(f"/qna/{one['record_id']}/draft", headers=auth(a)).json()
    assert d1["status"] == "draft"
    assert client.get("/qna/active", headers=auth(a)).json() is None

    two = start(client, a, "두 번째 대화")
    client.post(f"/qna/{two['record_id']}/draft", headers=auth(a))
    assert client.get("/qna/draft", headers=auth(a)).json()["record_id"] == two["record_id"]
    assert client.post(f"/qna/{one['record_id']}/next", headers=auth(a)).status_code == 404


def test_resume_then_discard_restores_pending_question_answered(client, make_user):
    """조건 ①: 기준점 때 답을 기다리던 질문에 답한 경우."""
    a = make_user()
    s = start(client, a)
    saved = client.post(f"/qna/{s['record_id']}/draft", headers=auth(a)).json()
    pending_id = saved["pending_question"]["id"]

    s = reply(client, a, saved, "이어 쓰며 답함")  # answers the pending question
    s = reply(client, a, s, "하나 더")
    assert s["answer_count"] == 3

    back = client.post(f"/qna/{s['record_id']}/discard-changes", headers=auth(a)).json()
    assert back["answer_count"] == 1
    assert back["pending_question"]["id"] == pending_id
    assert back["pending_question"]["answer"] is None
    assert [m["id"] for m in back["messages"]] == [m["id"] for m in saved["messages"]]


def test_resume_then_discard_restores_replaced_question(client, make_user):
    """조건 ①: 기준점 때 답을 기다리던 질문을 [다른 질문 보기]로 바꾼 경우."""
    a = make_user()
    s = start(client, a)
    saved = client.post(f"/qna/{s['record_id']}/draft", headers=auth(a)).json()

    s = replace(client, a, saved).json()
    assert s["replace_left"] == 5

    back = client.post(f"/qna/{s['record_id']}/discard-changes", headers=auth(a)).json()
    assert back["pending_question"]["id"] == saved["pending_question"]["id"]
    assert back["replace_left"] == 6


def test_resaving_draft_moves_checkpoint(client, make_user):
    a = make_user()
    s = start(client, a)
    client.post(f"/qna/{s['record_id']}/draft", headers=auth(a))
    s = reply(client, a, client.get("/qna/draft", headers=auth(a)).json())
    client.post(f"/qna/{s['record_id']}/draft", headers=auth(a))  # [임시 저장] again
    back = client.post(f"/qna/{s['record_id']}/discard-changes", headers=auth(a)).json()
    assert back["answer_count"] == 2  # the second answer is kept now


def test_stale_resumed_draft_reverts_on_read(client, make_user, owner):
    """조건 ②: 이어 쓰다 그냥 나가서 1시간이 지나면 기준점으로 되돌린 뒤 돌려준다."""
    a = make_user()
    s = start(client, a)
    client.post(f"/qna/{s['record_id']}/draft", headers=auth(a))
    s = reply(client, a, client.get("/qna/draft", headers=auth(a)).json())

    # within 1 hour: unsaved answers are still there
    assert client.get("/qna/draft", headers=auth(a)).json()["answer_count"] == 2

    age(owner, s["record_id"])
    assert client.get("/qna/draft", headers=auth(a)).json()["answer_count"] == 1


def test_stale_active_is_deleted(client, make_user, owner):
    a = make_user()
    s = start(client, a)
    age(owner, s["record_id"])
    assert client.get("/qna/active", headers=auth(a)).json() is None
    n = owner.execute("select count(*) n from records where id = %s",
                      (s["record_id"],)).fetchone()["n"]
    assert n == 0


def test_delete_only_active(client, make_user, owner):
    a = make_user()
    s = start(client, a)
    assert client.delete(f"/qna/{s['record_id']}", headers=auth(a)).status_code == 204
    assert owner.execute("select count(*) n from ai_requests where target_id = %s",
                         (s["record_id"],)).fetchone()["n"] == 0

    d = start(client, a)
    client.post(f"/qna/{d['record_id']}/draft", headers=auth(a))
    r = client.delete(f"/qna/{d['record_id']}", headers=auth(a))
    assert r.status_code == 409 and r.json()["detail"] == "not_active"


# ---------------------------------------------------------------------------
# [소재로 저장]
# ---------------------------------------------------------------------------
def test_save_needs_two_answers(client, make_user, owner):
    a = make_user()
    s = start(client, a)
    r = client.post(f"/qna/{s['record_id']}/save", headers=auth(a))
    assert r.status_code == 409 and r.json()["detail"] == "need_more_answers"

    s = reply(client, a, s)
    rec = client.post(f"/qna/{s['record_id']}/save", headers=auth(a))
    assert rec.status_code == 201 and rec.json()["status"] == "saved"

    rows = owner.execute("select answer from qna_messages where record_id = %s "
                         "and not is_replaced order by seq", (s["record_id"],)).fetchall()
    assert all(r["answer"] for r in rows) and len(rows) == 2  # pending question left out
    ev = owner.execute("select name from events where record_id = %s",
                       (s["record_id"],)).fetchall()
    assert [e["name"] for e in ev] == ["record_saved"]

    # saved conversations are closed
    assert client.post(f"/qna/{s['record_id']}/next", headers=auth(a)).status_code == 404


def test_save_resumed_draft(client, make_user):
    a = make_user()
    s = start(client, a)
    client.post(f"/qna/{s['record_id']}/draft", headers=auth(a))
    s = reply(client, a, client.get("/qna/draft", headers=auth(a)).json())
    assert client.post(f"/qna/{s['record_id']}/save", headers=auth(a)).status_code == 201
    assert client.get("/qna/draft", headers=auth(a)).json() is None


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------
def test_other_user_cannot_touch_conversation(client, make_user):
    a, b = make_user(), make_user()
    s = start(client, a)
    rid, qid = s["record_id"], s["pending_question"]["id"]
    assert client.post(f"/qna/{rid}/answers", headers=auth(b),
                       json={"question_id": qid, "answer": "x"}).status_code == 404
    assert client.post(f"/qna/{rid}/save", headers=auth(b)).status_code == 404
    assert client.delete(f"/qna/{rid}", headers=auth(b)).status_code == 404
    assert client.get("/qna/active", headers=auth(b)).json() is None


def test_requires_consent(client, make_user):
    a = make_user(consented=False)
    r = client.get("/qna/active", headers=auth(a))
    assert r.status_code == 403
