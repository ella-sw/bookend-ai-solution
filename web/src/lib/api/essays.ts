import { request, type ApiResult } from "./client";
import type {
  CreateAiDraftInput,
  Essay,
  EssayCard,
  EssayDraft,
  EssayLength,
  RegenerateBase,
  RegenResult,
  SaveEssayDraftInput,
  SaveEssayInput,
  Style,
} from "./types";

/** AI를 부르는 요청의 제한 시간 (B가 AI를 최대 55초 기다림) */
const AI_TIMEOUT_MS = 70_000;

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

/* ---------- 글 상세 · AI 초안 (W310~W341) — B essays.py · ai_essays.py ---------- */

/** 글 상세: 버전들(초안 → v1 → …)과 사용한 소재. 404 essay_not_found */
export function getEssay(essayId: string) {
  return request<Essay>({ method: "GET", path: `/essays/${essayId}`, mock: { key: "essays.get", params: { essayId } } });
}

/**
 * [초안 만들기]: AI 초안을 만들어 '초안'(version 0)으로 보관하고 글을 돌려준다 → W330.
 * 201, 같은 save_token이면 200 + 이미 만든 글 (AI를 다시 부르지 않음).
 * 오류: 422 material_not_available, 404 suggestion_not_found, 429 daily_limit, 502 ai_failed
 */
export function createAiDraft(input: CreateAiDraftInput) {
  return request<Essay>({ method: "POST", path: "/essays/ai", body: input, timeoutMs: AI_TIMEOUT_MS, mock: { key: "essays.ai.create" } });
}

/**
 * [다시 만들기]: 보고 있던 버전(또는 직전 결과)을 바탕으로 다시 쓴다. 결과는 [저장하기] 전까지 버전이 아니다 → W340.
 * 오류: 409 no_result(직전 결과가 없거나 이미 저장됨), 404 version_not_found·essay_not_found, 429 daily_limit, 502 ai_failed
 */
export function regenerateEssay(essayId: string, base: RegenerateBase, style: Style, length: EssayLength) {
  return request<RegenResult>({
    method: "POST",
    path: `/essays/${essayId}/regenerate`,
    body: { ...base, style, length },
    timeoutMs: AI_TIMEOUT_MS,
    mock: { key: "essays.regenerate", params: { essayId } },
  });
}

/**
 * W341 [저장하기]: 다시 만든 결과를 다음 번호 버전으로 (초안 다음 첫 저장은 v1) → L120.
 * 201, 같은 save_token이면 200 (버전은 하나). 결과가 없으면(이미 저장됨 등) 409 no_result
 */
export function saveRegeneration(essayId: string, requestId: number, input: { save_token: string }) {
  return request<Essay>({
    method: "POST",
    path: `/essays/${essayId}/regenerations/${requestId}/save`,
    body: input,
    mock: { key: "essays.regeneration.save", params: { essayId, requestId: String(requestId) } },
  });
}

/* ---------- 내 서재 (L110) · 글 상세 (L120) · 저장 방식 (L122) · 이 버전 지우기·글 삭제 (L121) — B essays.py ---------- */

/** L110: 직접 쓰기 임시 저장(1개)은 맨 위, 나머지는 최근에 고친 순서 */
export function getEssays() {
  return request<EssayCard[]>({ method: "GET", path: "/essays", mock: { key: "essays.list" } });
}

/**
 * L122 [저장 후 덮어쓰기]: 보고 있던 버전의 내용을 바꾼다 (이전 내용은 남지 않음). 같은 내용으로 다시 보내도 안전.
 * 오류: 422 empty_body, 404 version_not_found·essay_not_found
 */
export function overwriteVersion(essayId: string, versionId: string, input: { title: string | null; body: string }) {
  return request<Essay>({
    method: "PUT",
    path: `/essays/${essayId}/versions/${versionId}`,
    body: input,
    mock: { key: "essays.version.overwrite", params: { essayId, versionId } },
  });
}

/**
 * L122 [새 버전으로 저장]: 다음 번호로 보관 (초안 다음은 v1). 201, 같은 save_token이면 200 (버전은 하나).
 * save_token은 고치기 시작할 때 하나, [다시 시도]에도 같은 값.
 * 오류: 422 empty_body, 404 version_not_found·essay_not_found, 409 save_token_used
 */
export function saveNewVersion(
  essayId: string,
  input: { title: string | null; body: string; based_on_version_id: string; save_token: string },
) {
  return request<Essay>({
    method: "POST",
    path: `/essays/${essayId}/versions`,
    body: input,
    mock: { key: "essays.version.new", params: { essayId } },
  });
}

/**
 * L121 이 버전 지우기 (200 + 남은 글, B delete_version). 저장된 글만.
 * 번호는 다시 매기지 않고, 글 제목은 남은 최신 버전 제목으로. 이 버전을 바탕으로 한 다른 버전의 based_on_version_id는 비워진다.
 * 오류: 409 version_not_deletable(초안이거나 마지막 남은 버전), 404 version_not_found·essay_not_found
 */
export function deleteEssayVersion(essayId: string, versionId: string) {
  return request<Essay>({
    method: "DELETE",
    path: `/essays/${essayId}/versions/${versionId}`,
    mock: { key: "essays.version.delete", params: { essayId, versionId } },
  });
}

/** L121 글 삭제 (204): 글·모든 버전·소재 연결을 지운다. 소재는 소재함에 남는다. 임시 저장도 지울 수 있다 */
export function deleteEssay(essayId: string) {
  return request<null>({ method: "DELETE", path: `/essays/${essayId}`, mock: { key: "essays.delete", params: { essayId } } });
}
