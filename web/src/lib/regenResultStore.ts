import type { RegenResult } from "@/lib/api";

/**
 * 다시 만든 결과(W340)를 이 탭의 sessionStorage에 둔다 → 새로고침해도 결과가 남는다 (탭을 닫으면 사라짐).
 * 서버는 저장하지 않은 결과를 다시 돌려주는 API가 없어서, 화면이 들고 있어야 한다.
 * 키: regen:{essayId}:{request_id}. 저장이 막힌 환경이면 이 탭 메모리에만 둔다.
 */
const memory = new Map<string, RegenResult>();

export const regenKey = (essayId: string, requestId: number) => `regen:${essayId}:${requestId}`;

export function putRegenResult(result: RegenResult) {
  const key = regenKey(result.essay_id, result.request_id);
  memory.set(key, result);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(result));
  } catch {
    // 저장이 막힌 환경: 메모리에만
  }
}

export function getRegenResult(essayId: string, requestId: number): RegenResult | null {
  const key = regenKey(essayId, requestId);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw) return JSON.parse(raw) as RegenResult;
  } catch {
    // 아래 메모리로
  }
  return memory.get(key) ?? null;
}

/** 저장했거나 사라진 결과는 지운다 */
export function removeRegenResult(essayId: string, requestId: number) {
  const key = regenKey(essayId, requestId);
  memory.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // 무시
  }
}

/** 모든 기록 지우기(S120) 뒤: 이 탭에 남은 다시 만들기 결과를 모두 지운다 */
export function clearAllRegenResults() {
  memory.clear();
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith("regen:")) keys.push(key);
    }
    keys.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // 무시
  }
}
