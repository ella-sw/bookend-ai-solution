import { request, type ApiResult } from "./client";
import type { Essay, EssayDraft, SaveEssayDraftInput, SaveEssayInput } from "./types";

/*
 * 직접 쓰기 (N140) — B routers/essays.py
 *   들어가기 전  getEssayDraft() → 있으면 H121 '이어서 쓰시겠습니까?'
 *   [임시 저장]  saveEssayDraft() — 직접 쓰기 임시 저장은 1개 (새로 하면 덮어씀)
 *   [저장]       saveEssay() → v1 → L120
 */

/**
 * 직접 쓰기 임시 저장 1개 (H121). 없으면 서버는 404 no_draft → 여기서 { ok: true, data: null }로 바꾼다
 */
export async function getEssayDraft(): Promise<ApiResult<EssayDraft | null>> {
  const res = await request<EssayDraft>({ method: "GET", path: "/essays/draft", mock: { key: "essays.draft.get" } });
  if (!res.ok && res.error.code === "no_draft") return { ok: true, data: null };
  return res;
}

/**
 * [임시 저장]: 만들거나 덮어쓴다 (본문이 비어도 됨). 이어 쓰는 중이면 essay_id.
 * 오류: 404 draft_not_found(이미 저장됨 → essay_id 없이 다시) / suggestion_not_found,
 * 422 material_not_available(삭제했거나 보관 전 소재)
 */
export function saveEssayDraft(input: SaveEssayDraftInput) {
  return request<EssayDraft>({ method: "POST", path: "/essays/draft", body: input, mock: { key: "essays.draft.save" } });
}

/**
 * [저장] (첫 저장): v1으로 저장하고 글을 돌려준다 → L120. 201, 같은 save_token(또는 이미 저장된 essay_id)이면 200.
 * 이어 쓰던 임시 저장이면 essay_id → 그 임시 저장이 이 글이 된다.
 * 오류: 422 empty_body·material_not_available, 404 draft_not_found·suggestion_not_found, 409 save_token_used
 */
export function saveEssay(input: SaveEssayInput) {
  return request<Essay>({ method: "POST", path: "/essays", body: input, mock: { key: "essays.save" } });
}
