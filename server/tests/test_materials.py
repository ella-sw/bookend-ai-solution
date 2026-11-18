"""R27 소재함과 소재 관리 (M110, M120 보관, M130, M131, M132)."""

import pytest
from fastapi.testclient import TestClient

from app.ai import AIExtract, ExtractedMaterial, StubMaterialAI
from app.main import app
from tests.test_analysis import TEXT, FailingAI, FixedAI, analysis, auth, save, use_ai
from tests.test_qna import reply, start


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


class EmptyAI(StubMaterialAI):
    async def extract_material(self, source, topics):
        return AIExtract(None, 0, 0)


def confirm(client, uid, record_id, **body):
    data = {"summary": "엄마와 통화한 날", "keywords": ["엄마", "통화"], "topics": [1], **body}
    return client.post(f"/records/{record_id}/material", headers=auth(uid), json=data)


def box(client, uid):
    r = client.get("/materials", headers=auth(uid))
    assert r.status_code == 200, r.text
    return r.json()


def confirmed(client, uid, body=TEXT):
    rec = save(client, uid, body=body)
    r = confirm(client, uid, rec["id"])
    assert r.status_code == 201, r.text
    return rec, r.json()


def detail(client, uid, material_id):
    return client.get(f"/materials/{material_id}", headers=auth(uid))


# ---------------------------------------------------------------------------
# M120 [소재함에 보관] / [직접 정리하기]
# ---------------------------------------------------------------------------
def test_confirm_ai_candidate_with_edits(client, make_user, owner):
    a = make_user()
    rec = save(client, a)
    cand = analysis(client, a, rec["id"]).json()["material"]

    r = confirm(client, a, rec["id"], title="엄마 목소리", topics=[1, 5])
    assert r.status_code == 201
    m = r.json()
    assert m["id"] == cand["id"] and m["origin"] == "ai" and m["confirmed_at"]
    assert m["title"] == "엄마 목소리" and m["summary"] == "엄마와 통화한 날"
    assert [t["name"] for t in m["topics"]] == ["가족", "일상"]
    assert m["evidence"] == cand["evidence"]  # 근거 문장은 AI 결과 그대로
    assert m["user_edited_at"] is not None
    assert m["original"]["body"] == TEXT

    ev = owner.execute("select name from events where user_id = %s order by id", (a,)).fetchall()
    assert [e["name"] for e in ev] == ["record_saved", "material_confirmed"]


def test_confirm_unchanged_is_not_an_edit(client, make_user):
    a = make_user()
    rec = save(client, a)
    c = analysis(client, a, rec["id"]).json()["material"]
    r = confirm(client, a, rec["id"], title=c["title"], summary=c["summary"],
                keywords=c["keywords"], topics=[t["id"] for t in c["topics"]])
    assert r.status_code == 201 and r.json()["user_edited_at"] is None


def test_confirm_retry_returns_same_material(client, make_user, owner):
    a = make_user()
    rec, m = confirmed(client, a)
    again = confirm(client, a, rec["id"], summary="다른 요약")
    assert again.status_code == 200 and again.json()["summary"] == m["summary"]
    n = owner.execute("select count(*) n from events where user_id = %s "
                      "and name = 'material_confirmed'", (a,)).fetchone()["n"]
    assert n == 1


def test_write_material_myself_when_nothing_found(client, make_user):
    a = make_user()
    use_ai(EmptyAI())
    rec = save(client, a)
    assert analysis(client, a, rec["id"]).json()["analysis_status"] == "empty"

    r = confirm(client, a, rec["id"], title="통화", summary="직접 정리한 요약", keywords=[])
    assert r.status_code == 201
    m = r.json()
    assert m["origin"] == "manual" and m["evidence"] is None and m["title"] == "통화"


@pytest.mark.parametrize("body,detail_", [
    ({"topics": [99]}, "unknown_topic"),
    ({"topics": []}, None),
    ({"summary": "  "}, None),
])
def test_confirm_validation(client, make_user, body, detail_):
    a = make_user()
    rec = save(client, a)
    r = confirm(client, a, rec["id"], **body)
    assert r.status_code == 422
    if detail_:
        assert r.json()["detail"] == detail_


# ---------------------------------------------------------------------------
# M110 소재함
# ---------------------------------------------------------------------------
def test_material_box_sections(client, make_user, owner):
    a = make_user()
    to_confirm = save(client, a)  # done, not confirmed
    use_ai(EmptyAI())
    empty = save(client, a, body="그냥 그랬다는 이야기를 길게 적어 본다.")
    use_ai(FailingAI())
    failed = save(client, a)
    kept = save(client, a)
    client.post(f"/records/{kept['id']}/keep-original", headers=auth(a))
    use_ai(StubMaterialAI())
    done_rec, mat = confirmed(client, a)
    draft = client.post("/records/free/draft", headers=auth(a), json={"body": "쓰는 중인 글"}).json()

    b = box(client, a)
    labels = {c["record_id"]: c["label"] for c in b["pending"]}
    assert labels == {to_confirm["id"]: "to_confirm", empty["id"]: "empty",
                      failed["id"]: "failed"}
    assert [c["record_id"] for c in b["drafts"]] == [draft["id"]]
    assert b["drafts"][0]["preview"] == "쓰는 중인 글" and b["drafts"][0]["status"] == "draft"
    assert [c["record_id"] for c in b["kept_originals"]] == [kept["id"]]
    assert b["kept_originals"][0]["label"] is None  # failed analysis: no badge
    assert [m["id"] for m in b["materials"]] == [mat["id"]]
    assert b["materials"][0]["essay_count"] == 0
    assert done_rec["id"] not in labels


def test_box_labels_while_analyzing_and_kept_candidate(client, make_user, owner):
    a = make_user()
    running = save(client, a)
    req = owner.execute(
        "insert into ai_requests (user_id, kind, target_type, target_id) "
        "values (%s, 'extract', 'record', %s) returning id", (a, running["id"])).fetchone()["id"]
    owner.execute("update records set analysis_status = 'analyzing', "
                  "latest_analysis_request_id = %s where id = %s", (req, running["id"]))
    kept = save(client, a)  # has an AI candidate
    client.post(f"/records/{kept['id']}/keep-original", headers=auth(a))

    b = box(client, a)
    assert [(c["record_id"], c["label"]) for c in b["pending"]] == [(running["id"], "analyzing")]
    assert [(c["record_id"], c["label"]) for c in b["kept_originals"]] == \
        [(kept["id"], "to_confirm")]

    # confirming the kept original's candidate takes it out of the list
    confirm(client, a, kept["id"])
    assert box(client, a)["kept_originals"] == []


def test_qna_record_preview_and_original(client, make_user):
    a = make_user()
    st = start(client, a, answer="어제 친구랑 바다에 갔다.")
    st = reply(client, a, st, answer="파도가 컸다.")
    client.post(f"/qna/{st['record_id']}/save", headers=auth(a))

    card = box(client, a)["pending"][0]
    assert card["record_type"] == "qna" and card["preview"] == "어제 친구랑 바다에 갔다. 파도가 컸다."
    orig = client.get(f"/records/{st['record_id']}/original", headers=auth(a)).json()
    assert [m["answer"] for m in orig["messages"]] == ["어제 친구랑 바다에 갔다.", "파도가 컸다."]


# ---------------------------------------------------------------------------
# M130 상세 / M131 고치기
# ---------------------------------------------------------------------------
def test_detail_lists_essays_using_it(client, make_user, owner):
    a = make_user()
    _rec, m = confirmed(client, a)
    essay = owner.execute("insert into essays (user_id, method, status, title) "
                          "values (%s, 'direct', 'saved', '가족의 의미') returning id",
                          (a,)).fetchone()["id"]
    owner.execute("insert into essay_materials values (%s, %s, 1)", (essay, m["id"]))

    d = detail(client, a, m["id"]).json()
    assert d["essays"] == [{"id": str(essay), "title": "가족의 의미"}]
    assert box(client, a)["materials"][0]["essay_count"] == 1


def test_edit_summary_keywords_topics_only(client, make_user, owner):
    a = make_user()
    _rec, m = confirmed(client, a)
    before = owner.execute("select updated_at from materials where id = %s",
                           (m["id"],)).fetchone()["updated_at"]

    r = client.patch(f"/materials/{m['id']}", headers=auth(a),
                     json={"summary": "고친 요약", "keywords": ["가족", "가족"], "topics": [5],
                           "title": "제목은 못 고침"})
    assert r.status_code == 200
    d = r.json()
    assert d["summary"] == "고친 요약" and d["keywords"] == ["가족"]
    assert [t["name"] for t in d["topics"]] == ["일상"]
    assert d["title"] == m["title"] and d["user_edited_at"]
    after = owner.execute("select updated_at from materials where id = %s",
                          (m["id"],)).fetchone()["updated_at"]
    assert after > before  # B·C 규칙 1 (제안 다시 계산 기준)


# ---------------------------------------------------------------------------
# M131 다시 분석 → [바꾸기] / [그대로 두기]
# ---------------------------------------------------------------------------
NEW = ExtractedMaterial(title="새 제목", summary="새 요약", evidence="목소리가 밝아서 마음이 놓였다.",
                        keywords=["안도"], topics=["가족", "몸·건강"])


def test_reanalyze_then_apply(client, make_user, owner):
    a = make_user()
    rec, m = confirmed(client, a)
    use_ai(FixedAI(NEW))
    r = client.post(f"/materials/{m['id']}/reanalyze", headers=auth(a))
    assert r.status_code == 202

    d = detail(client, a, m["id"]).json()
    assert d["summary"] == m["summary"]  # not changed yet
    assert d["reanalysis"]["status"] == "done"
    assert d["reanalysis"]["result"]["summary"] == "새 요약"
    assert [t["name"] for t in d["reanalysis"]["result"]["topics"]] == ["가족", "몸·건강"]

    d = client.post(f"/materials/{m['id']}/reanalysis/apply", headers=auth(a)).json()
    assert d["summary"] == "새 요약" and d["evidence"] == NEW.evidence and d["title"] == "새 제목"
    assert d["reanalysis"] is None
    assert owner.execute("select result from ai_requests where target_id = %s order by id desc",
                         (rec["id"],)).fetchone()["result"] is None  # ERD rule 12
    assert client.post(f"/materials/{m['id']}/reanalysis/apply",
                       headers=auth(a)).status_code == 409


def test_reanalyze_then_keep(client, make_user):
    a = make_user()
    _rec, m = confirmed(client, a)
    use_ai(FixedAI(NEW))
    client.post(f"/materials/{m['id']}/reanalyze", headers=auth(a))
    d = client.post(f"/materials/{m['id']}/reanalysis/dismiss", headers=auth(a)).json()
    assert d["summary"] == m["summary"] and d["reanalysis"] is None


@pytest.mark.parametrize("ai,shown", [(EmptyAI(), "empty"), (FailingAI(), "failed")])
def test_reanalyze_empty_or_failed_keeps_material(client, make_user, ai, shown):
    a = make_user()
    _rec, m = confirmed(client, a)
    use_ai(ai)
    client.post(f"/materials/{m['id']}/reanalyze", headers=auth(a))
    d = detail(client, a, m["id"]).json()
    assert d["reanalysis"] == {"status": shown, "result": None}
    assert d["summary"] == m["summary"]
    d = client.post(f"/materials/{m['id']}/reanalysis/dismiss", headers=auth(a)).json()
    assert d["reanalysis"] is None
    # the material is still in the box, not back in 확인 대기
    b = box(client, a)
    assert [x["id"] for x in b["materials"]] == [m["id"]] and b["pending"] == []


# ---------------------------------------------------------------------------
# M131 소재 삭제 / M132 기록 삭제
# ---------------------------------------------------------------------------
def test_delete_material_is_logical(client, make_user, owner):
    a = make_user()
    rec, m = confirmed(client, a)
    assert client.delete(f"/materials/{m['id']}", headers=auth(a)).status_code == 204

    assert detail(client, a, m["id"]).status_code == 404
    b = box(client, a)
    assert b["materials"] == [] and b["pending"] == [] and b["kept_originals"] == []
    row = owner.execute("select deleted_at from materials where id = %s", (m["id"],)).fetchone()
    assert row["deleted_at"] is not None  # still there for essays ('삭제된 소재')
    # 팀 결정 (11/18): 원본은 남지만 목록에 다시 보이지 않고, 개별 삭제·다시 확정·
    # 다시 분석·원본만 보관 모두 안 된다 ([모든 기록 지우기]·1달 정리로만 지워짐)
    assert client.get(f"/records/{rec['id']}/original", headers=auth(a)).status_code == 200
    for r in (confirm(client, a, rec["id"]),
              client.post(f"/records/{rec['id']}/analysis", headers=auth(a)),
              client.post(f"/records/{rec['id']}/keep-original", headers=auth(a)),
              client.delete(f"/records/{rec['id']}", headers=auth(a))):
        assert r.status_code == 409 and r.json()["detail"] == "material_deleted"
    assert box(client, a)["kept_originals"] == []


def test_nothing_found_original_can_be_deleted(client, make_user):
    """소재 없음으로 남은 원본은 '원본만 보관한 기록'에 보이고 개별 삭제할 수 있다."""
    a = make_user()
    rec = save(client, a, body="그냥 그랬다")  # 소재 없음
    client.post(f"/records/{rec['id']}/keep-original", headers=auth(a))
    assert [c["record_id"] for c in box(client, a)["kept_originals"]] == [rec["id"]]
    assert client.delete(f"/records/{rec['id']}", headers=auth(a)).status_code == 204
    assert box(client, a)["kept_originals"] == []


def test_delete_record_without_confirmed_material(client, make_user, owner):
    a = make_user()
    rec = save(client, a)  # has an unconfirmed candidate + AI request + event
    assert client.delete(f"/records/{rec['id']}", headers=auth(a)).status_code == 204

    left = owner.execute(
        "select (select count(*) from records where id = %(r)s) "
        "     + (select count(*) from materials where record_id = %(r)s) "
        "     + (select count(*) from ai_requests where target_id = %(r)s) as n",
        {"r": rec["id"]}).fetchone()["n"]
    assert left == 0
    ev = owner.execute("select record_id from events where user_id = %s", (a,)).fetchone()
    assert ev["record_id"] is None  # event kept, link cleared


def test_cannot_delete_record_with_confirmed_material(client, make_user):
    a = make_user()
    rec, _ = confirmed(client, a)
    r = client.delete(f"/records/{rec['id']}", headers=auth(a))
    assert r.status_code == 409 and r.json()["detail"] == "material_confirmed"


# ---------------------------------------------------------------------------
# 접근
# ---------------------------------------------------------------------------
def test_other_user_cannot_touch_materials(client, make_user):
    a, b = make_user(), make_user()
    _rec, m = confirmed(client, a)
    other = save(client, a)

    assert detail(client, b, m["id"]).status_code == 404
    assert client.patch(f"/materials/{m['id']}", headers=auth(b),
                        json={"summary": "x"}).status_code == 404
    assert client.delete(f"/materials/{m['id']}", headers=auth(b)).status_code == 404
    assert client.post(f"/materials/{m['id']}/reanalyze", headers=auth(b)).status_code == 404
    assert confirm(client, b, other["id"]).status_code == 404
    assert client.delete(f"/records/{other['id']}", headers=auth(b)).status_code == 404
    assert client.get(f"/records/{other['id']}/original", headers=auth(b)).status_code == 404
    assert box(client, b) == {"pending": [], "drafts": [], "materials": [], "kept_originals": []}

