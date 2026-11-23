"""R30 주제별 글쓰기 제안 (H110 홈 카드, N130)."""

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai import AIError, AISuggest, AISuggestion, StubSuggestAI, get_suggest_ai
from app.main import app
from tests.conftest import TEST_URL
from tests.test_analysis import auth, save
from tests.test_materials import confirm


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


class CountingAI(StubSuggestAI):
    def __init__(self, mode="stub"):
        self.calls = []
        self.mode = mode

    async def suggest(self, topic, materials, min_materials):
        self.calls.append((topic, [m.id for m in materials]))
        if self.mode == "fail":
            raise AIError("simulated failure")
        if self.mode == "none":
            return AISuggest(None, 1, 1)
        if self.mode == "foreign":
            return AISuggest(AISuggestion("제목", "방향", "이유", ["not-a-given-id"] * 3), 1, 1)
        if self.mode == "late":
            with psycopg.connect(TEST_URL, autocommit=True) as c:
                c.execute("update ai_requests set status = 'timeout' "
                          "where kind = 'suggest' and status = 'running'")
        return await super().suggest(topic, materials, min_materials)


def use_ai(ai):
    app.dependency_overrides[get_suggest_ai] = lambda: ai
    return ai


def material(client, uid, title, topics=(1,)):
    rec = save(client, uid)
    return confirm(client, uid, rec["id"], title=title, topics=list(topics)).json()["id"]


def listing(client, uid):
    return client.get("/suggestions", headers=auth(uid)).json()


def row(owner, uid, topic=1):
    return owner.execute("select id, status from suggestions where user_id = %s "
                         "and topic_id = %s", (uid, topic)).fetchone()


# topics: 1 가족, 5 일상
def test_three_records_in_a_topic_make_a_suggestion(client, make_user, owner):
    a = make_user()
    ai = use_ai(CountingAI())
    material(client, a, "이사 첫날")
    material(client, a, "엄마와의 통화")
    assert listing(client, a) == {"computing": False, "suggestions": []}
    assert ai.calls == [] and row(owner, a) is None  # 2개는 기준 미만

    material(client, a, "혼자 아팠던 날")
    got = listing(client, a)
    (s,) = got["suggestions"]
    assert s["topic"] == {"id": 1, "name": "가족"} and s["title"] and s["direction"]
    assert len(s["materials"]) == 3 and {m["title"] for m in s["materials"]} == \
        {"이사 첫날", "엄마와의 통화", "혼자 아팠던 날"}
    assert client.get(f"/suggestions/{s['id']}", headers=auth(a)).json() == s
    # 서버가 알아서 하는 계산이라 하루 한도에서 빠짐 (분석 3회만)
    assert client.get("/me", headers=auth(a)).json()["ai_calls_today"] == 3


def test_unconfirmed_and_other_topics_do_not_count(client, make_user, owner):
    a = make_user()
    use_ai(CountingAI())
    material(client, a, "하나")
    material(client, a, "둘")
    material(client, a, "일상", topics=[5])
    save(client, a)  # AI 후보 (주제 가족), 보관 전
    assert row(owner, a) is None


def test_same_materials_do_not_call_the_ai_again(client, make_user, owner):
    a = make_user()
    ai = use_ai(CountingAI())
    for t in ("하나", "둘", "셋"):
        material(client, a, t)
    assert len(ai.calls) == 1
    other = material(client, a, "다른 주제", topics=[5])  # topic 5 only
    client.patch(f"/materials/{other}", headers=auth(a), json={"summary": "고침"})
    assert [c[0] for c in ai.calls] == ["가족"]  # 가족은 그대로라 다시 안 부름


def test_editing_a_material_recomputes(client, make_user):
    a = make_user()
    ai = use_ai(CountingAI())
    ids = [material(client, a, t) for t in ("하나", "둘", "셋")]
    client.patch(f"/materials/{ids[0]}", headers=auth(a), json={"summary": "고친 요약"})
    assert len(ai.calls) == 2 and listing(client, a)["suggestions"]


def test_moving_a_topic_recomputes_both(client, make_user, owner):
    a = make_user()
    ai = use_ai(CountingAI())
    ids = [material(client, a, t) for t in ("하나", "둘", "셋")]
    for t in ("일상1", "일상2"):
        material(client, a, t, topics=[5])
    assert row(owner, a, 5) is None

    client.patch(f"/materials/{ids[0]}", headers=auth(a), json={"topics": [5]})
    assert row(owner, a, 1) is None  # 가족 2개 → 제안 없어짐
    assert row(owner, a, 5)["status"] == "ready"  # 일상 3개 → 새 제안
    assert ai.calls[-1][0] == "일상"


def test_deleting_a_material_removes_the_suggestion(client, make_user, owner):
    a = make_user()
    use_ai(CountingAI())
    ids = [material(client, a, t) for t in ("하나", "둘", "셋")]
    assert row(owner, a)["status"] == "ready"
    client.delete(f"/materials/{ids[1]}", headers=auth(a))
    assert row(owner, a) is None and listing(client, a)["suggestions"] == []


@pytest.mark.parametrize("mode,status", [("none", "none"), ("fail", "failed"),
                                         ("foreign", "failed"), ("late", "failed")])
def test_no_card_unless_ready(client, make_user, owner, mode, status):
    a = make_user()
    use_ai(CountingAI(mode))
    for t in ("하나", "둘", "셋"):
        material(client, a, t)
    assert row(owner, a)["status"] == status
    assert listing(client, a) == {"computing": False, "suggestions": []}


def test_failed_is_retried_on_the_next_change(client, make_user, owner):
    a = make_user()
    use_ai(CountingAI("fail"))
    for t in ("하나", "둘", "셋"):
        material(client, a, t)
    assert row(owner, a)["status"] == "failed"
    use_ai(CountingAI())
    material(client, a, "넷")  # 다음 소재 보관 때 다시 시도
    assert row(owner, a)["status"] == "ready"


def test_suggestion_is_mine_only(client, make_user):
    a, b = make_user(), make_user()
    use_ai(CountingAI())
    for t in ("하나", "둘", "셋"):
        material(client, a, t)
    s = listing(client, a)["suggestions"][0]
    assert client.get(f"/suggestions/{s['id']}", headers=auth(b)).status_code == 404
    assert listing(client, b)["suggestions"] == []


def test_clear_all_removes_suggestions(client, make_user, owner):
    a = make_user()
    use_ai(CountingAI())
    for t in ("하나", "둘", "셋"):
        material(client, a, t)
    client.delete("/me/data", headers=auth(a))
    assert row(owner, a) is None
