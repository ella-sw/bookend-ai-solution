import { ensureAnonymousSession, hasSession } from "./auth";
import { apiError, request, type ApiResult } from "./client";
import type { Me } from "./types";

/**
 * 사용자·첫 실행 (목록 19번 합의, B server/app/routers/me.py · auth.py)
 *
 * 첫 화면 순서
 * 1. hasSession() — 서버를 부르지 않음. false면 바로 O110
 * 2. true면 getMe()
 *    · ok → 홈
 *    · error.kind = "not_consented" → O110 (세션은 그대로. [동의하고 시작하기]가 같은 사용자로 동의)
 *    · error.kind = "unauthorized" → 세션이 없음 (새 토큰 받기가 거절돼 SDK가 지움) → O110
 *    · error.kind = "network" 등 → '연결이 불안정해요' + [다시 시도] (세션 유지)
 *    · error.kind = "server" → 서버 오류 또는 설정 오류(env 누락·비밀 키)
 * 3. O110 [동의하고 시작하기] → startWithConsent()
 *
 * 목업(USE_MOCK)도 같은 흐름이다. 목업 세션은 이 브라우저의 localStorage에 남는다 (mock/session.ts).
 */

export { hasSession };

/**
 * 내 정보. 이번 접속(last_seen_at)도 서버가 기록한다 (③).
 * 동의 전이면 서버는 404 not_consented → 여기서 kind = "not_consented"로 바꾼다
 * (다른 API의 403 not_consented와 화면에서 같게 처리하도록)
 */
export async function getMe(): Promise<ApiResult<Me>> {
  const res = await request<Me>({ method: "GET", path: "/me", mock: { key: "me.get" } });
  if (!res.ok && res.error.code === "not_consented") {
    return { ok: false, error: apiError("not_consented", res.error.status, "not_consented") };
  }
  return res;
}

/**
 * O110 [동의하고 시작하기]: signInAnonymously() → POST /me/consent (본문 없음).
 * - 이미 세션이 있으면 익명 로그인을 다시 하지 않는다 → [다시 시도] 때 사용자가 또 생기지 않음
 * - 다시 불러도 서버는 처음 동의 시각을 그대로 둔다
 * - 익명 로그인은 진행 중인 요청 하나를 같이 기다린다 (연타해도 사용자 1명)
 * - 실패하면 '연결이 불안정해요' + [다시 시도] (RetryNotice)
 */
export async function startWithConsent(): Promise<ApiResult<Me>> {
  const session = await ensureAnonymousSession();
  if (!session.ok) return { ok: false, error: apiError(session.reason) };
  return request<Me>({ method: "POST", path: "/me/consent", mock: { key: "me.consent" } });
}
