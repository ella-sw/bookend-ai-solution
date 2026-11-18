import { request } from "./client";

/**
 * O110 [동의하고 시작하기]: 이름 없는 사용자를 만들고 AI 사용 안내 동의를 남긴다.
 * 실패하면 화면에서 '연결이 불안정해요' + [다시 시도] (RetryNotice)
 * 익명 로그인 방식(Supabase 익명 로그인을 화면에서 할지, 서버가 할지)은 목록 16번 합의 뒤 확정.
 */
export function startWithConsent() {
  return request<{ user_id: string }>({
    method: "POST",
    path: "/users/start",
    body: { ai_consent: true },
    mock: { key: "user.start" },
  });
}
