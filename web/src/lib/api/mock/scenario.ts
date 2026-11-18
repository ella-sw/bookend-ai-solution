import type { MockKey } from "./keys";

/**
 * 목업 상황 고르기.
 * - ok: 정상 / fail: 서버 오류 / network: 연결 끊김 / timeout: 시간 초과
 * - empty: 빈 결과 (분석이면 '소재 없음', 목록이면 빈 목록) / slow: 느리지만 성공
 * 이 브라우저에만 저장된다 (개발용). 저장이 막힌 환경이면 기본값(ok)으로 동작.
 */
export const MOCK_SCENARIOS = {
  ok: "정상",
  fail: "실패 (서버 오류)",
  network: "연결 끊김",
  timeout: "시간 초과",
  empty: "빈 결과 · 소재 없음",
  slow: "느림 (성공)",
} as const;

export type MockScenario = keyof typeof MOCK_SCENARIOS;

export interface MockSettings {
  /** 키별로 따로 정하지 않은 호출에 쓰는 상황 */
  defaultScenario: MockScenario;
  overrides: Partial<Record<MockKey, MockScenario>>;
  /** 모든 응답에 더하는 기다림 (ms) */
  delayMs: number;
}

const STORAGE_KEY = "rowflow.mock.v1";

export const DEFAULT_MOCK_SETTINGS: MockSettings = { defaultScenario: "ok", overrides: {}, delayMs: 400 };

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
