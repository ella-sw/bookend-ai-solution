"""R29 관련 소재 추천 (N110 '함께 쓰면 좋은 소재')."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.test_analysis import auth, save
from tests.test_materials import confirm


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def make(client, uid, title, topics, keywords):
    rec = save(client, uid)
    return confirm(client, uid, rec["id"], title=title, topics=topics,
                   keywords=keywords).json()["id"]


def related(client, uid, *ids, **params):
    return client.get("/materials/related", headers=auth(uid),
                      params={"selected": list(ids), **params})


# topics: 1 가족, 4 일·직업, 5 일상, 7 음식
def test_ranked_by_shared_keywords_then_topics(client, make_user):
    a = make_user()
    picked = make(client, a, "엄마 반찬", [1, 7], ["엄마", "반찬"])
    topic_only = make(client, a, "가족 여행", [1], ["바다"])
    keyword_only = make(client, a, "회사 점심", [4], [" 반찬 "])
    both = make(client, a, "엄마 생일", [1], ["엄마"])
    make(client, a, "출근길", [4], ["지하철"])  # nothing shared

    r = related(client, a, picked)
    assert r.status_code == 200
    got = r.json()
    assert [m["id"] for m in got] == [both, keyword_only, topic_only]  # 3, 2, 1 points
    assert got[0]["shared_topics"] == ["가족"] and got[0]["shared_keywords"] == ["엄마"]
    assert got[1]["shared_topics"] == [] and got[1]["shared_keywords"] == ["반찬"]
    assert {"id": 1, "name": "가족"} in got[0]["topics"]


def test_selected_deleted_and_unconfirmed_are_left_out(client, make_user):
    a = make_user()
    m1 = make(client, a, "하나", [1], ["엄마"])
    m2 = make(client, a, "둘", [1], ["엄마"])
    gone = make(client, a, "지운 것", [1], ["엄마"])
    client.delete(f"/materials/{gone}", headers=auth(a))
    save(client, a)  # AI candidate with topic 가족, not confirmed

    assert [m["id"] for m in related(client, a, m1).json()] == [m2]
    assert related(client, a, m1, m2).json() == []  # both selected


def test_limit_and_empty_selection(client, make_user):
    a = make_user()
    picked = make(client, a, "기준", [5], [])
    for i in range(4):
        make(client, a, f"일상 {i}", [5], [])
    assert len(related(client, a, picked, limit=2).json()) == 2
    assert related(client, a).json() == []


def test_selected_must_be_my_usable_material(client, make_user):
    a, b = make_user(), make_user()
    mine = make(client, a, "A", [1], ["엄마"])
    make(client, b, "B", [1], ["엄마"])
    assert related(client, b, mine).status_code == 404  # A's material
    assert related(client, a, mine).json() == []  # B's materials never show
