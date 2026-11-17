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

/** 소재 분석 최대 시간 (ERD 데이터 규칙 3: 최대 60초 → 실패). 판단은 서버가 한다. */
export const ANALYSIS_TIMEOUT_MS = 60_000;

/** 서버가 60초 판단을 늦게 알려 줄 때 화면이 더 기다리는 여유 */
export const ANALYSIS_GRACE_MS = 10_000;

/** 분석 상태를 다시 물어보는 간격 */
export const ANALYSIS_POLL_MS = 1_500;
