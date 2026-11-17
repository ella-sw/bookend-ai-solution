import { request } from "./client";
import type {
  DailyQuestion,
  QnaAnswerResult,
  QnaFirstAnswerResult,
  QnaNextResult,
  QnaReplaceResult,
  QnaSession,
  RecordItem,
} from "./types";

/**
 * W210 AI 질문에 답하기 — 수정 대기 목록 17번 (합의, 방법 B: records.status = active)
 *
 * 화면 순서 (⑩·⑪)
 * - H120 [AI 질문에 답하기] → getActiveQna()
 *   · 있으면 H121 없이 W210으로 이어서 연다
 *   · 없으면 getQnaDraft() → 있으면 H121 이어 쓰기 확인
 * - H121 [예]: 받은 draft로 W210을 연다 (기준점 방식, 아래)
 * - H121 [아니오]: draft는 건드리지 않는다 (active도 그대로). 새로 시작
 *
 * 기록 만들기
 * - 화면 진입: 서버에 아무것도 만들지 않는다. 첫 질문은 getTodayQuestions()에서 화면이 고른다
 * - 첫 답변: startQna() → active + 첫 문답을 만든다. 이전 active는 서버가 지운다
 * - AI 실패: 답변은 저장되고 next = null, next_failed = true → requestNextQuestion()으로 다시 받는다 (⑦)
 *
 * 나가기 확인 (W211)
 * - [임시 저장하고 나가기]: saveQnaDraft() → 같은 방식의 이전 draft를 지우고 active → draft (기준점 기록)
 * - [저장하지 않고 나가기]
 *   · active면 discardQna() (이전 draft는 남음)
 *   · 이어 쓰던 draft면 discardQnaChanges() → 기준점으로 되돌림
 *
 * 1시간 규칙 (⑥, 기준 records.updated_at): 서버가 판단한다 (config.ts QNA_RESUME_WINDOW_MS)
 * - getActiveQna(): 1시간 지난 active는 지우고 null
 * - getQnaDraft(): 1시간 지난 draft는 기준점으로 되돌려서 준다
 */

/**
 * 오늘의 공통 질문 30개. [첫 질문 바꾸기]는 이 목록을 화면에서 차례로 넘긴다 (AI 비용 없음).
 * 30/30 다음은 팝업 없이 1/30 (목록 1번, v7 반영)
 */
export function getTodayQuestions() {
  return request<DailyQuestion[]>({ method: "GET", path: "/daily-questions/today", mock: { key: "qna.daily" } });
}

/** 진행 중(active) 문답. 없거나 1시간이 지났으면 null */
export function getActiveQna() {
  return request<QnaSession | null>({ method: "GET", path: "/qna/active", mock: { key: "qna.active.get" } });
}

/** 임시 저장(draft) 문답 (H121). 없으면 null. 1시간이 지났으면 기준점으로 되돌린 상태 */
export function getQnaDraft() {
  return request<QnaSession | null>({ method: "GET", path: "/qna/draft", mock: { key: "qna.draft.get" } });
}

/** 첫 답변: 이때 문답 기록(active)을 만들고 첫 후속 질문을 받는다 ('생각 중…') */
export function startQna(input: { daily_question_id: string; answer: string }) {
  return request<QnaFirstAnswerResult>({
    method: "POST",
    path: "/qna",
    body: input,
    timeoutMs: 30_000,
    mock: { key: "qna.start" },
  });
}

/**
 * 후속 질문에 답하기 → 다음 후속 질문 받기 ('생각 중…').
 * - 답변 7개가 차면 next = null, finished = true (질문 마무리 W212). 이미 7개면 conflict
 * - AI 실패면 답변은 저장되고 next = null, next_failed = true
 */
export function answerQna(recordId: string, input: { message_id: string; answer: string }) {
  return request<QnaAnswerResult>({
    method: "POST",
    path: `/qna/${recordId}/answers`,
    body: input,
    timeoutMs: 30_000,
    mock: { key: "qna.answer", params: { recordId } },
  });
}

/** AI 실패 뒤 다음 질문 다시 받기 (next_failed, 또는 불러온 문답의 pending = null) */
export function requestNextQuestion(recordId: string) {
  return request<QnaNextResult>({
    method: "POST",
    path: `/qna/${recordId}/next`,
    timeoutMs: 30_000,
    mock: { key: "qna.next", params: { recordId } },
  });
}

/**
 * [다른 질문 보기]: 지금 후속 질문을 새 질문으로 바꾼다. 대화당 6회.
 * 남은 횟수 = 6 − 이 기록의 is_replaced 질문 수 (ERD 규칙 10)
 * 목록 12번 (제안, C 합의 전 → 목업만): 성공 뒤에만 교체·차감,
 * 실패면 기존 질문·횟수 유지 + '질문을 바꾸지 못했어요'. 요청 중 버튼 막음.
 */
export function replaceQnaQuestion(recordId: string, messageId: string) {
  return request<QnaReplaceResult>({
    method: "POST",
    path: `/qna/${recordId}/replace`,
    body: { message_id: messageId },
    timeoutMs: 30_000,
    mock: { key: "qna.replace", params: { recordId } },
  });
}

/**
 * [임시 저장]: 같은 방식의 이전 draft를 지우고 active → draft. 한 트랜잭션.
 * 이어 쓰던 draft면 기준점만 지금으로 옮긴다. 기준점 = checkpoint_seq + checkpoint_pending_id + checkpoint_at
 */
export function saveQnaDraft(recordId: string) {
  return request<RecordItem>({
    method: "POST",
    path: `/qna/${recordId}/draft`,
    mock: { key: "qna.draft.save", params: { recordId } },
  });
}

/** 이어 쓰던 draft의 [저장하지 않고 나가기]: 기준점 뒤 변경을 되돌린다 (draft만) */
export function discardQnaChanges(recordId: string) {
  return request<RecordItem>({
    method: "POST",
    path: `/qna/${recordId}/discard-changes`,
    mock: { key: "qna.draft.revert", params: { recordId } },
  });
}

/**
 * W210 [소재로 저장]: 답변 2개(첫 답변 + 후속 1개)부터. 저장하면 서버가 분석을 시작한다.
 * - save_token: 저장 시도마다 newSaveToken()으로 한 번 만들고, [다시 시도] 때는 같은 값을 보낸다.
 *   같은 save_token이거나 이미 저장된 기록이면 200 + 그 기록 (중복 저장 없음, ⑨)
 * - 분석 시작이 실패해도 저장은 성공 → analysis_status = failed (소재함 확인 대기 카드에서 [다시 분석])
 */
export function saveQna(recordId: string, saveToken: string) {
  return request<RecordItem>({
    method: "POST",
    path: `/qna/${recordId}/save`,
    body: { save_token: saveToken },
    mock: { key: "qna.save", params: { recordId } },
  });
}

/** W211 [저장하지 않고 나가기]: 진행 중(active) 문답을 지운다. draft·저장한 기록이면 conflict */
export function discardQna(recordId: string) {
  return request<null>({
    method: "DELETE",
    path: `/qna/${recordId}`,
    mock: { key: "qna.discard", params: { recordId } },
  });
}
