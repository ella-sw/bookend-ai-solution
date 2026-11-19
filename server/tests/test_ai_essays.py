"""R07 AI 초안·다시 만들기, R08 다시 만든 결과 저장 (W310–W341)."""

import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai import AIError, AIEssay, StubEssayAI, get_essay_ai
from app.config import get_settings
from app.main import app
from tests.conftest import TEST_URL
from tests.test_analysis import auth, save
from tests.test_materials import confirm


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


class RecordingAI(StubEssayAI):
    """Stub that remembers what it was given; optional fixed body lengths per call."""

    def __init__(self, lengths=None, fail=False, timeout_during=False):
        self.inputs = []
        self.lengths = list(lengths or [])
        self.fail = fail
        self.timeout_during = timeout_during

    async def write_essay(self, inp):
        self.inputs.append(inp)
        if self.fail:
            raise AIError("simulated failure")
        if self.timeout_during:
            with psycopg.connect(TEST_URL, autocommit=True) as c:
                c.execute("update ai_requests set status = 'timeout' where status = 'running'")
        if self.lengths:
            return AIEssay("고정 제목", "가" * self.lengths.pop(0), 5, 7)
        return await super().write_essay(inp)


def use_ai(ai):
    app.dependency_overrides[get_essay_ai] = lambda: ai
    return ai


def tok():
    return str(uuid.uuid4())


def material(client, uid, body="오늘 엄마랑 오랜만에 통화했다. 목소리가 밝아서 마음이 놓였다.",
             title="엄마와 통화"):
    rec = save(client, uid, body=body)
    return confirm(client, uid, rec["id"], title=title).json()["id"]


def draft(client, uid, ids, **body):
    data = {"material_ids": ids, "style": "감성적", "length": "short", "save_token": tok(),
            **body}
    return client.post("/essays/ai", headers=auth(uid), json=data)


def count(owner, sql, *args):
    return owner.execute(sql, args).fetchone()["n"]


# ---------------------------------------------------------------------------
# W330 처음 만들기
# ---------------------------------------------------------------------------
def test_first_draft_is_kept_as_version_zero(client, make_user, owner):
    a = make_user()
    m1, m2 = material(client, a, title="하나"), material(client, a, title="둘")
    ai = use_ai(RecordingAI())

    r = draft(client, a, [m2, m1], direction="멀리 있어 더 또렷해진 마음", style="담백함")
    assert r.status_code == 201
    e = r.json()
    assert e["method"] == "ai" and e["direction"] == "멀리 있어 더 또렷해진 마음"
    assert [m["title"] for m in e["materials"]] == ["둘", "하나"]
    (v,) = e["versions"]
    assert (v["label"], v["kind"], v["style"], v["length"]) == ("초안", "ai_first", "담백함", "short")
    assert 300 <= v["char_count"] <= 500 and v["in_length_range"] is True

    sent = ai.inputs[0]
    assert [m.title for m in sent.materials] == ["둘", "하나"]  # 고른 순서
    assert (sent.min_chars, sent.max_chars, sent.style) == (300, 500, "담백함")

    gi = owner.execute("select generation_input from essay_versions where essay_id = %s",
                       (e["id"],)).fetchone()["generation_input"]
    assert [x["id"] for x in gi["materials"]] == [m2, m1] and gi["direction"]
    # 초안 자동 보관은 '사용자 글 저장'이 아님 (R33)
    assert count(owner, "select count(*) n from events where user_id = %s "
                        "and name = 'essay_saved'", a) == 0
    assert client.get("/essays", headers=auth(a)).json()[0]["state"] == "초안"


def test_original_is_cut_at_1500_characters(client, make_user):
    a = make_user()
    m = material(client, a, body="첫 문장이다. " + "가" * 3000)
    ai = use_ai(RecordingAI())
    draft(client, a, [m])
    assert len(ai.inputs[0].materials[0].original) == 1500


def test_same_token_makes_one_draft(client, make_user, owner):
    a = make_user()
    m = material(client, a)
    ai = use_ai(RecordingAI())
    body = {"material_ids": [m], "style": "감성적", "length": "long", "save_token": tok()}
    r1 = client.post("/essays/ai", headers=auth(a), json=body)
    r2 = client.post("/essays/ai", headers=auth(a), json=body)
    assert r1.status_code == 201 and r2.status_code == 200
    assert r2.json()["id"] == r1.json()["id"] and len(ai.inputs) == 1


def test_out_of_range_retries_once(client, make_user, owner):
    a = make_user()
    m = material(client, a)
    ai = use_ai(RecordingAI(lengths=[800, 420]))
    v = draft(client, a, [m]).json()["versions"][0]
    assert v["char_count"] == 420 and v["in_length_range"]
    assert len(ai.inputs) == 2 and ai.inputs[1].last_char_count == 800
    req = owner.execute("select status, input_tokens, output_tokens from ai_requests "
                        "where user_id = %s and kind = 'draft'", (a,)).fetchall()
    assert req == [{"status": "ok", "input_tokens": 10, "output_tokens": 14}]  # one request
    assert client.get("/me", headers=auth(a)).json()["ai_calls_today"] == 2  # analysis + draft


def test_still_out_of_range_is_shown_with_real_count(client, make_user):
    a = make_user()
    m = material(client, a)
    use_ai(RecordingAI(lengths=[800, 700]))
    v = draft(client, a, [m]).json()["versions"][0]
    assert v["char_count"] == 700 and v["in_length_range"] is False


@pytest.mark.parametrize("ai", [RecordingAI(fail=True), RecordingAI(timeout_during=True)])
def test_failure_saves_nothing(client, make_user, owner, ai):
    a = make_user()
    m = material(client, a)
    use_ai(ai)
    r = draft(client, a, [m])
    assert r.status_code == 502 and r.json()["detail"] == "ai_failed"
    assert client.get("/essays", headers=auth(a)).json() == []
    st = owner.execute("select status from ai_requests where user_id = %s and kind = 'draft'",
                       (a,)).fetchone()["status"]
    assert st in ("failed", "discarded")


def test_needs_usable_materials(client, make_user):
    a = make_user()
    m = material(client, a)
    client.delete(f"/materials/{m}", headers=auth(a))
    assert draft(client, a, []).status_code == 422  # 소재 0개면 AI 초안 막음
    r = draft(client, a, [m])
    assert r.status_code == 422 and r.json()["detail"] == "material_not_available"


def test_daily_limit(client, make_user, monkeypatch):
    a = make_user()
    m = material(client, a)  # its analysis used 1 call
    monkeypatch.setattr(get_settings(), "ai_daily_limit", 1)
    r = draft(client, a, [m])
    assert r.status_code == 429 and r.json()["detail"] == "daily_limit"


# ---------------------------------------------------------------------------
# W340 다시 만들기 → W341 저장
# ---------------------------------------------------------------------------
def test_regenerate_twice_then_save(client, make_user, owner):
    a = make_user()
    m = material(client, a)
    ai = use_ai(RecordingAI())
    e = draft(client, a, [m]).json()
    v0 = e["versions"][0]

    r1 = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a),
                     json={"based_on_version_id": v0["id"], "style": "담백함", "length": "long"})
    assert r1.status_code == 200
    one = r1.json()
    assert one["regen_count"] == 1 and one["based_on_version_id"] == v0["id"]
    assert 1000 <= one["char_count"] <= 1500 and one["in_length_range"]
    assert ai.inputs[-1].base_body == v0["body"]  # 보고 있던 글이 바탕
    assert len(client.get(f"/essays/{e['id']}", headers=auth(a)).json()["versions"]) == 1

    r2 = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a), json={
        "based_on_request_id": one["request_id"], "style": "담백함", "length": "long"}).json()
    assert r2["regen_count"] == 2 and ai.inputs[-1].base_body == one["body"]

    t = tok()
    s = client.post(f"/essays/{e['id']}/regenerations/{r2['request_id']}/save",
                    headers=auth(a), json={"save_token": t})
    assert s.status_code == 201
    vs = s.json()["versions"]
    assert [v["label"] for v in vs] == ["초안", "v1"]  # 초안 다음 첫 저장은 v1
    assert (vs[1]["kind"], vs[1]["regen_count"], vs[1]["body"]) == ("ai_regen", 2, r2["body"])
    assert count(owner, "select count(*) n from events where user_id = %s "
                        "and name = 'essay_saved'", a) == 1
    assert owner.execute("select result from ai_requests where id = %s",
                         (r2["request_id"],)).fetchone()["result"] is None  # ERD 12

    again = client.post(f"/essays/{e['id']}/regenerations/{r2['request_id']}/save",
                        headers=auth(a), json={"save_token": t})
    assert again.status_code == 200 and len(again.json()["versions"]) == 2
    other = client.post(f"/essays/{e['id']}/regenerations/{r2['request_id']}/save",
                        headers=auth(a), json={"save_token": tok()})
    assert other.status_code == 409 and other.json()["detail"] == "no_result"


def test_regenerate_a_direct_essay(client, make_user):
    a = make_user()
    use_ai(RecordingAI())
    e = client.post("/essays", headers=auth(a), json={
        "title": "직접 쓴 글", "body": "내가 쓴 본문이다.", "save_token": tok()}).json()
    r = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a), json={
        "based_on_version_id": e["versions"][0]["id"], "style": "감성적", "length": "short"})
    assert r.status_code == 200
    s = client.post(f"/essays/{e['id']}/regenerations/{r.json()['request_id']}/save",
                    headers=auth(a), json={"save_token": tok()}).json()
    assert [v["label"] for v in s["versions"]] == ["v1", "v2"] and s["method"] == "direct"


def test_deleted_material_is_not_sent_again(client, make_user):
    a = make_user()
    keep, gone = material(client, a, title="남은 소재"), material(client, a, title="지운 소재")
    ai = use_ai(RecordingAI())
    e = draft(client, a, [keep, gone]).json()
    client.delete(f"/materials/{gone}", headers=auth(a))

    r = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a), json={
        "based_on_version_id": e["versions"][0]["id"], "style": "감성적", "length": "short"})
    assert [m.title for m in ai.inputs[-1].materials] == ["남은 소재"]
    assert r.json()["deleted_materials_left_out"] is True


def test_regenerate_needs_exactly_one_base(client, make_user):
    a = make_user()
    m = material(client, a)
    use_ai(RecordingAI())
    e = draft(client, a, [m]).json()
    for body in ({}, {"based_on_version_id": e["versions"][0]["id"], "based_on_request_id": 1}):
        r = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a),
                        json={**body, "style": "감성적", "length": "short"})
        assert r.status_code == 422


def test_other_user_cannot_regenerate_or_save(client, make_user):
    a, b = make_user(), make_user()
    m = material(client, a)
    use_ai(RecordingAI())
    e = draft(client, a, [m]).json()
    r = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a), json={
        "based_on_version_id": e["versions"][0]["id"], "style": "감성적", "length": "short"}).json()

    assert client.post(f"/essays/{e['id']}/regenerate", headers=auth(b), json={
        "based_on_version_id": e["versions"][0]["id"], "style": "감성적",
        "length": "short"}).status_code == 404
    assert client.post(f"/essays/{e['id']}/regenerations/{r['request_id']}/save",
                       headers=auth(b), json={"save_token": tok()}).status_code == 404
    assert draft(client, b, [m]).status_code == 422  # A's material


# ---------------------------------------------------------------------------
# L121 이 버전 지우기 (AI 글)
# ---------------------------------------------------------------------------
def test_draft_version_cannot_be_deleted(client, make_user):
    a = make_user()
    m = material(client, a)
    use_ai(RecordingAI())
    e = draft(client, a, [m]).json()
    v0 = e["versions"][0]
    r = client.delete(f"/essays/{e['id']}/versions/{v0['id']}", headers=auth(a))
    assert r.status_code == 409 and r.json()["detail"] == "version_not_deletable"


def test_result_based_on_deleted_version_cannot_be_saved(client, make_user):
    a = make_user()
    m = material(client, a)
    use_ai(RecordingAI())
    e = draft(client, a, [m]).json()
    v0 = e["versions"][0]
    one = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a), json={
        "based_on_version_id": v0["id"], "style": "감성적", "length": "short"}).json()
    v1 = client.post(f"/essays/{e['id']}/regenerations/{one['request_id']}/save",
                     headers=auth(a), json={"save_token": tok()}).json()["versions"][1]

    # an unsaved result based on v1, then v1 is deleted (e.g. in another tab)
    r = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a), json={
        "based_on_version_id": v1["id"], "style": "감성적", "length": "short"}).json()
    assert client.delete(f"/essays/{e['id']}/versions/{v1['id']}",
                         headers=auth(a)).status_code == 200

    s = client.post(f"/essays/{e['id']}/regenerations/{r['request_id']}/save",
                    headers=auth(a), json={"save_token": tok()})
    assert s.status_code == 404 and s.json()["detail"] == "version_not_found"
    again = client.post(f"/essays/{e['id']}/regenerate", headers=auth(a), json={
        "based_on_request_id": r["request_id"], "style": "감성적", "length": "short"})
    assert again.status_code == 404 and again.json()["detail"] == "version_not_found"


def test_material_deleted_during_the_ai_call(client, make_user, owner):
    """AI가 쓰는 동안 소재가 지워지면 (M131) 글을 만들지 않고 422 material_not_available."""
    a = make_user()
    m = material(client, a)

    class DeletingAI(RecordingAI):
        async def write_essay(self, inp):
            with psycopg.connect(TEST_URL, autocommit=True) as c:  # unused → record deleted
                c.execute("delete from records where id = "
                          "(select record_id from materials where id = %s)", (m,))
            return await super().write_essay(inp)

    use_ai(DeletingAI())
    r = draft(client, a, [m])
    assert r.status_code == 422 and r.json()["detail"] == "material_not_available"
    assert count(owner, "select count(*) n from essays where user_id = %s", a) == 0
    assert count(owner, "select count(*) n from ai_requests where user_id = %s "
                        "and kind = 'draft' and status = 'discarded'", a) == 1

