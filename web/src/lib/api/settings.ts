import { request } from "./client";

/**
 * S120 모든 기록 지우기. 사용자·AI 동의는 남는다 (ERD 규칙 14).
 * 성공하면 홈(빈 상태)으로, 실패하면 '지우지 못했어요' + [다시 시도]. 화면 연결은 6단계.
 */
export function clearAllData() {
  return request<null>({ method: "DELETE", path: "/me/data", timeoutMs: 30_000, mock: { key: "settings.clear" } });
}
