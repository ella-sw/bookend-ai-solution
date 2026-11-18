import { request } from "./client";
import type { DailyQuestion, QnaAnswerResult, QnaFirstAnswerResult, QnaReplaceResult } from "./types";

/**
 * W210 AI 질문에 답하기 — 기록을 언제 만드나 (수정 대기 목록 17번, 방법 A · B와 합의 필요)
 * - 화면에 들어올 때는 서버에 아무것도 만들지 않는다. 첫 질문은 getDailyQuestions()로 화면에서 고른다.
 * - 첫 답변을 보낼 때 문답 기록(records, status = draft)을 처음 만든다 → startQnaWithFirstAnswer
 * - 나가기 확인(W211)
 *   · 첫 답변 전: 서버에 남은 게 없으니 그냥 나감
 *   · [임시 저장하고 나가기]: saveRecordDraft({ type: "qna", record_id }) — 이전 문답 임시 저장은 이때 덮어씀
 *   · [저장하지 않고 나가기]: discardQna(record_id)로 이번 대화를 지움
 * - 이어 쓰기(H121 [예])는 getRecordDraft("qna")로 받은 기록에 answerQna로 이어서 답한다.
 */

/**
 * 오늘의 공통 질문 30개. [첫 질문 바꾸기]는 이 목록을 화면에서 차례로 넘긴다 (AI 비용 없음).
 * 30/30 다음은 팝업 없이 1/30 (목록 1번, v7 반영)
 */
export function getDailyQuestions() {
  return request<DailyQuestion[]>({ method: "GET", path: "/daily-questions", mock: { key: "qna.daily" } });
}

/** 첫 답변: 이때 문답 기록을 만들고 첫 후속 질문을 받는다 ('생각 중…') */
export function startQnaWithFirstAnswer(input: { daily_question_id: string; answer: string }) {
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
 * 답변 7개가 차면 next = null, finished = true (질문 마무리 W212)
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

/** W211 [저장하지 않고 나가기]: 이번 대화(임시 저장 전 문답 기록)를 지운다. 저장한 기록은 못 지움 */
export function discardQna(recordId: string) {
  return request<null>({
    method: "DELETE",
    path: `/qna/${recordId}`,
    mock: { key: "qna.discard", params: { recordId } },
  });
}
