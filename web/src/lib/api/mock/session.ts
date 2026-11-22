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
  /** 마지막으로 모든 기록을 지운 시각 (users.data_cleared_at) */
  cleared_at?: string | null;
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

/** 목업 시연 계정 (아이디만 맞으면 비밀번호는 빈 값이 아니면 아무 값) */
const MOCK_DEMO_IDS = ["rec", "guest"];

/**
 * signInWithPassword() 흉내 (O110 시연 계정). rec·guest (또는 rec@rowflow.app 등) + 빈 값이 아닌 비밀번호면 성공.
 * 지금 세션(익명 포함)을 그 계정의 세션으로 바꾼다. 계정마다 user_id는 늘 같다.
 * 동의 상태는 기존 목업 규칙을 따른다: 처음엔 동의 전 → O110 동의 단계. 동의하면 계정별로 기억해 두고
 * 다른 계정으로 바꿨다 다시 로그인해도 이어서 쓴다 (실제 서버의 users 행 흉내)
 */
export function signInMockWithPassword(id: string, password: string): MockSession | null {
  const name = id.toLowerCase().replace(/@rowflow\.app$/, "");
  if (!MOCK_DEMO_IDS.includes(name) || !password) return null;
  const userId = `mock-demo-${name}`;
  const current = getMockSession();
  const session: MockSession =
    current?.user_id === userId
      ? current
      : { user_id: userId, access_token: `mock-${newId()}`, consented_at: readDemoConsents()[userId] ?? null };
  save(session);
  return session;
}

/** 시연 계정별 동의 시각 (계정을 바꿨다 돌아와도 users 행의 동의가 남는 것 흉내) */
const DEMO_CONSENT_KEY = "rowflow.mock.demoConsents.v1";
let demoConsentMemory: Record<string, string> = {};

function readDemoConsents(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(DEMO_CONSENT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : demoConsentMemory;
  } catch {
    return demoConsentMemory;
  }
}

function saveDemoConsent(userId: string, at: string) {
  demoConsentMemory = { ...readDemoConsents(), [userId]: at };
  try {
    window.localStorage.setItem(DEMO_CONSENT_KEY, JSON.stringify(demoConsentMemory));
  } catch {
    // 저장이 막힌 환경: 메모리에만 둠
  }
}

export function setMockCleared(at: string) {
  const session = getMockSession();
  if (session) save({ ...session, cleared_at: at });
}

export function setMockConsent(at: string) {
  const session = getMockSession();
  if (session && !session.consented_at) {
    save({ ...session, consented_at: at });
    if (session.user_id.startsWith("mock-demo-")) saveDemoConsent(session.user_id, at);
  }
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
