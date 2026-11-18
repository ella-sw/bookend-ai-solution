import { newId } from "./store";

/**
 * 목업 세션 (Supabase 익명 로그인 흉내). 이 브라우저의 localStorage에 남는다 → 새로고침해도 유지.
 * 저장이 막힌 환경(시크릿 창 등)이면 이 탭 메모리에만 둔다.
 * consented_at = O110 동의 시각 (실제 서버의 users 행). 모든 기록 지우기 뒤에도 남는다 (ERD 규칙 14)
 */
export interface MockSession {
  user_id: string;
  access_token: string;
  consented_at: string | null;
}

const STORAGE_KEY = "rowflow.mock.session.v1";
let memory: MockSession | null = null;

export function getMockSession(): MockSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as MockSession;
    return memory;
  } catch {
    return memory;
  }
}

function save(session: MockSession | null) {
  memory = session;
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 저장이 막힌 환경: 메모리에만 둠
  }
}

/** signInAnonymously() 흉내: 새 익명 사용자 */
export function signInMockAnonymously(): MockSession {
  const session: MockSession = { user_id: newId(), access_token: `mock-${newId()}`, consented_at: null };
  save(session);
  return session;
}

export function setMockConsent(at: string) {
  const session = getMockSession();
  if (session && !session.consented_at) save({ ...session, consented_at: at });
}

/** /dev/mock 바로가기: 동의한 사용자로 시작 (세션이 있으면 그 사용자로 동의만) */
export function startMockConsentedUser(at: string): MockSession {
  if (!getMockSession()) signInMockAnonymously();
  setMockConsent(at);
  return getMockSession()!;
}

/** 세션 지우기 (SDK가 세션을 지운 상황 흉내, /dev/mock) */
export function clearMockSession() {
  save(null);
}
