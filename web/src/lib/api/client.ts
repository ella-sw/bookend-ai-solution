import { API_BASE_URL, DEFAULT_TIMEOUT_MS, USE_MOCK } from "./config";
import type { MockKey } from "./mock/keys";

/**
 * 모든 API 호출이 지나가는 한 곳.
 * - 결과는 throw 대신 ApiResult로 돌려준다 → 화면에서 실패를 빠뜨리지 않고 처리하게
 * - 목업 모드(USE_MOCK)면 같은 요청을 mock/ 의 가짜 응답으로 보낸다. 화면 코드는 차이를 모른다.
 */

export type ApiErrorKind = "network" | "timeout" | "server" | "not_found" | "conflict" | "bad_request";

export interface ApiError {
  kind: ApiErrorKind;
  status?: number;
  /** 화면에 그대로 보여도 되는 쉬운 문구 (화면에서 상황에 맞게 바꿔도 됨) */
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method: HttpMethod;
  /** 예: `/records/${id}/analysis` */
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** 목업에서 어떤 가짜 응답을 쓸지. params는 주소 안의 id 등 */
  mock: { key: MockKey; params?: Record<string, string> };
}

export const errorMessages: Record<ApiErrorKind, string> = {
  network: "연결이 불안정해요",
  timeout: "응답이 늦어요. 다시 시도해 주세요",
  server: "잠시 후 다시 시도해 주세요",
  not_found: "찾을 수 없어요",
  conflict: "이미 처리됐어요",
  bad_request: "입력을 확인해 주세요",
};

export function apiError(kind: ApiErrorKind, status?: number): ApiError {
  return { kind, status, message: errorMessages[kind] };
}

function kindFromStatus(status: number): ApiErrorKind {
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 400 && status < 500) return "bad_request";
  return "server";
}

function buildUrl(path: string, query?: RequestOptions["query"]) {
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  return `${API_BASE_URL}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * 로그인 정보 헤더. 익명 사용자 방식(Supabase 익명 로그인 토큰을 넘길지 등)은
 * 목록 16번(서버 구조) 합의 뒤 여기만 채운다.
 */
async function authHeaders(): Promise<Record<string, string>> {
  return {};
}

export async function request<T>(options: RequestOptions): Promise<ApiResult<T>> {
  if (USE_MOCK) {
    const { runMock } = await import("./mock/handlers");
    return runMock<T>(options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(buildUrl(options.path, options.query), {
      method: options.method,
      headers: {
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(await authHeaders()),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) return { ok: false, error: apiError(kindFromStatus(res.status), res.status) };

    const text = await res.text();
    return parseJson<T>(text, res.status);
  } catch {
    return { ok: false, error: apiError(controller.signal.aborted ? "timeout" : "network") };
  } finally {
    clearTimeout(timer);
  }
}

/** 응답 본문 읽기. 서버가 JSON이 아닌 걸 보내면 '연결 문제'가 아니라 '서버 오류'로 알린다 */
function parseJson<T>(text: string, status: number): ApiResult<T> {
  if (!text) return { ok: true, data: null as T };
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, error: apiError("server", status) };
  }
}
