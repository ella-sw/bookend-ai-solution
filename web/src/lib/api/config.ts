/**
 * 서버 주소·목업 설정.
 * - 실제 FastAPI: web/.env.local 에 NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
 * - 목업(가짜 응답): NEXT_PUBLIC_USE_MOCK=1. 목업 상황(실패·시간 초과·소재 없음 등)은 /dev/mock 에서 고른다.
 * - 개발 중(npm run dev)에는 둘 다 비어 있으면 목업으로 동작한다.
 * - 배포 빌드(npm run build)에서는 둘 다 비어 있으면 빌드를 멈춘다 (next.config.ts).
 *   → 서버 주소를 빠뜨린 채 배포돼 실제 사이트가 몰래 가짜 데이터로 도는 일을 막는다.
 */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");

const MOCK_REQUESTED = process.env.NEXT_PUBLIC_USE_MOCK === "1";

export const USE_MOCK = MOCK_REQUESTED || (process.env.NODE_ENV !== "production" && API_BASE_URL === "");

/** 일반 요청 제한 시간 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** 소재 분석 최대 시간 (ERD 데이터 규칙 3: 60초가 지나면 실패). 판단은 서버가 한다 (화면은 세지 않음) */
export const ANALYSIS_TIMEOUT_MS = 60_000;

/** 분석 중이면 다시 물어보는 간격 (B: 2~3초마다) */
export const ANALYSIS_POLL_MS = 2_500;

/**
 * 화면을 연 뒤 이만큼 지나도 분석 중이면 기다림만 멈춘다 (마지막 상태를 돌려줌).
 * 서버의 60초 실패 판단이 늦게 오는 경우를 넉넉히 기다리는 값
 */
export const ANALYSIS_WAIT_MS = 75_000;

/**
 * AI 문답 이어 쓰기 기준 시간 (목록 17번 ⑥). 기준은 records.updated_at(마지막 활동).
 * - GET /qna/active: 이보다 오래된 진행 중(active) 문답은 지우고 null
 * - GET /qna/draft: 이보다 오래된 임시 저장(draft)은 기준점으로 되돌림
 * 판단은 서버가 한다. 목업은 /dev/mock 에서 짧게 바꿔 시험할 수 있다.
 */
export const QNA_RESUME_WINDOW_MS = 60 * 60 * 1000;
