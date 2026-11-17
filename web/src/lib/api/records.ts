import { request } from "./client";
import type { RecordDraft, RecordItem, RecordType } from "./types";

/** H121 이어 쓰기 확인: 고른 방식의 임시 저장 1개 (없으면 null) */
export function getRecordDraft(type: RecordType) {
  return request<RecordDraft | null>({
    method: "GET",
    path: "/records/draft",
    query: { type },
    mock: { key: "records.draft.get" },
  });
}

/**
 * W111 임시 저장. 방식별 1개만 보관 — 같은 방식의 이전 임시 저장은 이때 덮어쓴다.
 * - 자유 기록: title·body를 보냄 (이어 쓰는 중이면 record_id도)
 * - AI 문답: record_id만 (문답 내용은 답할 때마다 서버에 이미 있음, 목록 17번)
 */
export function saveRecordDraft(
  input:
    | { type: "free"; record_id?: string; title?: string | null; body?: string | null }
    | { type: "qna"; record_id: string },
) {
  return request<RecordItem>({
    method: "PUT",
    path: "/records/draft",
    body: input,
    mock: { key: "records.draft.save" },
  });
}

/**
 * W110 [소재로 저장]: 원본을 먼저 저장한다. 이후 본문은 고칠 수 없다.
 * 실패하면 분석하지 않고 입력을 그대로 둔 채 [다시 시도].
 * 이어 쓰기(H121 [예])로 연 임시 저장이면 record_id를 넣는다 → 그 임시 저장이 저장된 기록이 됨.
 * 새로 시작([아니오])했으면 비워 둔다 → 기존 임시 저장은 남음 (다음 임시 저장 때 덮어씀)
 */
export function saveFreeRecord(input: { record_id?: string; title?: string | null; body: string }) {
  return request<RecordItem>({ method: "POST", path: "/records", body: { type: "free", ...input }, mock: { key: "records.save.free" } });
}

/** W210 [소재로 저장]: 답변 2개(첫 답변 + 후속 1개)부터 */
export function saveQnaRecord(recordId: string) {
  return request<RecordItem>({
    method: "POST",
    path: `/records/${recordId}/save`,
    mock: { key: "records.save.qna", params: { recordId } },
  });
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
