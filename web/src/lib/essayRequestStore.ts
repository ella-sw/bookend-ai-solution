import { ESSAY_RULES } from "@/lib/api/types";
import type { NewEssayParams } from "@/lib/newEssayParams";

/**
 * AI 초안 3단계 '요청'의 입력값 (흐름 id·제안 id 키, 이 탭의 sessionStorage). 자유 입력이라 주소에는 넣지 않는다.
 * - request: 요청사항 입력값 (자르기 전 그대로, 최대 200자)
 * - 예전 값에 남은 다른 필드는 무시한다
 * 모든 기록 삭제 때 clearEssayRequests로 지운다.
 */
const PREFIX = "essayRequest:";
const memory = new Map<string, EssayRequestState>();
type Context = Pick<NewEssayParams, "f" | "s">;
const keyFor = ({ f, s }: Context) => (f ? `${PREFIX}${f}:${s ?? ""}` : null);

export interface EssayRequestState {
  request: string;
}

const EMPTY: EssayRequestState = { request: "" };

/** 서버로 보낼 값: 앞뒤 공백 제거, 비면 null */
export const normalizeEssayRequest = (value: string | null | undefined): string | null => value?.trim() || null;

/** 코드 포인트 200자까지 */
export const limitEssayRequest = (value: string) => Array.from(value).slice(0, ESSAY_RULES.requestMax).join("");

function parse(raw: string | null): EssayRequestState | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<EssayRequestState> | null;
    return { request: v && typeof v.request === "string" ? limitEssayRequest(v.request) : "" };
  } catch {
    return undefined;
  }
}

export function readEssayRequest(params: Context): EssayRequestState {
  const key = keyFor(params);
  if (!key) return EMPTY;
  let value = memory.get(key);
  if (value === undefined) {
    try {
      value = parse(window.sessionStorage.getItem(key));
    } catch {
      /* memory only */
    }
  }
  return value ?? EMPTY;
}

export function writeEssayRequest(params: Context, value: EssayRequestState) {
  const key = keyFor(params);
  if (!key) return;
  const next = { request: limitEssayRequest(value.request) };
  memory.set(key, next);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* memory only */
  }
}

/** 제안이 없어져 s를 뺄 때 입력값을 새 키로 옮긴다 */
export function moveEssayRequest(from: Context, to: Context) {
  if (keyFor(from) === keyFor(to)) return;
  const value = readEssayRequest(from);
  if (value.request) writeEssayRequest(to, value);
}

export function clearEssayRequests() {
  memory.clear();
  try {
    const keys = Object.keys(window.sessionStorage).filter((key) => key.startsWith(PREFIX) || key.startsWith("essayDirection:"));
    keys.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    /* memory cleared */
  }
}
