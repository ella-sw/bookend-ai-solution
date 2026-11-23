"""R31 모든 기록 지우기, R33 화면 이벤트."""

import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import TEST_URL
from tests.test_analysis import StubMaterialAI, auth, save, use_ai
from tests.test_materials import box, confirm
from tests.test_qna import start


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def count(owner, uid):
    return owner.execute(
        "select (select count(*) from records where user_id = %(u)s) "
        "     + (select count(*) from materials where user_id = %(u)s) "
        "     + (select count(*) from ai_requests where user_id = %(u)s) "
        "     + (select count(*) from events where user_id = %(u)s) as n", {"u": uid},
    ).fetchone()["n"]


# ---------------------------------------------------------------------------
# R31 모든 기록 지우기 (S120)
# ---------------------------------------------------------------------------
def test_clear_all_keeps_user_and_consent(client, make_user, owner):
    a, b = make_user(), make_user()
    rec = save(client, a)
    confirm(client, a, rec["id"])
    client.post("/records/free/draft", headers=auth(a), json={"body": "임시 저장"})
    start(client, a)  # active Q&A
    save(client, b)
    consent_before = client.get("/me", headers=auth(a)).json()["ai_consent_at"]
    assert count(owner, a) > 0

    r = client.delete("/me/data", headers=auth(a))
    assert r.status_code == 200
    me = r.json()
    assert me["data_cleared_at"] and me["ai_consent_at"] == consent_before
    assert count(owner, a) == 0
    assert box(client, a) == {"pending": [], "drafts": [], "materials": [], "kept_originals": []}
    assert client.get("/me", headers=auth(a)).status_code == 200  # 다시 동의하지 않음
    assert count(owner, b) > 0  # other users untouched

    assert client.delete("/me/data", headers=auth(a)).status_code == 200  # twice is fine


def test_ai_result_arriving_after_clear_is_not_saved(client, make_user, owner):
    """지우는 중 도착한 AI 결과는 저장하지 않는다."""
    a = make_user()

    class ClearDuringAI(StubMaterialAI):
        async def extract_material(self, source, topics):
            with psycopg.connect(TEST_URL, autocommit=True) as c:
                c.execute("select clear_user_data(%s)", (a,))
            return await super().extract_material(source, topics)

    use_ai(ClearDuringAI())
    save(client, a)
    assert count(owner, a) == 0


def test_clear_requires_consent(client, make_user):
    assert client.delete("/me/data", headers=auth(make_user(consented=False))).status_code == 403


# ---------------------------------------------------------------------------
# R33 화면 이벤트
# ---------------------------------------------------------------------------
def events(owner, uid):
    return owner.execute(
        "select name, record_id::text, essay_id::text, suggestion_id::text, write_mode, "
        "material_count, entry_path, share_method, record_type, placement from events where user_id = %s "
        "and name not in ('record_saved', 'material_confirmed') order by id", (uid,),
    ).fetchall()


def test_screen_events_are_recorded(client, make_user, owner):
    a = make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "x"}).json()
    essay = owner.execute("insert into essays (user_id, method) values (%s, 'direct') "
                          "returning id::text", (a,)).fetchone()["id"]
    sug = owner.execute("insert into suggestions (user_id, topic_id) values (%s, 1) "
                        "returning id::text", (a,)).fetchone()["id"]

    sent = [
        {"name": "record_started", "record_type": "qna"},
        {"name": "record_started", "record_type": "free", "record_id": draft["id"]},
        {"name": "writing_started", "write_mode": "ai", "entry_path": "suggestion",
         "material_count": 3, "suggestion_id": sug},
        {"name": "writing_started", "write_mode": "direct", "entry_path": "no_material",
         "material_count": 0},
        {"name": "suggestion_shown", "suggestion_id": sug, "placement": "home"},
        {"name": "suggestion_shown", "suggestion_id": sug, "placement": "suggestion_detail"},
        {"name": "suggestion_selected", "suggestion_id": sug},
        {"name": "body_shared", "essay_id": essay, "share_method": "copy"},
    ]
    for e in sent:
        r = client.post("/events", headers=auth(a), json=e)
        assert r.status_code == 204, r.text

    got = events(owner, a)
    assert [e["name"] for e in got] == [e["name"] for e in sent]
    assert [g["record_type"] for g in got[:2]] == ["qna", "free"]
    assert got[1]["record_id"] == draft["id"]
    assert (got[2]["write_mode"], got[2]["entry_path"], got[2]["material_count"],
            got[2]["suggestion_id"]) == ("ai", "suggestion", 3, sug)
    assert [g["placement"] for g in got[4:6]] == ["home", "suggestion_detail"]
    assert got[7]["share_method"] == "copy" and got[7]["essay_id"] == essay


@pytest.mark.parametrize("body,detail", [
    ({"name": "record_started"}, "missing_field: record_type"),
    ({"name": "writing_started", "write_mode": "direct", "entry_path": "home"},
     "missing_field: material_count"),
    ({"name": "writing_started", "write_mode": "ai", "entry_path": "suggestion",
      "material_count": 2}, "missing_field: suggestion_id"),
    ({"name": "writing_started", "write_mode": "ai", "entry_path": "home",
      "material_count": 2, "suggestion_id": str(uuid.uuid4())}, "unexpected_field: suggestion_id"),
    ({"name": "body_shared", "share_method": "copy"}, "missing_field: essay_id"),
    ({"name": "suggestion_shown", "suggestion_id": str(uuid.uuid4())}, "missing_field: placement"),
    ({"name": "suggestion_shown", "suggestion_id": str(uuid.uuid4()), "placement": "home",
      "share_method": "copy"}, "unexpected_field: share_method"),
])
def test_event_field_rules(client, make_user, body, detail):
    r = client.post("/events", headers=auth(make_user()), json=body)
    assert r.status_code == 422 and r.json()["detail"] == detail


@pytest.mark.parametrize("body", [
    {"name": "record_saved"}, {"name": "material_confirmed"}, {"name": "essay_saved"},
    {"name": "hack"},
    {"name": "record_started", "record_type": "free", "body": "글 본문"},  # unknown field
    {"name": "record_started", "record_type": "essay"},  # not an allowed value
    {"name": "writing_started", "write_mode": "ai", "entry_path": "home",
     "material_count": 101},  # over 0–100
])
def test_invalid_events_are_rejected(client, make_user, body):
    assert client.post("/events", headers=auth(make_user()), json=body).status_code == 422


def test_record_type_must_match_the_record(client, make_user):
    a = make_user()
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "x"}).json()
    r = client.post("/events", headers=auth(a), json={
        "name": "record_started", "record_type": "qna", "record_id": draft["id"]})
    assert r.status_code == 422 and r.json()["detail"] == "record_type_mismatch"


def test_event_ids_must_be_mine(client, make_user, owner):
    a, b = make_user(), make_user()
    rec = save(client, a)
    r = client.post("/events", headers=auth(b), json={"name": "record_started",
                                                      "record_type": "free",
                                                      "record_id": rec["id"]})
    assert r.status_code == 404 and r.json()["detail"] == "record_not_found"
    r = client.post("/events", headers=auth(b), json={
        "name": "body_shared", "essay_id": str(uuid.uuid4()), "share_method": "share_sheet"})
    assert r.status_code == 404 and r.json()["detail"] == "essay_not_found"
    assert events(owner, b) == []


def test_db_requires_record_type_and_placement(owner, make_user):
    a = make_user()
    for sql in ("insert into events (user_id, name) values (%s, 'record_started')",
                ("insert into events (user_id, name, record_type) "
                 "values (%s, 'record_saved', 'free')")):
        with pytest.raises(psycopg.errors.CheckViolation):
            owner.execute(sql, (a,))
