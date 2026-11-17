import { request } from "./client";
import type { Me } from "./types";

/**
 * 사용자 (B 서버 server/app/routers/me.py, 목록 19번).
 * 익명 로그인(signInAnonymously)·토큰 헤더·401 다시 시도는 client.ts 인증 작업 때 붙인다.
 */

/**
 * 첫 화면: 세션이 있으면 부른다. 이번 접속(last_seen_at)도 서버가 기록한다.
 * 404 + code = "not_consented" → O110 첫 실행 안내로
 */
export function getMe() {
  return request<Me>({ method: "GET", path: "/me", mock: { key: "me.get" } });
}

/**
 * O110 [동의하고 시작하기]: signInAnonymously() 뒤에 부른다. 사용자 행을 만들고 AI 사용 안내 동의를 남긴다.
 * 다시 불러도 처음 동의 시각은 그대로. 실패하면 '연결이 불안정해요' + [다시 시도] (RetryNotice)
 */
export function startWithConsent() {
  return request<Me>({ method: "POST", path: "/me/consent", mock: { key: "me.consent" } });
}
