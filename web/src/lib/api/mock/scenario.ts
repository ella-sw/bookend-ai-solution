import type { MockKey } from "./keys";

/**
 * 목업 상황 고르기.
 * - ok: 정상 / fail: 서버 오류 / network: 연결 끊김 / timeout: 시간 초과
 * - empty: 빈 결과 (분석이면 '소재 없음', 목록이면 빈 목록) / slow: 느리지만 성공
 * - ai_fail: AI 문답에서 질문 만들기만 실패 → ai_failed = true (qna.start·answer·next·replace).
 *   답변은 저장되고, [다른 질문 보기]는 기존 질문·횟수 그대로. 다른 키는 정상과 같다
 * - daily_limit: 오늘 AI 호출을 다 씀 (B R32). 문답(qna.start·answer·next·replace)은 답변을 저장하고
 *   새 질문 없이 daily_limit_reached = true. replace는 질문·횟수 그대로. 다른 키는 정상과 같다
 * - 소재 분석 (M120)
 *   · analysis.get: 정상 → 2~4번째 조회에서 done / 빈 결과 → 소재 없음 / 실패 → failed /
 *     시간 초과 → 분석 중으로 있다가 시작 후 60초가 지나면 failed
 *   · analysis.start: 실패·연결 끊김·시간 초과 → 저장 때 분석 시작 실패(failed), 다시 분석 요청 실패 /
 *     하루 한도 → 저장 때 failed + daily_limit_reached, 다시 분석 429 daily_limit
 * - 다시 분석 (M131): 결과는 material.reanalysis.result 키로 고른다 (정상 → 2~4번째 조회에서 done /
 *   빈 결과 → empty / 실패 → failed / 시간 초과 → 60초 뒤 failed). material.reanalyze를 '하루 한도'로 두면 429 daily_limit
 * - AI 초안 (essays.ai.create · essays.regenerate): 2~4초 걸려서 응답 ('응답 기다림'이 0이면 바로).
 *   AI 실패 → 502 ai_failed / 하루 한도 → 429 daily_limit / 글자 수 범위 밖 → in_length_range = false /
 *   삭제한 소재 있음 → 다시 만들기 결과에 deleted_materials_left_out = true (실제로 삭제한 소재가 있어도 true)
 * - unauthorized: 세션 무효 (SDK가 세션을 지운 경우 흉내) → 목업 세션을 지우고 kind = unauthorized
 * - not_consented: 동의 전 → 403 not_consented (GET /me는 404, users.ts가 kind = not_consented로 바꿈). 세션 유지
 * 이 브라우저에만 저장된다 (개발용). 저장이 막힌 환경이면 기본값(ok)으로 동작.
 */
export const MOCK_SCENARIOS = {
  ok: "정상",
  fail: "실패 (서버 오류)",
  network: "연결 끊김",
  timeout: "시간 초과",
  empty: "빈 결과 · 소재 없음",
  slow: "느림 (성공)",
  ai_fail: "AI 실패 (문답: ai_failed / AI 초안: 502)",
  daily_limit: "하루 한도 (문답: 새 질문 없음 / AI 초안: 429)",
  length_out: "글자 수 범위 밖 (AI 초안)",
  deleted_left_out: "삭제한 소재 있음 (다시 만들기)",
  unauthorized: "세션 무효 (세션 지움 → O110)",
  not_consented: "동의 전 (403 not_consented)",
} as const;

export type MockScenario = keyof typeof MOCK_SCENARIOS;

export interface MockSettings {
  /** 키별로 따로 정하지 않은 호출에 쓰는 상황 */
  defaultScenario: MockScenario;
  overrides: Partial<Record<MockKey, MockScenario>>;
  /** 모든 응답에 더하는 기다림 (ms) */
  delayMs: number;
  /** AI 문답 이어 쓰기 기준 시간 (ms). null이면 실제 값(config.ts QNA_RESUME_WINDOW_MS, 1시간) */
  qnaResumeWindowMs: number | null;
}

const STORAGE_KEY = "rowflow.mock.v1";

export const DEFAULT_MOCK_SETTINGS: MockSettings = {
  defaultScenario: "ok",
  overrides: {},
  delayMs: 400,
  qnaResumeWindowMs: null,
};

let cache: MockSettings | null = null;
const listeners = new Set<() => void>();

function readStored(): MockSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MOCK_SETTINGS;
    return { ...DEFAULT_MOCK_SETTINGS, ...(JSON.parse(raw) as Partial<MockSettings>) };
  } catch {
    return DEFAULT_MOCK_SETTINGS;
  }
}

/** 같은 값이면 같은 객체를 돌려준다 (useSyncExternalStore용) */
export function getMockSettings(): MockSettings {
  if (typeof window === "undefined") return DEFAULT_MOCK_SETTINGS;
  cache ??= readStored();
  return cache;
}

export function setMockSettings(next: MockSettings) {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장이 막힌 환경: 무시 (이 탭에서만 유지)
  }
  listeners.forEach((listener) => listener());
}

export function subscribeMockSettings(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function scenarioFor(key: MockKey): MockScenario {
  const settings = getMockSettings();
  return settings.overrides[key] ?? settings.defaultScenario;
}
