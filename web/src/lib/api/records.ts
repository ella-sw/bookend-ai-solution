import { request } from "./client";
import type { RecordItem } from "./types";

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
 * 주의: 이 주소는 받은 B API 목록에 없음 — A 임시안. B와 확인 필요
 */
export function getFreeDraft() {
  return request<RecordItem | null>({
    method: "GET",
    path: "/records/free/draft",
    mock: { key: "records.free.draft.get" },
  });
}

/**
 * W111 자유 기록 임시 저장. 방식별 1개만 — 같은 방식의 이전 임시 저장은 이때 덮어쓴다.
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
 * - save_token은 항상 보낸다 (newSaveToken). 같은 save_token이거나 이미 저장된 record_id면 200 + 그 기록
 * - 실패하면 입력을 그대로 둔 채 [다시 시도] (같은 save_token으로)
 * - 분석 시작이 실패해도 저장은 성공 → analysis_status = failed
 */
export function saveFreeRecord(input: { record_id?: string; title?: string | null; body: string; save_token: string }) {
  return request<RecordItem>({ method: "POST", path: "/records/free", body: input, mock: { key: "records.free.save" } });
}

/** M120 [원본만 보관] · [새 대화 시작하기]/[새로 기록하기]를 누를 때도 기록 (ERD 규칙 5) */
export function keepOriginal(recordId: string) {
  return request<RecordItem>({
    method: "POST",
    path: `/records/${recordId}/keep-original`,
    mock: { key: "records.keep", params: { recordId } },
  });
}

/** M132 기록 삭제: 보관 확정 소재가 없는 원본만 */
export function deleteRecord(recordId: string) {
  return request<null>({
    method: "DELETE",
    path: `/records/${recordId}`,
    mock: { key: "records.delete", params: { recordId } },
  });
}
