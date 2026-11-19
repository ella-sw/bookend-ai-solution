import { getActiveQna, getFreeDraft, getQnaDraft, type ApiError, type IsoTime } from "@/lib/api";
import { formatMonthDay } from "@/lib/format";
import { collectRoutes } from "@/lib/routes";

export type CollectKind = "free" | "ai";

/**
 * H120에서 방식을 고른 뒤 어디로 갈지 (UI 설계서 v7 H120·H121, 목록 17번 ⑩·⑪)
 * - go: 바로 이동 (새로 시작, 또는 AI 진행 중 대화 이어서)
 * - confirm: 임시 저장이 있음 → H121 이어 쓰기 확인
 * - error: 조회 실패 → 새로 시작으로 넘기지 않는다 (임시 저장을 덮어쓰지 않게)
 */
export type CollectDecision =
  | { type: "go"; href: string }
  | { type: "confirm"; kind: CollectKind; updatedAt: IsoTime }
  | { type: "error"; error: ApiError };

export async function decideCollect(kind: CollectKind): Promise<CollectDecision> {
  if (kind === "free") {
    const draft = await getFreeDraft();
    if (!draft.ok) return { type: "error", error: draft.error };
    return draft.data ? { type: "confirm", kind, updatedAt: draft.data.updated_at } : { type: "go", href: collectRoutes.free() };
  }

  // ⑩ 진행 중 대화가 있으면 H121 없이 이어서
  const active = await getActiveQna();
  if (!active.ok) return { type: "error", error: active.error };
  if (active.data) return { type: "go", href: collectRoutes.ai("active") };

  const draft = await getQnaDraft();
  if (!draft.ok) return { type: "error", error: draft.error };
  return draft.data ? { type: "confirm", kind, updatedAt: draft.data.updated_at } : { type: "go", href: collectRoutes.ai() };
}

/**
 * H121 이어 쓰기 확인 문구 (목록 17번). 자유 기록·AI 문답(CollectSheet)과 직접 쓰기 글(useDirectStart)이 같이 쓴다.
 * 제목 뒤 날짜는 임시 저장의 updated_at (예: '임시 저장한 AI 문답이 있어요 (11.19)')
 * 버튼: [새로 시작](기존 [아니오]) / [이어 쓰기](기존 [예], 주 버튼)
 */
export function resumeDialogCopy(kind: CollectKind | "essay", updatedAt: IsoTime | null) {
  const what = kind === "free" ? "자유 기록" : kind === "ai" ? "AI 문답" : "글";
  const date = formatMonthDay(updatedAt);
  return {
    title: `임시 저장한 ${what}이 있어요${date ? ` (${date})` : ""}`,
    description: "새로 시작해서 임시 저장하면 지금 임시 저장은 지워져요.",
    freshLabel: "새로 시작",
    resumeLabel: "이어 쓰기",
  };
}

/** H121 [예] / [아니오]로 갈 곳. [아니오]는 새로 시작 — 임시 저장(draft)·진행 중(active)은 건드리지 않는다 (⑪) */
export function confirmTargets(kind: CollectKind) {
  return kind === "free"
    ? { resume: collectRoutes.free("draft"), fresh: collectRoutes.free() }
    : { resume: collectRoutes.ai("draft"), fresh: collectRoutes.ai() };
}
