"""R32 사용자별 하루 AI 호출 한도."""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from tests.test_analysis import auth, save
from tests.test_materials import confirm
from tests.test_qna import reply, start


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def limit(monkeypatch):
    def _set(n):
        monkeypatch.setattr(get_settings(), "ai_daily_limit", n)
    return _set


def calls(owner, uid):
    row = owner.execute("select calls from ai_usage where user_id = %s", (uid,)).fetchone()
    return row["calls"] if row else 0


def test_qna_stops_asking_at_the_limit_but_keeps_the_answer(client, make_user, owner, limit):
    limit(2)
    a = make_user()
    st = start(client, a)  # call 1
    st = reply(client, a, st)  # call 2
    assert st["pending_question"] is not None and not st["daily_limit_reached"]

    st = reply(client, a, st, answer="세 번째 답")  # over the limit
    assert st["daily_limit_reached"] and not st["ai_failed"]
    assert st["pending_question"] is None and st["answer_count"] == 3  # answer kept
    assert st["can_save"]  # 소재로 저장은 그대로 가능

    again = client.post(f"/qna/{st['record_id']}/next", headers=auth(a)).json()
    assert again["daily_limit_reached"] and again["pending_question"] is None
    assert calls(owner, a) == 2  # refused calls are not counted
    n = owner.execute("select count(*) n from ai_requests where user_id = %s and kind = "
                      "'question'", (a,)).fetchone()["n"]
    assert n == 2  # and no AI request was recorded


def test_replace_at_the_limit_keeps_the_question(client, make_user, limit):
    limit(2)
    a = make_user()
    st = reply(client, a, start(client, a))
    pending = st["pending_question"]
    r = client.post(f"/qna/{st['record_id']}/replace", headers=auth(a),
                    json={"question_id": pending["id"]}).json()
    assert r["daily_limit_reached"] and r["pending_question"]["id"] == pending["id"]
    assert r["replace_left"] == 6


def test_save_at_the_limit_saves_but_does_not_analyse(client, make_user, owner, limit):
    limit(0)
    a = make_user()
    rec = save(client, a)
    assert rec["status"] == "saved" and rec["analysis_status"] == "failed"

    st = client.get(f"/records/{rec['id']}/analysis", headers=auth(a)).json()
    assert st["analysis_status"] == "failed" and st["daily_limit_reached"]
    r = client.post(f"/records/{rec['id']}/analysis", headers=auth(a))
    assert r.status_code == 429 and r.json()["detail"] == "daily_limit"
    assert owner.execute("select count(*) n from ai_requests where user_id = %s",
                         (a,)).fetchone()["n"] == 0

    limit(50)  # next day / higher limit: [다시 분석] works
    assert client.post(f"/records/{rec['id']}/analysis", headers=auth(a)).status_code == 202


def test_material_reanalyze_at_the_limit(client, make_user, limit):
    a = make_user()
    rec = save(client, a)
    m = confirm(client, a, rec["id"]).json()
    limit(1)  # the save's analysis used today's only call
    r = client.post(f"/materials/{m['id']}/reanalyze", headers=auth(a))
    assert r.status_code == 429 and r.json()["detail"] == "daily_limit"


def test_me_shows_usage_and_clearing_data_does_not_reset_it(client, make_user, limit):
    limit(3)
    a, b = make_user(), make_user()
    save(client, a)
    save(client, a)
    me = client.get("/me", headers=auth(a)).json()
    assert (me["ai_calls_today"], me["ai_daily_limit"], me["daily_limit_reached"]) == \
        (2, 3, False)

    client.delete("/me/data", headers=auth(a))
    assert client.get("/me", headers=auth(a)).json()["ai_calls_today"] == 2
    assert client.get("/me", headers=auth(b)).json()["ai_calls_today"] == 0  # per user

    save(client, a)
    assert client.get("/me", headers=auth(a)).json()["daily_limit_reached"]


# ---------------------------------------------------------------------------
# 시연 계정 (rec, guest): 따로 높은 한도
# ---------------------------------------------------------------------------
def test_demo_accounts_get_their_own_limit(client, make_user, owner, limit, monkeypatch):
    limit(1)
    demo, normal = make_user(), make_user()
    monkeypatch.setattr(get_settings(), "demo_user_ids", f" {str(demo).upper()} , other-id")
    monkeypatch.setattr(get_settings(), "ai_daily_limit_demo", 3)

    me = client.get("/me", headers=auth(demo)).json()
    assert me["ai_daily_limit"] == 3
    assert client.get("/me", headers=auth(normal)).json()["ai_daily_limit"] == 1

    st = reply(client, demo, start(client, demo))  # 2 calls, over the normal limit of 1
    assert not st["daily_limit_reached"] and st["pending_question"] is not None
    assert calls(owner, demo) == 2

    st = reply(client, normal, start(client, normal))  # the normal user stops at 1
    assert st["daily_limit_reached"]
