import { getActiveQna, getFreeDraft, getQnaDraft, type ApiError } from "@/lib/api";
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
  | { type: "confirm"; kind: CollectKind }
  | { type: "error"; error: ApiError };

export async function decideCollect(kind: CollectKind): Promise<CollectDecision> {
  if (kind === "free") {
    const draft = await getFreeDraft();
    if (!draft.ok) return { type: "error", error: draft.error };
    return draft.data ? { type: "confirm", kind } : { type: "go", href: collectRoutes.free() };
  }

  // ⑩ 진행 중 대화가 있으면 H121 없이 이어서
  const active = await getActiveQna();
  if (!active.ok) return { type: "error", error: active.error };
  if (active.data) return { type: "go", href: collectRoutes.ai("active") };

  const draft = await getQnaDraft();
  if (!draft.ok) return { type: "error", error: draft.error };
  return draft.data ? { type: "confirm", kind } : { type: "go", href: collectRoutes.ai() };
}

/** H121 [예] / [아니오]로 갈 곳. [아니오]는 새로 시작 — 임시 저장(draft)·진행 중(active)은 건드리지 않는다 (⑪) */
export function confirmTargets(kind: CollectKind) {
  return kind === "free"
    ? { resume: collectRoutes.free("draft"), fresh: collectRoutes.free() }
    : { resume: collectRoutes.ai("draft"), fresh: collectRoutes.ai() };
}
