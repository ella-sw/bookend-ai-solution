"""실제 서버 전체 흐름 점검: 테스트용 익명 사용자 1명으로 앱의 주요 흐름을 순서대로 실행한다.

  uv run python scripts/e2e_check.py                       # 배포된 서버
  uv run python scripts/e2e_check.py http://localhost:8000  # 내 컴퓨터의 서버

- 실제 Supabase에 익명 사용자가 하나 생기고, 끝나면 (실패해도) 그 사용자와 데이터를 모두 지운다.
- 필요한 것: .env의 SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (토큰), DATABASE_URL (정리).
- AI 호출이 약 10회 일어난다 (실제 AI면 비용이 든다).
"""

import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
import psycopg

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "API_URL", "https://rowflow-api.onrender.com")
ROOT = Path(__file__).resolve().parent.parent
out = subprocess.run([sys.executable, str(ROOT / "scripts/dev_token.py")], capture_output=True,
                     text=True, check=True).stdout.strip().splitlines()
USER = out[0].split(":", 1)[1].strip()
TOKEN = out[-1]
print("TEST_USER", USER, flush=True)
c = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=90)
results = []


def step(name, method, path, expect, **kw):
    t = time.monotonic()
    r = c.request(method, path, **kw)
    ok = r.status_code in (expect if isinstance(expect, tuple) else (expect,))
    results.append((ok, name, r.status_code, round(time.monotonic() - t, 1)))
    print(("OK  " if ok else "FAIL"), f"{r.status_code} {time.monotonic() - t:5.1f}s  {name}",
          "" if ok else r.text[:300], flush=True)
    if not ok:
        raise SystemExit(1)
    return r.json() if r.content else None


def poll(name, path, done, tries=30):
    for _ in range(tries):
        r = c.get(path).json()
        if done(r):
            print(f"OK  poll  {name}", flush=True)
            return r
        time.sleep(2)
    print(f"FAIL poll {name}: {r}", flush=True)
    results.append((False, name, None, None))
    raise SystemExit(1)


def tok() -> str:
    return str(uuid.uuid4())



FAM = ["오늘 엄마랑 오랜만에 통화했다. 목소리가 밝아서 마음이 놓였다.",
       "이사 첫날 엄마가 보내 준 반찬을 꺼냈다. 혼자인데도 덜 외로웠다.",
       "아빠 생일에 가족이 모두 모였다. 오랜만에 다 같이 웃었다."]

try:
    # 동의 / 내 정보
    step("동의 (O110)", "POST", "/me/consent", 200)
    step("내 정보", "GET", "/me", 200)
    step("이벤트 record_started", "POST", "/events", 204,
         json={"name": "record_started", "record_type": "free"})

    # 자유 기록 3개 → 분석 → 보관
    mats, recs = [], []
    for i, body in enumerate(FAM):
        if i == 0:
            d = step("자유 기록 임시 저장", "POST", "/records/free/draft", 200, json={"body": "쓰는 중"})
            rec = step("소재로 저장 (이어 쓰기)", "POST", "/records/free", 201,
                       json={"save_token": tok(), "body": body, "record_id": d["id"]})
        else:
            rec = step(f"소재로 저장 {i + 1}", "POST", "/records/free", 201,
                       json={"save_token": tok(), "body": body})
        recs.append(rec["id"])
        a = poll(f"분석 끝 {i + 1}", f"/records/{rec['id']}/analysis",
                 lambda r: r["analysis_status"] != "analyzing")
        print(f"     analysis_status = {a['analysis_status']}")
        # done이면 후보를 보관, 소재 없음·실패면 [직접 정리하기]와 같은 요청
        summary = (a["material"] or {}).get("summary") or f"가족 이야기 {i + 1}"
        m = step(f"소재함에 보관 {i + 1}", "POST", f"/records/{rec['id']}/material", 201,
                 json={"summary": summary, "keywords": ["엄마", "가족"], "topics": [1]})
        mats.append(m["id"])

    # AI 문답
    dq = step("오늘의 질문", "GET", "/daily-questions/today", 200)
    st = step("첫 답변", "POST", "/qna", 201,
              json={"daily_question_id": dq["questions"][0]["id"], "answer": "친구랑 바다에 갔다."})
    st = step("후속 답변", "POST", f"/qna/{st['record_id']}/answers", 200,
              json={"question_id": st["pending_question"]["id"], "answer": "파도가 컸다."})
    st = step("다른 질문 보기", "POST", f"/qna/{st['record_id']}/replace", 200,
              json={"question_id": st["pending_question"]["id"]})
    step("문답 임시 저장", "POST", f"/qna/{st['record_id']}/draft", 200)
    step("문답 이어 쓰기 확인", "GET", "/qna/draft", 200)
    qrec = step("문답 소재로 저장", "POST", f"/qna/{st['record_id']}/save", 201)
    poll("문답 분석 완료", f"/records/{qrec['id']}/analysis",
         lambda r: r["analysis_status"] != "analyzing")
    step("원본만 보관", "POST", f"/records/{qrec['id']}/keep-original", 200)
    step("원문 보기", "GET", f"/records/{qrec['id']}/original", 200)

    # 소재함 / 상세 / 추천 / 고치기 / 다시 분석
    box = step("소재함", "GET", "/materials", 200)
    assert len(box["materials"]) == 3 and len(box["kept_originals"]) == 1, box
    step("소재 상세", "GET", f"/materials/{mats[0]}", 200)
    rel = step("관련 소재 추천", "GET", "/materials/related", 200, params={"selected": mats[0]})
    assert len(rel) == 2, rel
    step("소재 고치기", "PATCH", f"/materials/{mats[0]}", 200, json={"summary": "엄마와의 통화"})
    step("소재 다시 분석", "POST", f"/materials/{mats[2]}/reanalyze", 202)
    poll("다시 분석 결과", f"/materials/{mats[2]}",
         lambda r: r["reanalysis"] and r["reanalysis"]["status"] != "analyzing")
    step("그대로 두기", "POST", f"/materials/{mats[2]}/reanalysis/dismiss", 200)

    # 제안
    sl = poll("글쓰기 제안 준비", "/suggestions",
              lambda r: not r["computing"] and r["suggestions"])
    sug = sl["suggestions"][0]
    step("제안 상세 (N130)", "GET", f"/suggestions/{sug['id']}", 200)
    step("이벤트 suggestion_shown", "POST", "/events", 204,
         json={"name": "suggestion_shown", "suggestion_id": sug["id"], "placement": "home"})
    step("이벤트 suggestion_selected", "POST", "/events", 204,
         json={"name": "suggestion_selected", "suggestion_id": sug["id"]})
    step("이벤트 writing_started", "POST", "/events", 204,
         json={"name": "writing_started", "write_mode": "ai", "entry_path": "suggestion",
               "material_count": 3, "suggestion_id": sug["id"]})

    # AI 초안 → 다시 만들기 → 저장
    e = step("AI 초안 (W330)", "POST", "/essays/ai", 201, json={
        "material_ids": [m["id"] for m in sug["materials"]], "direction": sug["direction"],
        "style": "감성적", "length": "short", "suggestion_id": sug["id"], "save_token": tok()})
    rg = step("다시 만들기 (W340)", "POST", f"/essays/{e['id']}/regenerate", 200,
              json={"based_on_version_id": e["versions"][0]["id"], "style": "담백함",
                    "length": "long"})
    e = step("다시 만든 결과 저장 (W341)", "POST",
             f"/essays/{e['id']}/regenerations/{rg['request_id']}/save", 201,
             json={"save_token": tok()})
    assert [v["label"] for v in e["versions"]] == ["초안", "v1"], e["versions"]
    step("이벤트 body_shared", "POST", "/events", 204,
         json={"name": "body_shared", "essay_id": e["id"], "share_method": "copy"})

    # 직접 쓰기 → 버전
    d = step("직접 쓰기 임시 저장", "POST", "/essays/draft", 200,
             json={"body": "초안", "material_ids": [mats[0]]})
    de = step("직접 쓰기 첫 저장 v1", "POST", "/essays", 201,
              json={"essay_id": d["id"], "title": "직접 쓴 글", "body": "내가 쓴 본문.",
                    "material_ids": [mats[0]], "save_token": tok()})
    de = step("새 버전으로 저장", "POST", f"/essays/{de['id']}/versions", 201,
              json={"body": "고친 본문", "based_on_version_id": de["versions"][0]["id"],
                    "save_token": tok()})
    step("덮어쓰기", "PUT", f"/essays/{de['id']}/versions/{de['versions'][0]['id']}", 200,
         json={"body": "덮어쓴 v1"})
    lib = step("내 서재", "GET", "/essays", 200)
    assert len(lib) == 2, lib
    step("글 상세", "GET", f"/essays/{de['id']}", 200)

    me = step("하루 사용량", "GET", "/me", 200)
    print(f"     ai_calls_today={me['ai_calls_today']} / {me['ai_daily_limit']}")

    # 삭제
    step("글 삭제", "DELETE", f"/essays/{de['id']}", 204)
    step("소재 삭제", "DELETE", f"/materials/{mats[1]}", 204)
    step("모든 기록 지우기", "DELETE", "/me/data", 200)
    box = step("지운 뒤 소재함", "GET", "/materials", 200)
    assert box == {"pending": [], "drafts": [], "materials": [], "kept_originals": []}, box
    assert step("지운 뒤 내 서재", "GET", "/essays", 200) == []
finally:
    bad = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(bad)}/{len(results)} steps OK")
    # clean up: the anonymous user and (cascade) everything of theirs
    env = dict(line.split("=", 1) for line in (ROOT / ".env").read_text().splitlines()
               if "=" in line and not line.lstrip().startswith("#"))
    with psycopg.connect(env["DATABASE_URL"].strip(), autocommit=True,
                         prepare_threshold=None) as db:
        db.execute("delete from auth.users where id = %s", (USER,))
    print(f"test user {USER} deleted")
    sys.exit(1 if bad else 0)
