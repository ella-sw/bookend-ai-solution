import {
  isAuthApiError,
  isAuthRefreshDiscardedError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
} from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
import { USE_MOCK } from "./config";

/**
 * 세션(익명 로그인 토큰) 다루기 — 목록 19번 (합의). client.ts·users.ts만 쓴다.
 *
 * 실패 이유를 나눈다:
 * - network: 연결 문제 (Supabase에 닿지 못함·5xx). 세션은 지우지 않는다 → '연결이 불안정해요' + [다시 시도]
 * - unauthorized: 세션 무효 (refresh token이 거절됨·세션 없음). 이때만 세션을 지운다 → 화면이 O110으로
 * 이유: 익명 사용자는 세션을 지우면 기록에 다시 들어갈 수 없다. 모르는 오류는 '연결 문제'로 보고 세션을 남긴다.
 * 토큰은 어디에도 로그로 남기지 않는다.
 */

export type AuthFailure = "network" | "unauthorized" | "server";

export type TokenResult = { ok: true; token: string | null } | { ok: false; reason: AuthFailure };

/** 세션 무효일 때만: 이 브라우저의 세션을 지운다 (서버에 로그아웃 요청은 보내지 않음) */
async function clearSession() {
  if (USE_MOCK) {
    const { clearMockSession } = await import("./mock/session");
    clearMockSession();
    return;
  }
  try {
    await getSupabase()?.auth.signOut({ scope: "local" });
  } catch {
    // 지우기 실패는 무시 (다음 요청에서 다시 세션 무효로 판단됨)
  }
}

/** Supabase 오류 → 실패 이유. 세션 무효면 세션을 지운다 */
async function classify(error: unknown): Promise<TokenResult> {
  if (isAuthRetryableFetchError(error)) return { ok: false, reason: "network" };
  const invalid =
    isAuthSessionMissingError(error) ||
    (isAuthApiError(error) && error.status >= 400 && error.status < 500);
  if (invalid) {
    await clearSession();
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: false, reason: "network" };
}

/** 지금 세션의 access token. 세션이 없으면 token = null (서버를 부르지 않음) */
export async function getAccessToken(): Promise<TokenResult> {
  if (USE_MOCK) {
    const { getMockSession } = await import("./mock/session");
    return { ok: true, token: getMockSession()?.access_token ?? null };
  }
  const supabase = getSupabase();
  if (!supabase) return { ok: true, token: null };
  try {
    // 만료가 가까우면 supabase-js가 여기서 새 토큰을 받아 온다
    const { data, error } = await supabase.auth.getSession();
    if (error) return classify(error);
    return { ok: true, token: data.session?.access_token ?? null };
  } catch (e) {
    return classify(e);
  }
}

let refreshing: Promise<TokenResult> | null = null;

/**
 * 401 뒤 새 토큰 받기 (refreshSession). 동시에 여러 요청이 401을 받아도 한 번만 받는다.
 * 새 토큰을 받았지만 버려진 경우(다른 탭·동작이 세션을 바꿈)는 지금 세션을 다시 읽는다.
 */
export function refreshAccessToken(): Promise<TokenResult> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<TokenResult> {
  if (USE_MOCK) return getAccessToken();
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "unauthorized" };
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (isAuthRefreshDiscardedError(error)) return getAccessToken();
    if (error) return classify(error);
    if (!data.session) {
      await clearSession();
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: true, token: data.session.access_token };
  } catch (e) {
    return classify(e);
  }
}

/**
 * 세션이 있나 (서버를 부르지 않음). 첫 화면: false면 바로 O110 (목록 19번 ②).
 * 토큰 갱신이 연결 문제로 실패해도 세션은 있는 것으로 본다 → O110에서 새 익명 사용자를 만들지 않게
 */
export async function hasSession(): Promise<boolean> {
  const result = await getAccessToken();
  if (result.ok) return result.token !== null;
  return result.reason === "network";
}

/**
 * 익명 로그인. 이미 세션이 있으면 새로 만들지 않는다
 * (동의 요청이 실패해 [다시 시도]할 때 사용자가 또 생기지 않게).
 */
export async function ensureAnonymousSession(): Promise<TokenResult> {
  const current = await getAccessToken();
  if (!current.ok || current.token) return current;

  if (USE_MOCK) {
    const { signInMockAnonymously } = await import("./mock/session");
    return { ok: true, token: signInMockAnonymously().access_token };
  }
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "server" };
  try {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) return { ok: false, reason: isAuthRetryableFetchError(error) ? "network" : "server" };
    if (!data.session) return { ok: false, reason: "server" };
    return { ok: true, token: data.session.access_token };
  } catch {
    return { ok: false, reason: "network" };
  }
}
