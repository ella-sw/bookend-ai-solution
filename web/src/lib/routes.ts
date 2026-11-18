/**
 * 화면 ID ↔ 주소(라우트) 한곳 정리.
 * 기준: UI 설계서 v7 + docs/v6_이후_수정대기목록.md '합의' 항목.
 * 팝업(H120, W113 등)은 주소가 없고 각 화면 안의 부품으로 만든다.
 */

export const routes = {
  onboarding: "/onboarding", // O110
  home: "/", // H110
  collectFree: "/collect/free", // W110
  collectAi: "/collect/ai", // W210
  materials: "/materials", // M110
  materialReview: (recordId: string) => `/materials/review/${recordId}`, // M120
  material: (materialId: string) => `/materials/${materialId}`, // M130
  keptRecord: (recordId: string) => `/materials/records/${recordId}`, // M130 (보관한 원본)
  newSelect: "/new", // N110
  newDirection: "/new/direction", // N120
  suggestion: (suggestionId: string) => `/new/suggestion/${suggestionId}`, // N130
  newDirect: "/new/write", // N140 직접 쓰기
  newAiStyle: "/new/draft", // W310 · W320 AI 초안 문체·길이
  draftResult: "/new/draft/result", // W330
  draftRegenerate: "/new/draft/regenerate", // W340
  library: "/library", // L110
  essay: (essayId: string) => `/library/${essayId}`, // L120
  settings: "/settings", // S110
} as const;

/**
 * 이어 쓰기 표시 (H120·H121, 목록 17번 ⑩·⑪)
 * - draft: H121 [예]로 임시 저장을 이어서 (자유 기록·AI 질문)
 * - active: AI 질문의 진행 중 대화를 H121 없이 이어서
 * 표시가 없으면 새로 시작 (기존 임시 저장은 건드리지 않음)
 */
export type ResumeMode = "draft" | "active";

export const collectRoutes = {
  free: (resume?: Extract<ResumeMode, "draft">) => (resume ? `${routes.collectFree}?resume=${resume}` : routes.collectFree),
  ai: (resume?: ResumeMode) => (resume ? `${routes.collectAi}?resume=${resume}` : routes.collectAi),
};

/** 하단 탭 4개 (홈 · 소재함 · 내 서재 · 설정) */
export const tabs = [
  { key: "home", label: "홈", href: routes.home },
  { key: "materials", label: "소재함", href: routes.materials },
  { key: "library", label: "내 서재", href: routes.library },
  { key: "settings", label: "설정", href: routes.settings },
] as const;

export type TabKey = (typeof tabs)[number]["key"];

/**
 * 하단 탭을 숨기는 화면: 첫 실행, 기록(소재 모으기), 소재 확인, 글쓰기.
 * (모바일 웹 공통 규칙 4: 기록·글쓰기 화면에서는 숨긴다)
 */
const HIDE_TAB_PREFIXES = [
  routes.onboarding,
  "/collect",
  "/new",
];

function matches(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function shouldShowTabBar(pathname: string) {
  // 소재함(M110)은 탭 화면, 그 아래 화면(M120 소재 확인, M130 소재 상세·보관한 원본)은 탭 없이
  // 아래 고정 버튼([이 소재로 글쓰기] 등)을 쓴다 (UI 설계서 v7 12·14~16쪽)
  if (pathname.startsWith(`${routes.materials}/`)) return false;
  // 내 서재(L110)도 같은 규칙: 글 상세(L120)는 탭 없이 (UI 설계서 v7 25·26쪽)
  if (pathname.startsWith(`${routes.library}/`)) return false;
  return !HIDE_TAB_PREFIXES.some((prefix) => matches(pathname, prefix));
}

export function activeTab(pathname: string): TabKey | null {
  if (pathname === "/") return "home";
  if (matches(pathname, routes.materials)) return "materials";
  if (matches(pathname, routes.library)) return "library";
  if (matches(pathname, routes.settings)) return "settings";
  return null;
}

/** 목업용 화면 목록 (개발 중 확인용 /dev/screens 에서 사용) */
export const screens = [
  { id: "O110", name: "첫 실행 안내", href: routes.onboarding },
  { id: "H110", name: "홈", href: routes.home },
  { id: "W110", name: "자유롭게 기록하기", href: routes.collectFree },
  { id: "W210", name: "AI 질문에 답하기", href: routes.collectAi },
  { id: "M110", name: "소재함", href: routes.materials },
  { id: "M120", name: "소재 확인", href: routes.materialReview("sample") },
  { id: "M130", name: "소재 상세", href: routes.material("sample") },
  { id: "M130", name: "보관한 원본", href: routes.keptRecord("sample") },
  { id: "N110", name: "소재 고르기", href: routes.newSelect },
  { id: "N120", name: "글의 방향 확인", href: routes.newDirection },
  { id: "N130", name: "글쓰기 제안 상세", href: routes.suggestion("sample") },
  { id: "N140", name: "직접 쓰기", href: routes.newDirect },
  { id: "W310", name: "AI 초안 · 문체·길이 선택", href: routes.newAiStyle },
  { id: "W330", name: "AI 초안 · 초안 결과", href: routes.draftResult },
  { id: "W340", name: "AI 초안 · 다시 만든 결과", href: routes.draftRegenerate },
  { id: "L110", name: "내 서재", href: routes.library },
  { id: "L120", name: "글 상세", href: routes.essay("sample") },
  { id: "S110", name: "설정", href: routes.settings },
] as const;
