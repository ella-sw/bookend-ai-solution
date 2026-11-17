"""R28 소재 분석 API (M120 소재 확인, M130 보관한 원본)."""

import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai import (
    AIError,
    AIExtract,
    ExtractedMaterial,
    ExtractSource,
    StubMaterialAI,
    get_material_ai,
)
from app.analysis import validate_material
from app.main import app
from tests.conftest import TEST_URL, token_for
from tests.test_qna import reply, start

TEXT = "오늘 엄마랑 오랜만에 통화했다. 목소리가 밝아서 마음이 놓였다."


class FailingAI(StubMaterialAI):
    async def extract_material(self, source, topics):
        raise AIError("simulated failure")


class FixedAI(StubMaterialAI):
    def __init__(self, material):
        self.material = material

    async def extract_material(self, source, topics):
        return AIExtract(self.material, 10, 20)


class LateAI(StubMaterialAI):
    """Returns a result, but only after the request was already timed out."""

    async def extract_material(self, source, topics):
        with psycopg.connect(TEST_URL, autocommit=True) as c:
            c.execute("update ai_requests set status = 'timeout' where status = 'running'")
        return await super().extract_material(source, topics)


class CapturingAI(StubMaterialAI):
    def __init__(self):
        self.sources: list[ExtractSource] = []

    async def extract_material(self, source, topics):
        self.sources.append(source)
        return await super().extract_material(source, topics)


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def use_ai(ai):
    app.dependency_overrides[get_material_ai] = lambda: ai


def auth(uid):
    return {"Authorization": f"Bearer {token_for(uid)}"}


def save(client, uid, body=TEXT):
    """Free writing [소재로 저장]. Background analysis runs before TestClient returns."""
    r = client.post("/records/free", headers=auth(uid),
                    json={"save_token": str(uuid.uuid4()), "body": body})
    assert r.status_code == 201, r.text
    return r.json()


def analysis(client, uid, record_id):
    return client.get(f"/records/{record_id}/analysis", headers=auth(uid))


def requests(owner, record_id):
    return owner.execute(
        "select status, failure_reason, result from ai_requests "
        "where kind = 'extract' and target_id = %s order by id",
        (record_id,),
    ).fetchall()


# ---------------------------------------------------------------------------
# 결과: 완료 / 소재 없음 / 실패
# ---------------------------------------------------------------------------
def test_save_starts_analysis_and_finds_material(client, make_user, owner):
    a = make_user()
    rec = save(client, a)
    assert rec["analysis_status"] == "analyzing"  # what the save response says

    st = analysis(client, a, rec["id"]).json()
    assert st["analysis_status"] == "done" and st["record_type"] == "free"
    m = st["material"]
    assert m["origin"] == "ai" and m["confirmed_at"] is None  # 후보, not in the 소재함 yet
    assert m["evidence"] == "오늘 엄마랑 오랜만에 통화했다." and m["summary"]
    assert {"id": 1, "name": "가족"} in m["topics"]
    assert st["can_reanalyze"] is False
    assert [r["status"] for r in requests(owner, rec["id"])] == ["ok"]


def test_nothing_to_write_about_is_empty(client, make_user):
    a = make_user()
    rec = save(client, a, body="그냥 그랬다")
    st = analysis(client, a, rec["id"]).json()
    assert st["analysis_status"] == "empty" and st["material"] is None
    # 소재 없음 has no [다시 분석]
    assert st["can_reanalyze"] is False
    r = client.post(f"/records/{rec['id']}/analysis", headers=auth(a))
    assert r.status_code == 409 and r.json()["detail"] == "cannot_reanalyze"


def test_failure_then_reanalyze(client, make_user, owner):
    a = make_user()
    use_ai(FailingAI())
    rec = save(client, a)
    st = analysis(client, a, rec["id"]).json()
    assert st["analysis_status"] == "failed" and st["can_reanalyze"] is True
    assert requests(owner, rec["id"])[0]["failure_reason"] == "simulated failure"

    use_ai(StubMaterialAI())
    r = client.post(f"/records/{rec['id']}/analysis", headers=auth(a))
    assert r.status_code == 202 and r.json()["analysis_status"] == "analyzing"
    assert analysis(client, a, rec["id"]).json()["analysis_status"] == "done"
    assert [x["status"] for x in requests(owner, rec["id"])] == ["failed", "ok"]


def test_save_succeeds_even_if_analysis_cannot_start(client, make_user, monkeypatch):
    """A 합의: 저장 뒤 분석 시작이 실패해도 저장은 성공, 상태는 failed."""
    async def boom(conn, record_id):
        raise RuntimeError("db hiccup")
    monkeypatch.setattr("app.analysis.start_analysis", boom)

    a = make_user()
    rec = save(client, a)
    assert rec["status"] == "saved" and rec["analysis_status"] == "failed"
    assert analysis(client, a, rec["id"]).json()["analysis_status"] == "failed"


# ---------------------------------------------------------------------------
# 서버 검사: 근거 문장은 원문에, 주제는 10개 목록에서
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("material", [
    ExtractedMaterial(summary="요약", evidence="원문에 없는 문장이다.", keywords=[], topics=["가족"]),
    ExtractedMaterial(summary="요약", evidence="오늘 엄마랑 오랜만에 통화했다.", keywords=[],
                      topics=["없는 주제"]),
    ExtractedMaterial(summary=" ", evidence="오늘 엄마랑 오랜만에 통화했다.", keywords=[],
                      topics=["가족"]),
])
def test_invalid_ai_result_is_a_failure(client, make_user, owner, material):
    a = make_user()
    use_ai(FixedAI(material))
    rec = save(client, a)
    st = analysis(client, a, rec["id"]).json()
    assert st["analysis_status"] == "failed" and st["material"] is None
    assert requests(owner, rec["id"])[0]["failure_reason"].startswith("invalid_result")


def test_validation_cleans_the_result():
    src = ExtractSource("free", None, "첫 줄이다.\n둘째   줄도\n있다.")
    out = validate_material(ExtractedMaterial(
        summary="  요약  ", evidence="둘째 줄도 있다.",  # whitespace differs from the text
        keywords=[" 엄마 ", "엄마", "", "통화"], topics=["가족", "모르는 주제", "가족"],
        title="  ",
    ), src, {"가족": 1, "일상": 5})
    assert out == {"title": None, "summary": "요약", "evidence": "둘째 줄도 있다.",
                   "keywords": ["엄마", "통화"], "topics": [1]}


# ---------------------------------------------------------------------------
# 요청 순서 보호, 60초 제한
# ---------------------------------------------------------------------------
def test_late_result_is_discarded(client, make_user, owner):
    a = make_user()
    use_ai(LateAI())
    rec = save(client, a)
    assert requests(owner, rec["id"])[0]["status"] == "discarded"
    assert analysis(client, a, rec["id"]).json()["material"] is None


def test_running_over_60_seconds_turns_failed(client, make_user, owner):
    a = make_user()
    rec = save(client, a)
    # pretend the server died while analysing: running request started 2 minutes ago
    req = owner.execute(
        "insert into ai_requests (user_id, kind, target_type, target_id, started_at) "
        "values (%s, 'extract', 'record', %s, now() - interval '2 minutes') returning id",
        (a, rec["id"]),
    ).fetchone()["id"]
    owner.execute("update records set analysis_status = 'analyzing', "
                  "latest_analysis_request_id = %s where id = %s", (req, rec["id"]))

    st = analysis(client, a, rec["id"]).json()
    assert st["analysis_status"] == "failed" and st["can_reanalyze"] is True
    assert requests(owner, rec["id"])[-1]["status"] == "timeout"


def test_no_second_request_while_analyzing(client, make_user, owner):
    a = make_user()
    rec = save(client, a)
    req = owner.execute(
        "insert into ai_requests (user_id, kind, target_type, target_id) "
        "values (%s, 'extract', 'record', %s) returning id", (a, rec["id"]),
    ).fetchone()["id"]
    owner.execute("update records set analysis_status = 'analyzing', "
                  "latest_analysis_request_id = %s where id = %s", (req, rec["id"]))

    r = client.post(f"/records/{rec['id']}/analysis", headers=auth(a))
    assert r.status_code == 200 and r.json()["analysis_status"] == "analyzing"
    assert len(requests(owner, rec["id"])) == 2  # the first save's + the one above


def test_retried_save_does_not_analyse_twice(client, make_user, owner):
    a = make_user()
    body = {"save_token": str(uuid.uuid4()), "body": TEXT}
    first = client.post("/records/free", headers=auth(a), json=body)
    retry = client.post("/records/free", headers=auth(a), json=body)
    assert first.status_code == 201 and retry.status_code == 200
    assert len(requests(owner, first.json()["id"])) == 1


def test_confirmed_material_is_not_overwritten(client, make_user, owner):
    a = make_user()
    rec = save(client, a)
    owner.execute("update materials set confirmed_at = now(), summary = '내가 고친 요약' "
                  "where record_id = %s", (rec["id"],))
    owner.execute("update records set analysis_status = 'failed' where id = %s", (rec["id"],))

    client.post(f"/records/{rec['id']}/analysis", headers=auth(a))
    st = analysis(client, a, rec["id"]).json()
    assert st["material"]["summary"] == "내가 고친 요약"
    # the new result waits on the request for R27 ([바꾸기]/[그대로 두기])
    assert requests(owner, rec["id"])[-1]["result"]["material"]["evidence"] == "오늘 엄마랑 오랜만에 통화했다."


# ---------------------------------------------------------------------------
# AI 질문 기록: 사용자 답변만 분석
# ---------------------------------------------------------------------------
def test_qna_save_analyses_answers_only(client, make_user):
    a = make_user()
    ai = CapturingAI()
    use_ai(ai)
    st = start(client, a, answer="어제 친구랑 바다에 갔다.")
    st = reply(client, a, st, answer="파도가 커서 신발이 다 젖었다.")
    r = client.post(f"/qna/{st['record_id']}/save", headers=auth(a))
    assert r.status_code == 201 and r.json()["analysis_status"] == "analyzing"

    text = ai.sources[0].user_text()
    assert text == "어제 친구랑 바다에 갔다.\n파도가 커서 신발이 다 젖었다."
    got = analysis(client, a, st["record_id"]).json()
    assert got["record_type"] == "qna" and got["analysis_status"] == "done"
    assert got["material"]["evidence"] == "어제 친구랑 바다에 갔다."


# ---------------------------------------------------------------------------
# [원본만 보관]
# ---------------------------------------------------------------------------
def test_keep_original(client, make_user, owner):
    a = make_user()
    rec = save(client, a, body="그냥 그랬다")
    first = client.post(f"/records/{rec['id']}/keep-original", headers=auth(a))
    again = client.post(f"/records/{rec['id']}/keep-original", headers=auth(a))
    assert first.status_code == 200 and first.json()["original_kept_at"]
    assert again.json()["original_kept_at"] == first.json()["original_kept_at"]


def test_keep_original_blocked_after_confirm(client, make_user, owner):
    a = make_user()
    rec = save(client, a)
    owner.execute("update materials set confirmed_at = now() where record_id = %s", (rec["id"],))
    r = client.post(f"/records/{rec['id']}/keep-original", headers=auth(a))
    assert r.status_code == 409 and r.json()["detail"] == "material_confirmed"


# ---------------------------------------------------------------------------
# 접근
# ---------------------------------------------------------------------------
def test_other_users_and_drafts_are_not_found(client, make_user):
    a, b = make_user(), make_user()
    rec = save(client, a)
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "쓰는 중"}).json()

    assert client.get(f"/records/{rec['id']}/analysis", headers=auth(b)).status_code == 404
    assert client.post(f"/records/{rec['id']}/analysis", headers=auth(b)).status_code == 404
    assert client.post(f"/records/{rec['id']}/keep-original", headers=auth(b)).status_code == 404
    assert client.get(f"/records/{draft['id']}/analysis", headers=auth(a)).status_code == 404


def test_requires_consent(client, make_user):
    a = make_user(consented=False)
    r = client.get(f"/records/{uuid.uuid4()}/analysis", headers=auth(a))
    assert r.status_code == 403
