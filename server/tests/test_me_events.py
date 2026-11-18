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
        "material_count, entry_path, share_method from events where user_id = %s "
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
        {"name": "record_started"},
        {"name": "record_started", "record_id": draft["id"]},
        {"name": "writing_started", "write_mode": "ai", "entry_path": "suggestion",
         "material_count": 3, "suggestion_id": sug},
        {"name": "suggestion_shown", "suggestion_id": sug},
        {"name": "suggestion_selected", "suggestion_id": sug},
        {"name": "body_shared", "essay_id": essay, "share_method": "copy"},
    ]
    for e in sent:
        r = client.post("/events", headers=auth(a), json=e)
        assert r.status_code == 204, r.text

    got = events(owner, a)
    assert [e["name"] for e in got] == [e["name"] for e in sent]
    assert got[1]["record_id"] == draft["id"]
    assert (got[2]["write_mode"], got[2]["entry_path"], got[2]["material_count"]) == \
        ("ai", "suggestion", 3)
    assert got[5]["share_method"] == "copy" and got[5]["essay_id"] == essay


@pytest.mark.parametrize("body,detail", [
    ({"name": "writing_started", "write_mode": "direct", "entry_path": "home"},
     "missing_field: material_count"),
    ({"name": "body_shared", "share_method": "copy"}, "missing_field: essay_id"),
    ({"name": "suggestion_shown", "suggestion_id": str(uuid.uuid4()), "share_method": "copy"},
     "unexpected_field: share_method"),
])
def test_event_field_rules(client, make_user, body, detail):
    r = client.post("/events", headers=auth(make_user()), json=body)
    assert r.status_code == 422 and r.json()["detail"] == detail


@pytest.mark.parametrize("name", ["record_saved", "material_confirmed", "essay_saved", "hack"])
def test_server_only_or_unknown_events_are_rejected(client, make_user, name):
    assert client.post("/events", headers=auth(make_user()),
                       json={"name": name}).status_code == 422


def test_event_ids_must_be_mine(client, make_user, owner):
    a, b = make_user(), make_user()
    rec = save(client, a)
    r = client.post("/events", headers=auth(b), json={"name": "record_started",
                                                      "record_id": rec["id"]})
    assert r.status_code == 404 and r.json()["detail"] == "record_not_found"
    r = client.post("/events", headers=auth(b), json={
        "name": "body_shared", "essay_id": str(uuid.uuid4()), "share_method": "share_sheet"})
    assert r.status_code == 404 and r.json()["detail"] == "essay_not_found"
    assert events(owner, b) == []
