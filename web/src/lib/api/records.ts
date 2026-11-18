import { request, type ApiResult } from "./client";
import type { AnalysisState, RecordItem } from "./types";

/**
 * 저장 요청 하나를 가리키는 값 (records.save_token, 목록 17번 ⑨).
 * [소재로 저장]을 누를 때 한 번 만들고, 같은 저장을 [다시 시도]할 때는 같은 값을 다시 보낸다.
 * → 응답을 못 받고 다시 보내도 기록이 두 개 생기지 않는다.
 */
export function newSaveToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // randomUUID가 없는 오래된 브라우저용 (uuid v4 모양)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * H121 이어 쓰기 확인: 자유 기록 임시 저장 1개 (없으면 null).
 * 서버는 없을 때 404 + code = "no_draft"를 준다 → 여기서 { ok: true, data: null }로 바꾼다
 */
export async function getFreeDraft(): Promise<ApiResult<RecordItem | null>> {
  const res = await request<RecordItem>({
    method: "GET",
    path: "/records/free/draft",
    mock: { key: "records.free.draft.get" },
  });
  if (!res.ok && res.error.code === "no_draft") return { ok: true, data: null };
  return res;
}

/**
 * W111 자유 기록 임시 저장. 방식별 1개만 — 이전 임시 저장이 있으면 그 기록을 덮어쓴다 (id 그대로).
 * 이어 쓰는 중(H121 [예])이면 record_id를 넣는다.
 * 그 임시 저장이 없거나 이미 저장됐으면 404 + error.code = "draft_not_found"
 * → 화면은 record_id 없이 새 임시 저장으로 다시 보내면 된다.
 */
export function saveFreeDraft(input: { record_id?: string; title?: string | null; body?: string | null }) {
  return request<RecordItem>({
    method: "POST",
    path: "/records/free/draft",
    body: input,
    mock: { key: "records.free.draft.save" },
  });
}

/**
 * W110 [소재로 저장]: 원본을 저장한다. 이후 본문은 고칠 수 없다. 저장하면 서버가 분석을 시작한다.
 * - 이어 쓰기(H121 [예])로 연 임시 저장이면 record_id를 넣는다 → 그 임시 저장이 저장된 기록이 됨.
 *   새로 시작([아니오])했으면 비워 둔다 → 기존 임시 저장은 남음 (다음 임시 저장 때 덮어씀)
 * - 본문이 비었으면(공백만) 422 + code = "empty_body"
 * - save_token은 항상 보낸다 (newSaveToken). 같은 save_token이거나 이미 저장된 record_id면 200 + 그 기록.
 *   record_id의 임시 저장이 없으면 404 draft_not_found
 * - 실패하면 입력을 그대로 둔 채 [다시 시도] (같은 save_token으로)
 * - 분석 시작이 실패해도 저장은 성공 → analysis_status = failed
 */
export function saveFreeRecord(input: { record_id?: string; title?: string | null; body: string; save_token: string }) {
  return request<RecordItem>({ method: "POST", path: "/records/free", body: input, mock: { key: "records.free.save" } });
}

/**
 * M120 [원본만 보관] · [새 대화 시작하기]/[새로 기록하기]를 누를 때도 기록 (ERD 규칙 5).
 * 소재함 맨 아래 '원본만 보관한 기록'으로. 두 번 불러도 안전.
 * 오류: 409 material_confirmed(이미 보관한 소재 있음) / material_deleted(소재를 삭제한 원본, 목록 22번)
 */
export function keepOriginal(recordId: string) {
  return request<AnalysisState>({
    method: "POST",
    path: `/records/${recordId}/keep-original`,
    mock: { key: "records.keep", params: { recordId } },
  });
}

/**
 * M132 기록 삭제 (204): 보관 확정 소재가 없는 저장된 원본만. 소재 없음·실패로 남은 원본은 지울 수 있다 (목록 21번).
 * 오류: 404 record_not_found, 409 material_confirmed / material_deleted (목록 22번: 삭제한 소재의 원본은 개별 삭제 불가)
 */
export function deleteRecord(recordId: string) {
  return request<null>({
    method: "DELETE",
    path: `/records/${recordId}`,
    mock: { key: "records.delete", params: { recordId } },
  });
}
