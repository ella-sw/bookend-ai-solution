import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { USE_MOCK } from "./api/config";

/**
 * 브라우저용 Supabase 클라이언트 (하나만 만든다).
 * 목록 19번 ①: 프론트는 Supabase를 익명 로그인(signInAnonymously)·시연 계정 로그인(signInWithPassword)·세션 관리에만 쓴다.
 * 데이터는 모두 백엔드 API(FastAPI)로 주고받는다 → 여기서 .from()으로 DB를 직접 읽지 않는다.
 *
 * env (web/.env.local, 이름은 web/.env.example):
 * - NEXT_PUBLIC_SUPABASE_URL
 * - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY — 공개(publishable) 키만. service_role·secret 키는 절대 넣지 않는다
 *   (NEXT_PUBLIC_ 값은 브라우저에 그대로 나간다)
 *
 * 목업(USE_MOCK)이면 만들지 않는다 → null. 서버 렌더링 중에도 null (세션은 브라우저 저장소에 있음).
 * env 누락·비밀 키면 throw한다. api/auth.ts가 받아서 reason = "server"(ApiResult)로 바꾼다.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

let client: SupabaseClient | null = null;

/** 비밀 키를 실수로 넣었는지 확인 (sb_secret_… 또는 role = service_role인 예전 JWT 키) */
function isSecretKey(key: string) {
  if (key.startsWith("sb_secret_")) return true;
  const payload = key.split(".")[1];
  if (!payload) return false;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return (JSON.parse(json) as { role?: unknown }).role === "service_role";
  } catch {
    return false;
  }
}

export function getSupabase(): SupabaseClient | null {
  if (USE_MOCK || typeof window === "undefined") return null;
  if (client) return client;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY를 web/.env.local에 넣어 주세요 (web/.env.example 참고).",
    );
  }
  if (isSecretKey(SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY에 비밀 키가 들어 있어요. 공개(publishable) 키로 바꿔 주세요.");
  }

  client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      // 익명 사용자는 세션을 잃으면 기록에 다시 들어갈 수 없다 → 브라우저 저장소에 남기고 자동 갱신
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
