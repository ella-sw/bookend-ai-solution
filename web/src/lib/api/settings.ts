import { request } from "./client";
import type { Me } from "./types";

/**
 * S120 모든 기록 지우기 (B DELETE /me/data → 200 Me): 원본 기록·문답·임시 저장·소재·글·버전·제안·AI 요청 기록·이벤트.
 * 사용자 행과 동의 시각은 남는다 (ERD 규칙 14, 다시 묻지 않음). 두 번 불러도 안전
 */
export function clearAllData() {
  return request<Me>({ method: "DELETE", path: "/me/data", timeoutMs: 30_000, mock: { key: "settings.clear" } });
}
