"""R04 자유롭게 기록하기 API."""

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import token_for


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def auth(uid):
    return {"Authorization": f"Bearer {token_for(uid)}"}


def tok():
    """A new save_token, as the screen makes when W110 opens."""
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Draft (W111, H121)
# ---------------------------------------------------------------------------
def test_no_draft_at_first(client, make_user):
    a = make_user()
    r = client.get("/records/free/draft", headers=auth(a))
    assert r.status_code == 404 and r.json()["detail"] == "no_draft"


def test_draft_is_created_then_overwritten(client, make_user):
    a = make_user()
    first = client.post("/records/free/draft", headers=auth(a),
                       json={"title": "첫 제목", "body": "처음 쓴 내용"}).json()
    second = client.post("/records/free/draft", headers=auth(a),
                        json={"title": "", "body": "고친 내용"}).json()

    assert second["id"] == first["id"]  # still one draft
    assert second["body"] == "고친 내용" and second["title"] is None
    assert second["status"] == "draft"
    assert second["updated_at"] >= first["updated_at"]

    got = client.get("/records/free/draft", headers=auth(a)).json()
    assert got["id"] == first["id"] and got["body"] == "고친 내용"


def test_empty_draft_is_allowed(client, make_user):
    a = make_user()
    assert client.post("/records/free/draft", headers=auth(a), json={"body": ""}).status_code == 200


# ---------------------------------------------------------------------------
# [소재로 저장] (W110)
# ---------------------------------------------------------------------------
def test_save_new_record(client, make_user, owner):
    a = make_user()
    r = client.post("/records/free", headers=auth(a), json={"save_token": tok(), "body": "오늘 엄마랑 통화했다"})
    assert r.status_code == 201
    rec = r.json()
    assert rec["status"] == "saved" and rec["saved_at"] and rec["analysis_status"] == "none"
    assert rec["title"] is None

    ev = owner.execute("select name, record_id::text from events where user_id = %s",
                       (a,)).fetchall()
    assert ev == [{"name": "record_saved", "record_id": rec["id"]}]


def test_save_continuing_draft_turns_draft_into_record(client, make_user):
    a = make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "쓰는 중"}).json()

    saved = client.post("/records/free", headers=auth(a),
                        json={"save_token": tok(), "body": "다 썼다", "record_id": draft["id"]}).json()
    assert saved["id"] == draft["id"] and saved["status"] == "saved"
    assert saved["body"] == "다 썼다"

    assert client.get("/records/free/draft", headers=auth(a)).status_code == 404


def test_starting_fresh_keeps_old_draft(client, make_user):
    a = make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "예전 임시 저장"}).json()

    client.post("/records/free", headers=auth(a), json={"save_token": tok(), "body": "새로 쓴 기록"})  # [아니오] path

    still = client.get("/records/free/draft", headers=auth(a)).json()
    assert still["id"] == draft["id"] and still["body"] == "예전 임시 저장"


@pytest.mark.parametrize("body", ["", "   \n\t  "])
def test_empty_body_cannot_be_saved(client, make_user, body):
    a = make_user()
    r = client.post("/records/free", headers=auth(a), json={"save_token": tok(), "body": body})
    assert r.status_code == 422


def test_saved_record_cannot_be_overwritten_through_draft(client, make_user):
    a = make_user()
    saved = client.post("/records/free", headers=auth(a), json={"save_token": tok(), "body": "저장한 원본"}).json()

    # a new draft is a separate row; the saved record keeps its body
    client.post("/records/free/draft", headers=auth(a), json={"body": "새 임시 저장"})
    assert client.get(f"/records/{saved['id']}", headers=auth(a)).json()["body"] == "저장한 원본"


# ---------------------------------------------------------------------------
# Access (R02)
# ---------------------------------------------------------------------------
def test_requires_consent(client, make_user):
    a = make_user(consented=False)
    r = client.post("/records/free/draft", headers=auth(a), json={"body": "x"})
    assert r.status_code == 403 and r.json()["detail"] == "not_consented"


def test_other_user_cannot_see_or_use_my_records(client, make_user):
    a, b = make_user(), make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "A의 임시 저장"}).json()
    saved = client.post("/records/free", headers=auth(a), json={"save_token": tok(), "body": "A의 기록"}).json()

    assert client.get(f"/records/{saved['id']}", headers=auth(b)).status_code == 404
    assert client.get("/records/free/draft", headers=auth(b)).status_code == 404
    # B cannot save A's draft
    r = client.post("/records/free", headers=auth(b), json={"save_token": tok(), "body": "가로채기", "record_id": draft["id"]})
    assert r.status_code == 404
    assert client.get("/records/free/draft", headers=auth(a)).json()["body"] == "A의 임시 저장"


def test_requires_token(client):
    assert client.get("/records/free/draft").status_code == 401


# ---------------------------------------------------------------------------
# POST /records/free/draft with record_id (continuing a draft)
# ---------------------------------------------------------------------------
def test_continue_draft_with_record_id(client, make_user):
    a = make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "처음"}).json()
    again = client.post("/records/free/draft", headers=auth(a),
                        json={"body": "이어서 더 씀", "record_id": draft["id"]})
    assert again.status_code == 200
    assert again.json()["id"] == draft["id"] and again.json()["body"] == "이어서 더 씀"


def test_continue_draft_that_was_already_saved(client, make_user):
    a = make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "쓰는 중"}).json()
    client.post("/records/free", headers=auth(a), json={"save_token": tok(), "body": "다 씀", "record_id": draft["id"]})

    r = client.post("/records/free/draft", headers=auth(a),
                    json={"body": "다른 탭에서 임시 저장", "record_id": draft["id"]})
    assert r.status_code == 404 and r.json()["detail"] == "draft_not_found"
    # the saved record is untouched
    assert client.get(f"/records/{draft['id']}", headers=auth(a)).json()["body"] == "다 씀"


def test_cannot_continue_another_users_draft(client, make_user):
    a, b = make_user(), make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "A의 글"}).json()
    r = client.post("/records/free/draft", headers=auth(b),
                    json={"body": "덮어쓰기", "record_id": draft["id"]})
    assert r.status_code == 404
    assert client.get("/records/free/draft", headers=auth(a)).json()["body"] == "A의 글"


def test_put_is_gone(client, make_user):
    a = make_user()
    assert client.put("/records/free/draft", headers=auth(a), json={"body": "x"}).status_code == 405


# ---------------------------------------------------------------------------
# 중복 저장 막기 (A 피드백): 응답이 끊겨 [다시 시도]해도 기록은 1개
# ---------------------------------------------------------------------------
def test_retry_new_record_with_same_token_returns_it(client, make_user, owner):
    a = make_user()
    t = tok()
    first = client.post("/records/free", headers=auth(a), json={"save_token": t, "body": "기록"})
    retry = client.post("/records/free", headers=auth(a), json={"save_token": t, "body": "기록"})
    assert first.status_code == 201 and retry.status_code == 200
    assert retry.json()["id"] == first.json()["id"]
    n = owner.execute("select count(*) n from records where user_id = %s", (a,)).fetchone()["n"]
    ev = owner.execute("select count(*) n from events where user_id = %s", (a,)).fetchone()["n"]
    assert n == 1 and ev == 1


def test_retry_draft_save_returns_saved_record(client, make_user):
    a = make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "쓰는 중"}).json()
    t = tok()
    body = {"save_token": t, "body": "다 썼다", "record_id": draft["id"]}
    first = client.post("/records/free", headers=auth(a), json=body)
    retry = client.post("/records/free", headers=auth(a), json=body)
    assert first.status_code == 201 and retry.status_code == 200
    assert retry.json()["id"] == draft["id"] and retry.json()["status"] == "saved"

    # even with a new token (screen reloaded), the same record_id is a success, not 404
    other = client.post("/records/free", headers=auth(a), json={**body, "save_token": tok()})
    assert other.status_code == 200 and other.json()["id"] == draft["id"]


def test_save_token_is_required(client, make_user):
    a = make_user()
    assert client.post("/records/free", headers=auth(a), json={"body": "x"}).status_code == 422


def test_same_token_from_another_user_is_a_new_record(client, make_user):
    a, b = make_user(), make_user()
    t = tok()
    ra = client.post("/records/free", headers=auth(a), json={"save_token": t, "body": "A"}).json()
    rb = client.post("/records/free", headers=auth(b), json={"save_token": t, "body": "B"})
    assert rb.status_code == 201 and rb.json()["id"] != ra["id"]
