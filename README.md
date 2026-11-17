# Rowflow 백엔드 (FastAPI + Supabase)

기준 문서: 요구사항 정의서·UI 설계서·ERD **소재추가 v7** + `B·C 공유: DB 규칙 3건` (11/16)

## 구조

```
Next.js 화면 ── Supabase 익명 로그인 ── 토큰을 Authorization 헤더로 ──▶ 이 서버(FastAPI) ──▶ Supabase Postgres
```

- 브라우저는 **로그인만** Supabase로 하고, 데이터는 모두 이 API로 주고받습니다.
  브라우저 역할(`anon`, `authenticated`)은 사용자 테이블에 직접 접근할 수 없습니다.
- 서버는 요청마다 한 트랜잭션 안에서 `app_user` 역할 + 호출한 사용자 id로 쿼리합니다.
  그래서 **RLS가 서버 쿼리에도 적용**됩니다 (`app/db.py`). SQL에도 사용자 조건은 직접 넣습니다.

```
app/
  main.py          앱, CORS, /health
  config.py        환경 변수
  auth.py          Supabase 토큰 확인 (JWKS 또는 예전 HS256 비밀 키)
  db.py            연결 풀, 사용자 단위 트랜잭션(UserConn)
  routers/me.py    GET /me, POST /me/consent
supabase/migrations/
  ..._tables.sql     테이블·제약·인덱스
  ..._rules.sql      트리거(데이터 규칙), 정리 함수, RLS·권한
  ..._schedules.sql  pg_cron 예약 작업 (시간 초과 정리, 1달 정리)
tests/
  test_db_rules.py   다른 사람 기록 접근 차단, DB 규칙
  test_api.py        토큰 확인, /me
```

## ERD v7에서 달라진 점 (B·C 공유 문서 반영)

| 항목 | 반영 |
|---|---|
| 1. 소재 수정 시각 | `materials.updated_at` 추가. 소재가 바뀌거나 `material_topics`가 추가·삭제되면 트리거가 갱신 |
| 2. AI 요청 대상 | `ai_requests.target_type` = `record` / `suggestion` / `essay` (제안 요청은 `suggestions.id`) |
| 3. 시간 초과 뒤 결과 | `expire_ai_requests()`가 60초 지난 `running` 요청을 `timeout`으로 바꾸고, 분석 중이던 기록은 `failed`, 계산 중이던 제안은 `failed`로. 결과는 `status = running`이고 최신 요청일 때만 적용 (API에서 구현 예정) |
| 4. 이벤트 칸 이름 | `events.share_method` (`copy` / `share_sheet`) |
| 상태 값 타입 | `text + CHECK` (ERD 규칙 18의 권장안) |

## DB가 직접 지키는 규칙

- 저장된 원본 기록·문답은 고칠 수 없음 (ERD 규칙 2)
- 임시 저장은 기록 종류별 1개, 직접 쓰기 글 1개 (규칙 16)
- 다른 사람의 기록에 문답·소재·연결을 붙일 수 없음 (규칙 17)
- 모든 기록 지우기 `clear_user_data()`: 사용자 행과 동의 시각은 남김 (규칙 14)
- 1달 정리 `cleanup_inactive_users()` (규칙 15)

## 처음 설정

```bash
uv sync                 # Python 3.12 + 패키지 설치
cp .env.example .env    # 값 채우기
uv run uvicorn app.main:app --reload
```

API 문서: http://localhost:8000/docs (A와 이 화면을 공유하면 됩니다)

### Supabase에 테이블 만들기

1. Supabase 대시보드에서 **익명 로그인**을 켭니다 (Authentication > Sign In / Providers > Anonymous).
2. **pg_cron**을 켭니다 (Database > Extensions).
3. 마이그레이션을 올립니다. 둘 중 하나:
   - Supabase CLI: `supabase link --project-ref <ref>` 후 `supabase db push`
   - 또는 SQL Editor에 `supabase/migrations/*.sql`을 순서대로 붙여 넣기
4. `.env`의 `DATABASE_URL`은 **Session pooler(5432)** 주소를 씁니다.

`tests/sql/supabase_shim.sql`은 테스트 전용입니다. Supabase에는 올리지 마세요.

## 테스트

```bash
./scripts/test-db.sh    # Docker로 테스트용 Postgres 시작 (포트 54329)
uv run pytest
uv run ruff check .
```

## 다음 할 일

- [x] 기록 API: 자유 기록 임시 저장·[소재로 저장] (R04)
- [x] AI 질문 API: 오늘의 질문, 후속 질문, 다른 질문 보기 (R05) — AI는 stub, C가 `app/ai.py`에 실제 모델 연결
- [ ] 소재 분석 요청·결과 적용 (R28, B·C 규칙 3) — C와 함께
- [ ] 소재함·소재 상세·삭제 (R27), 제안 다시 계산 (R30)
- [ ] 글·버전 저장 (R07, R08), 이벤트 기록 (R33), 하루 호출 한도 (R32)
- [ ] 배포 (Render / Railway / Fly.io)
