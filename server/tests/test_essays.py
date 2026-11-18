"""R07 직접 쓰기 · R08 버전 저장 · R10 내 서재."""

import uuid

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


def tok():
    return str(uuid.uuid4())


def material(client, uid, title="엄마와 통화"):
    rec = save(client, uid)
    return confirm(client, uid, rec["id"], title=title).json()


def first_save(client, uid, **body):
    data = {"title": "멀리 있어 더 또렷해진 것들", "body": "본문입니다.", "save_token": tok(),
            **body}
    return client.post("/essays", headers=auth(uid), json=data)


def saved_events(owner, uid):
    return owner.execute(
        "select essay_id::text, write_mode, material_count from events "
        "where user_id = %s and name = 'essay_saved' order by id", (uid,)).fetchall()


# ---------------------------------------------------------------------------
# N140 직접 쓰기: 임시 저장 → 첫 저장 v1
# ---------------------------------------------------------------------------
def test_draft_then_first_save_is_v1(client, make_user, owner):
    a = make_user()
    m1, m2 = material(client, a, "하나"), material(client, a, "둘")
    assert client.get("/essays/draft", headers=auth(a)).status_code == 404

    d = client.post("/essays/draft", headers=auth(a), json={
        "title": "", "body": "", "direction": "가족의 마음",
        "material_ids": [m2["id"], m1["id"]]}).json()
    assert d["body"] == "" and d["title"] is None
    assert [m["title"] for m in d["materials"]] == ["둘", "하나"]  # 고른 순서

    d2 = client.post("/essays/draft", headers=auth(a), json={
        "essay_id": d["id"], "body": "쓰는 중", "material_ids": [m2["id"], m1["id"]]}).json()
    assert d2["id"] == d["id"] and d2["body"] == "쓰는 중"

    r = first_save(client, a, essay_id=d["id"], body="다 썼다", material_ids=[m2["id"], m1["id"]])
    assert r.status_code == 201
    e = r.json()
    assert e["id"] == d["id"] and e["method"] == "direct"
    assert [(v["label"], v["kind"], v["char_count"]) for v in e["versions"]] == \
        [("v1", "direct_first", 4)]  # 직접 쓴 글에는 초안이 없다, 공백 포함
    assert e["title"] == "멀리 있어 더 또렷해진 것들"
    assert client.get("/essays/draft", headers=auth(a)).status_code == 404
    assert saved_events(owner, a) == [{"essay_id": e["id"], "write_mode": "direct",
                                       "material_count": 2}]


def test_one_draft_per_user(client, make_user):
    a = make_user()
    first = client.post("/essays/draft", headers=auth(a), json={"body": "처음"}).json()
    second = client.post("/essays/draft", headers=auth(a), json={"body": "새로"}).json()
    assert second["id"] == first["id"] and second["body"] == "새로"


def test_first_save_without_materials(client, make_user):
    """[소재 없이 직접 쓰기]"""
    a = make_user()
    e = first_save(client, a, title="").json()
    assert e["materials"] == [] and e["title"] is None and e["versions"][0]["label"] == "v1"


def test_first_save_retry_makes_one_essay(client, make_user, owner):
    a = make_user()
    body = {"title": "제목", "body": "본문", "save_token": tok()}
    r1 = client.post("/essays", headers=auth(a), json=body)
    r2 = client.post("/essays", headers=auth(a), json=body)
    assert r1.status_code == 201 and r2.status_code == 200
    assert r2.json()["id"] == r1.json()["id"]
    n = owner.execute("select count(*) n from essays where user_id = %s", (a,)).fetchone()["n"]
    assert n == 1 and len(saved_events(owner, a)) == 1


def test_saving_a_draft_already_saved_returns_it(client, make_user):
    a = make_user()
    d = client.post("/essays/draft", headers=auth(a), json={"body": "x"}).json()
    first_save(client, a, essay_id=d["id"])
    r = first_save(client, a, essay_id=d["id"])  # another tab, new token
    assert r.status_code == 200 and len(r.json()["versions"]) == 1


@pytest.mark.parametrize("body", ["", "   \n"])
def test_empty_body_cannot_be_saved(client, make_user, body):
    assert first_save(client, make_user(), body=body).status_code == 422


def test_deleted_or_unconfirmed_material_cannot_be_used(client, make_user):
    a = make_user()
    m = material(client, a)
    client.delete(f"/materials/{m['id']}", headers=auth(a))
    r = first_save(client, a, material_ids=[m["id"]])
    assert r.status_code == 422 and r.json()["detail"] == "material_not_available"

    rec = save(client, a)  # candidate only, not confirmed
    cand = client.get(f"/records/{rec['id']}/analysis", headers=auth(a)).json()["material"]
    r = client.post("/essays/draft", headers=auth(a),
                    json={"body": "", "material_ids": [cand["id"]]})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# L122 덮어쓰기 / 새 버전
# ---------------------------------------------------------------------------
def test_new_version_and_overwrite(client, make_user, owner):
    a = make_user()
    e = first_save(client, a).json()
    v1 = e["versions"][0]

    data = {"title": "새 제목", "body": "고친 본문", "based_on_version_id": v1["id"],
            "save_token": tok()}
    r = client.post(f"/essays/{e['id']}/versions", headers=auth(a), json=data)
    assert r.status_code == 201
    e2 = r.json()
    assert [v["label"] for v in e2["versions"]] == ["v1", "v2"]
    assert e2["versions"][1]["kind"] == "direct_new" and e2["title"] == "새 제목"
    # retry → still two versions
    again = client.post(f"/essays/{e['id']}/versions", headers=auth(a), json=data)
    assert again.status_code == 200 and len(again.json()["versions"]) == 2

    # overwrite v1: old text is gone, title copy follows the latest (v2)
    r = client.put(f"/essays/{e['id']}/versions/{v1['id']}", headers=auth(a),
                   json={"title": "v1 새 제목", "body": "덮어쓴 본문"})
    assert r.status_code == 200
    vs = r.json()["versions"]
    assert vs[0]["body"] == "덮어쓴 본문" and vs[0]["char_count"] == 6
    assert len(vs) == 2 and r.json()["title"] == "새 제목"
    assert len(saved_events(owner, a)) == 3  # 첫 저장, 새 버전, 덮어쓰기


def test_overwrite_latest_updates_title_copy(client, make_user):
    a = make_user()
    e = first_save(client, a).json()
    r = client.put(f"/essays/{e['id']}/versions/{e['versions'][0]['id']}", headers=auth(a),
                   json={"title": "바뀐 제목", "body": "본문"})
    assert r.json()["title"] == "바뀐 제목"


def test_version_must_belong_to_essay(client, make_user):
    a = make_user()
    e1, e2 = first_save(client, a).json(), first_save(client, a).json()
    other_v = e2["versions"][0]["id"]
    assert client.put(f"/essays/{e1['id']}/versions/{other_v}", headers=auth(a),
                      json={"body": "x"}).status_code == 404
    assert client.post(f"/essays/{e1['id']}/versions", headers=auth(a), json={
        "body": "x", "based_on_version_id": other_v, "save_token": tok()}).status_code == 404


# ---------------------------------------------------------------------------
# L110 내 서재 / L120 상세 / L121 삭제
# ---------------------------------------------------------------------------
def test_library_order_and_states(client, make_user):
    a = make_user()
    m = material(client, a)
    old = first_save(client, a, title="오래된 글").json()
    newer = first_save(client, a, title="새 글", material_ids=[m["id"]]).json()
    client.post(f"/essays/{newer['id']}/versions", headers=auth(a), json={
        "body": "v2", "based_on_version_id": newer["versions"][0]["id"], "save_token": tok()})
    draft = client.post("/essays/draft", headers=auth(a), json={"body": "임시"}).json()

    cards = client.get("/essays", headers=auth(a)).json()
    assert [c["id"] for c in cards] == [draft["id"], newer["id"], old["id"]]
    assert [c["state"] for c in cards] == ["임시 저장", "v2", "v1"]
    assert cards[1]["material_count"] == 1 and cards[1]["method"] == "direct"


def test_detail_marks_deleted_material(client, make_user):
    a = make_user()
    m = material(client, a)
    e = first_save(client, a, material_ids=[m["id"]]).json()
    client.delete(f"/materials/{m['id']}", headers=auth(a))
    d = client.get(f"/essays/{e['id']}", headers=auth(a)).json()
    assert d["materials"][0]["id"] == m["id"] and d["materials"][0]["deleted"] is True


def test_delete_essay_keeps_materials(client, make_user, owner):
    a = make_user()
    m = material(client, a)
    e = first_save(client, a, material_ids=[m["id"]]).json()
    assert client.delete(f"/essays/{e['id']}", headers=auth(a)).status_code == 204
    assert client.get(f"/essays/{e['id']}", headers=auth(a)).status_code == 404
    left = owner.execute("select (select count(*) from essay_versions where essay_id = %(e)s) "
                         "+ (select count(*) from essay_materials where essay_id = %(e)s) n",
                         {"e": e["id"]}).fetchone()["n"]
    assert left == 0
    assert client.get(f"/materials/{m['id']}", headers=auth(a)).status_code == 200
    ev = owner.execute("select essay_id from events where user_id = %s and name = 'essay_saved'",
                       (a,)).fetchone()
    assert ev["essay_id"] is None  # event kept, link cleared


def test_material_detail_lists_the_essay(client, make_user):
    a = make_user()
    m = material(client, a)
    e = first_save(client, a, material_ids=[m["id"]]).json()
    d = client.get(f"/materials/{m['id']}", headers=auth(a)).json()
    assert d["essays"] == [{"id": e["id"], "title": e["title"]}]


# ---------------------------------------------------------------------------
# 접근
# ---------------------------------------------------------------------------
def test_other_user_cannot_touch_essays(client, make_user):
    a, b = make_user(), make_user()
    m = material(client, a)
    e = first_save(client, a).json()
    d = client.post("/essays/draft", headers=auth(a), json={"body": "A"}).json()
    v = e["versions"][0]["id"]

    assert client.get(f"/essays/{e['id']}", headers=auth(b)).status_code == 404
    assert client.put(f"/essays/{e['id']}/versions/{v}", headers=auth(b),
                      json={"body": "x"}).status_code == 404
    assert client.post(f"/essays/{e['id']}/versions", headers=auth(b), json={
        "body": "x", "based_on_version_id": v, "save_token": tok()}).status_code == 404
    assert client.delete(f"/essays/{e['id']}", headers=auth(b)).status_code == 404
    assert client.post("/essays/draft", headers=auth(b), json={
        "essay_id": d["id"], "body": "x"}).status_code == 404
    assert first_save(client, b, material_ids=[m["id"]]).status_code == 422  # A's material
    assert client.get("/essays", headers=auth(b)).json() == []


def test_save_token_of_another_user(client, make_user):
    a, b = make_user(), make_user()
    t = tok()
    first_save(client, a, save_token=t)
    r = first_save(client, b, save_token=t)
    assert r.status_code == 409 and r.json()["detail"] == "save_token_used"
    assert client.get("/essays", headers=auth(b)).json() == []  # nothing half-saved
