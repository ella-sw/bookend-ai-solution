import { getAccessToken, refreshAccessToken, type AuthFailure } from "./auth";
import { API_BASE_URL, DEFAULT_TIMEOUT_MS, USE_MOCK } from "./config";
import type { MockKey } from "./mock/keys";

/**
 * 모든 API 호출이 지나가는 한 곳.
 * - 결과는 throw 대신 ApiResult로 돌려준다 → 화면에서 실패를 빠뜨리지 않고 처리하게
 * - 목업 모드(USE_MOCK)면 같은 요청을 mock/ 의 가짜 응답으로 보낸다. 화면 코드는 차이를 모른다.
 * - 인증 (목록 19번, B server/app/auth.py): 모든 요청에 Authorization: Bearer <access_token>.
 *   401이면 새 토큰을 받아 딱 1회 다시 보낸다. O110으로 보내는 건 화면이 한다 (kind로 판단).
 * - 토큰·요청 본문은 콘솔에 남기지 않는다.
 */

/**
 * - unauthorized: 세션이 없다 (처음부터 없었거나, 새 토큰 받기가 거절돼 SDK가 지움). 화면은 O110으로
 * - not_consented: 동의 전 (403 not_consented, GET /me의 404 not_consented도 같게) → 세션은 남김. 화면은 O110으로
 * - network: 연결 문제 (토큰 갱신 실패 뒤 세션이 남아 있는 경우 포함). 세션은 남음 → '연결이 불안정해요' + [다시 시도]
 * - server: 서버 오류, 또는 설정 오류(Supabase env 누락·비밀 키). throw하지 않고 ApiResult로 돌려준다
 */
export type ApiErrorKind =
  | "network"
  | "timeout"
  | "server"
  | "not_found"
  | "conflict"
  | "bad_request"
  | "unauthorized"
  | "not_consented";

/**
 * 서버(B FastAPI)가 응답 본문 detail에 넣어 주는 오류 코드. 같은 kind 안에서 상황을 나눌 때 쓴다.
 * - 404 not_found: conversation_not_found(열린 문답 없음·이미 저장됨), draft_not_found(이어 쓰던 자유 기록
 *   임시 저장이 없거나 이미 저장됨), no_draft(자유 기록 임시 저장 없음 — getFreeDraft가 null로 바꿈),
 *   record_not_found, not_consented(GET /me: 동의 전 → O110)
 * - 409 conflict: finished(답변 7개), not_pending_question(답을 기다리는 질문이 아님), first_question_not_replaceable,
 *   replace_limit(6회), not_draft, not_active, need_more_answers(답변 2개 전 저장)
 * - 403 not_consented: 동의 전 (B db.require_consent)
 * - 소재 (B analysis.py·materials.py): 409 cannot_reanalyze(done·empty) / material_deleted(삭제한 소재의 원본) /
 *   material_confirmed(이미 보관), 404 material_not_found, 422 unknown_topic,
 *   409 no_result (M131 [바꾸기]인데 다시 분석 결과가 없음)
 * - 글·제안 (B essays.py·suggestions.py): 404 suggestion_not_found·essay_not_found·draft_not_found,
 *   422 material_not_available(삭제했거나 보관 전 소재)·empty_body, 409 save_token_used
 * - AI 초안 (B ai_essays.py): 502 ai_failed('에세이를 만들지 못했어요' + [다시 시도]), 429 daily_limit,
 *   409 no_result(다시 만든 결과가 없음·이미 저장됨), 404 version_not_found
 * - 422 bad_request: invalid_daily_question, empty_body, missing_field, unexpected_field, record_type_mismatch
 *   (missing_field·unexpected_field는 서버가 "missing_field: record_type"처럼 칸 이름을 붙여 줌 → 앞부분만 code)
 * - 404 not_found (이벤트): record_not_found, essay_not_found, suggestion_not_found
 * - 502 server: ai_failed (오늘의 질문 만들기 실패)
 * - 429 bad_request: daily_limit (오늘 AI 호출을 다 씀. B R32 — 다시 분석·AI 초안에서 씀, 화면 처리는 그 화면 개발 때.
 *   문답은 오류 대신 QnaState.daily_limit_reached로 알려 줌)
 * 모르는 코드도 그대로 받는다 (서버가 코드를 늘려도 화면이 깨지지 않게).
 */
export type ApiErrorCode =
  | "conversation_not_found"
  | "draft_not_found"
  | "no_draft"
  | "record_not_found"
  | "not_consented"
  | "finished"
  | "not_pending_question"
  | "first_question_not_replaceable"
  | "replace_limit"
  | "not_draft"
  | "not_active"
  | "need_more_answers"
  | "invalid_daily_question"
  | "empty_body"
  | "missing_field"
  | "unexpected_field"
  | "record_type_mismatch"
  | "essay_not_found"
  | "suggestion_not_found"
  | "ai_failed"
  | "daily_limit"
  | "cannot_reanalyze"
  | "material_deleted"
  | "material_confirmed"
  | "material_not_found"
  | "unknown_topic"
  | "no_result"
  | "suggestion_not_found"
  | "material_not_available"
  | "essay_not_found"
  | "save_token_used"
  | "version_not_found"
  | (string & {});

export interface ApiError {
  kind: ApiErrorKind;
  status?: number;
  /** 응답 본문의 오류 코드. 없으면 undefined */
  code?: ApiErrorCode;
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
  /** 배열이면 같은 이름으로 여러 번 (예: ?selected=a&selected=b) */
  query?: Record<string, string | number | readonly string[] | undefined>;
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
  unauthorized: "처음 화면에서 다시 시작해 주세요",
  not_consented: "시작하려면 안내에 동의해 주세요",
};

export function apiError(kind: ApiErrorKind, status?: number, code?: ApiErrorCode): ApiError {
  return { kind, status, ...(code ? { code } : {}), message: errorMessages[kind] };
}

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * 오류 응답 본문에서 오류 코드를 꺼낸다. 받는 모양:
 *   { "code": "draft_not_found" }
 *   { "detail": { "code": "draft_not_found" } }   (FastAPI HTTPException(detail={...}))
 *   { "detail": "draft_not_found" }               (FastAPI HTTPException(detail="..."))
 *   { "detail": "missing_field: record_type" }    → "missing_field" (콜론 뒤 칸 이름은 버림)
 *   { "error": { "code": "draft_not_found" } }
 * 코드 모양(snake_case)이 아닌 문장·검사 오류 목록은 무시한다.
 */
export function readErrorCode(text: string): ApiErrorCode | undefined {
  if (!text) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const b = body as { code?: unknown; detail?: unknown; error?: unknown };
  const pick = (v: unknown) => {
    if (typeof v !== "string") return undefined;
    const head = v.split(":")[0].trim();
    return ERROR_CODE_PATTERN.test(head) && (head === v || v.startsWith(`${head}: `)) ? head : undefined;
  };
  const codeOf = (v: unknown) => (v && typeof v === "object" ? pick((v as { code?: unknown }).code) : undefined);
  return pick(b.code) ?? codeOf(b.detail) ?? pick(b.detail) ?? codeOf(b.error);
}

function kindFromStatus(status: number, code?: ApiErrorCode): ApiErrorKind {
  if (code === "not_consented") return "not_consented";
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
        .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(String(x))}`))
        .join("&")
    : "";
  return `${API_BASE_URL}${path}${qs ? `?${qs}` : ""}`;
}

/** 로그인 정보 헤더 (B: HTTPBearer) */
function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function authError(reason: AuthFailure): ApiError {
  return apiError(reason, reason === "unauthorized" ? 401 : undefined);
}

type SendResult = { ok: true; status: number; text: string } | { ok: false; error: ApiError };

/** 한 번 보내기. 시간 제한은 보낼 때마다 따로 센다 */
async function send(options: RequestOptions, body: string | undefined, token: string): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(buildUrl(options.path, options.query), {
      method: options.method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(token),
      },
      body,
      signal: controller.signal,
    });
    // 본문까지 받은 뒤 시간 제한을 푼다 (본문을 받다 끊기면 연결 문제)
    return { ok: true, status: res.status, text: await res.text() };
  } catch {
    return { ok: false, error: apiError(controller.signal.aborted ? "timeout" : "network") };
  } finally {
    clearTimeout(timer);
  }
}

export async function request<T>(options: RequestOptions): Promise<ApiResult<T>> {
  if (USE_MOCK) {
    const { runMock } = await import("./mock/handlers");
    return runMock<T>(options);
  }

  const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;

  const auth = await getAccessToken();
  if (!auth.ok) return { ok: false, error: authError(auth.reason) };
  // 세션이 없으면 서버를 부르지 않는다 (화면이 O110으로)
  if (!auth.token) return { ok: false, error: authError("unauthorized") };

  let sent = await send(options, body, auth.token);
  if (!sent.ok) return sent;

  // 401: 새 토큰을 받아 1회만 다시 보낸다 (같은 요청은 최대 2번)
  if (sent.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed.ok) return { ok: false, error: authError(refreshed.reason) };
    if (!refreshed.token) return { ok: false, error: authError("unauthorized") };
    sent = await send(options, body, refreshed.token);
    if (!sent.ok) return sent;
    // 새 토큰도 거절: Supabase는 세션이 유효하다고 했으므로 서버 쪽 문제로 본다.
    // 세션은 그대로 둔다 (지우면 기록에 다시 못 들어감) → '잠시 후 다시 시도'
    if (sent.status === 401) return { ok: false, error: apiError("server", 401) };
  }

  const { status, text } = sent;
  if (status < 200 || status >= 300) {
    const code = readErrorCode(text);
    return { ok: false, error: apiError(kindFromStatus(status, code), status, code) };
  }
  return parseJson<T>(text, status);
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
