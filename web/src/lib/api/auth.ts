import { isAuthApiError, isAuthRefreshDiscardedError, isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
import { USE_MOCK } from "./config";

/**
 * 세션(익명 로그인·시연 계정 로그인 토큰) 다루기 — 목록 19번 (합의). client.ts·users.ts·O110만 쓴다.
 *
 * 실패 이유
 * - network: 연결 문제. 세션은 남아 있다 → '연결이 불안정해요' + [다시 시도]
 * - unauthorized: 세션이 없다 (없었거나 SDK가 지움) → 화면이 O110으로
 * - server: 설정 오류(env 누락·비밀 키) 또는 익명 로그인 거절
 *
 * 우리 코드는 세션을 직접 지우지 않는다 (signOut을 부르지 않음). 지우는 판단은 SDK에 맡긴다:
 * @supabase/auth-js 2.119.0 GoTrueClient._callRefreshToken — 갱신이 재시도 가능 오류(연결·5xx)로 실패하면 세션을 두고,
 * 그 밖의 오류는 access token이 아직 유효하면 두고, 만료됐을 때만 SDK가 지운다.
 * 그래서 실패 뒤에는 세션이 남았는지 다시 읽어 network / unauthorized를 나눈다.
 * (익명 사용자는 세션을 잃으면 기록에 다시 들어갈 수 없다.) 토큰은 어디에도 로그로 남기지 않는다.
 */

export type AuthFailure = "network" | "unauthorized" | "server";

export type TokenResult = { ok: true; token: string | null } | { ok: false; reason: AuthFailure };

const NETWORK: TokenResult = { ok: false, reason: "network" };
const UNAUTHORIZED: TokenResult = { ok: false, reason: "unauthorized" };
const SERVER: TokenResult = { ok: false, reason: "server" };

/** 설정 오류(env 누락·비밀 키)는 throw 대신 server로 돌려준다 */
function supabaseOrNull(): { ok: true; client: SupabaseClient | null } | { ok: false } {
  try {
    return { ok: true, client: getSupabase() };
  } catch {
    return { ok: false };
  }
}

/**
 * 갱신 실패 뒤 판단. 재시도 가능 오류면 network.
 * 그 밖의 오류는 SDK가 세션을 지웠는지 다시 읽어 본다: 남아 있으면 network, 없으면 unauthorized.
 */
async function afterRefreshFailure(client: SupabaseClient, error: unknown): Promise<TokenResult> {
  if (isAuthRetryableFetchError(error)) return NETWORK;
  try {
    const { data } = await client.auth.getSession();
    return data.session ? NETWORK : UNAUTHORIZED;
  } catch {
    return NETWORK;
  }
}

/** 지금 세션의 access token. 세션이 없으면 token = null (서버를 부르지 않음) */
export async function getAccessToken(): Promise<TokenResult> {
  if (USE_MOCK) {
    const { getMockSession } = await import("./mock/session");
    return { ok: true, token: getMockSession()?.access_token ?? null };
  }
  try {
    const sb = supabaseOrNull();
    if (!sb.ok) return SERVER;
    if (!sb.client) return { ok: true, token: null };
    // 만료가 가까우면 supabase-js가 여기서 새 토큰을 받아 온다
    const { data, error } = await sb.client.auth.getSession();
    if (error) return afterRefreshFailure(sb.client, error);
    return { ok: true, token: data.session?.access_token ?? null };
  } catch {
    return NETWORK;
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
  try {
    const sb = supabaseOrNull();
    if (!sb.ok) return SERVER;
    if (!sb.client) return UNAUTHORIZED;
    const { data, error } = await sb.client.auth.refreshSession();
    if (isAuthRefreshDiscardedError(error)) return getAccessToken();
    if (error) return afterRefreshFailure(sb.client, error);
    if (!data.session) return UNAUTHORIZED;
    return { ok: true, token: data.session.access_token };
  } catch {
    return NETWORK;
  }
}

/**
 * 세션이 있나 (서버를 부르지 않음). 첫 화면: false면 바로 O110 (목록 19번 ②).
 * 연결 문제로 확인이 안 되면 세션은 있는 것으로 본다 → O110에서 새 익명 사용자를 만들지 않게.
 * 설정 오류(server)면 false (세션을 읽을 수 없음 — 화면 다음 단계의 API가 server 오류를 알려 줌)
 */
export async function hasSession(): Promise<boolean> {
  const result = await getAccessToken();
  if (result.ok) return result.token !== null;
  return result.reason === "network";
}

let signingIn: Promise<TokenResult> | null = null;

/**
 * 익명 로그인. 이미 세션이 있으면 새로 만들지 않는다
 * (동의 요청이 실패해 [다시 시도]할 때 사용자가 또 생기지 않게).
 * 로그인 요청은 진행 중인 것 하나를 같이 기다린다 (버튼 연타·동시 호출로 사용자가 둘 생기지 않게). 끝나면 비운다.
 */
export async function ensureAnonymousSession(): Promise<TokenResult> {
  const current = await getAccessToken();
  if (!current.ok || current.token) return current;

  signingIn ??= signInAnonymously().finally(() => {
    signingIn = null;
  });
  return signingIn;
}

async function signInAnonymously(): Promise<TokenResult> {
  if (USE_MOCK) {
    const { signInMockAnonymously } = await import("./mock/session");
    return { ok: true, token: signInMockAnonymously().access_token };
  }
  try {
    const sb = supabaseOrNull();
    if (!sb.ok || !sb.client) return SERVER;
    const { data, error } = await sb.client.auth.signInAnonymously();
    if (error) return isAuthRetryableFetchError(error) ? NETWORK : SERVER;
    if (!data.session) return SERVER;
    return { ok: true, token: data.session.access_token };
  } catch {
    return NETWORK;
  }
}

/** 시연 계정 아이디에 "@"가 없으면 붙이는 도메인 (rec → rec@rowflow.app) */
const DEMO_EMAIL_DOMAIN = "@rowflow.app";

export const demoEmailOf = (id: string) => {
  const trimmed = id.trim();
  return trimmed.includes("@") ? trimmed : `${trimmed}${DEMO_EMAIL_DOMAIN}`;
};

/**
 * O110 시연 계정 로그인 (아이디·비밀번호). 회원가입은 없다.
 * 이미 익명 세션이 있어도 그대로 로그인한다 (Supabase가 세션을 바꿈).
 * 실패: 잘못된 아이디·비번(400 invalid credentials) → unauthorized / 연결 → network / 그 밖 → server
 */
export async function signInWithPassword(id: string, password: string): Promise<TokenResult> {
  if (!id.trim() || !password) return UNAUTHORIZED;
  if (USE_MOCK) {
    const { signInMockWithPassword } = await import("./mock/session");
    const session = signInMockWithPassword(id.trim(), password);
    return session ? { ok: true, token: session.access_token } : UNAUTHORIZED;
  }
  try {
    const sb = supabaseOrNull();
    if (!sb.ok || !sb.client) return SERVER;
    const { data, error } = await sb.client.auth.signInWithPassword({ email: demoEmailOf(id), password });
    if (error) {
      if (isAuthRetryableFetchError(error)) return NETWORK;
      if (isAuthApiError(error) && (error.code === "invalid_credentials" || error.status === 400)) return UNAUTHORIZED;
      return SERVER;
    }
    if (!data.session) return SERVER;
    return { ok: true, token: data.session.access_token };
  } catch {
    return NETWORK;
  }
}
