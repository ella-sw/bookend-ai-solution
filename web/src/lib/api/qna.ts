import { request } from "./client";
import type { DailyQuestions, QnaState, RecordItem } from "./types";

/**
 * W210 AI 질문에 답하기 — 수정 대기 목록 17번 (합의, 방법 B: records.status = active)
 * 기준: B 서버 server/app/routers/qna.py. 문답 API는 모두 QnaState 하나로 돌려준다.
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
 * - AI 실패: 답변은 저장되고 ai_failed = true, pending_question = null → [다시 시도] requestNextQuestion() (⑦)
 *   [다른 질문 보기] 실패도 ai_failed = true (기존 질문·횟수 그대로)
 *
 * 나가기 확인 (W211)
 * - [임시 저장하고 나가기]: saveQnaDraft() → 이전 draft를 지우고 active → draft (기준점은 서버가 기록)
 * - [저장하지 않고 나가기]
 *   · active면 discardQna() (이전 draft는 남음)
 *   · 이어 쓰던 draft면 discardQnaChanges() → 기준점으로 되돌림
 *
 * 1시간 규칙 (⑥, 기준 마지막 활동 updated_at): 서버가 판단한다 (config.ts QNA_RESUME_WINDOW_MS)
 * - getActiveQna(): 1시간 지난 active는 지우고 null
 * - getQnaDraft(): 1시간 지난 draft는 기준점으로 되돌려서 준다
 *
 * 주요 오류 코드 (error.code): conversation_not_found(404), finished·not_pending_question·
 * first_question_not_replaceable·replace_limit·not_draft·not_active·need_more_answers(409),
 * invalid_daily_question(422)
 */

/**
 * 오늘(KST)의 공통 질문 30개. [첫 질문 바꾸기]는 이 목록을 화면에서 차례로 넘긴다 (AI 비용 없음).
 * 30/30 다음은 팝업 없이 1/30 (목록 1번, v7 반영).
 * 그날 처음 부르면 서버가 AI로 만든다 → 실패하면 502 + code = "ai_failed" (kind = server)
 */
export function getTodayQuestions() {
  return request<DailyQuestions>({
    method: "GET",
    path: "/daily-questions/today",
    timeoutMs: 70_000,
    mock: { key: "qna.daily" },
  });
}

/** 진행 중(active) 문답. 없거나 1시간이 지났으면 null */
export function getActiveQna() {
  return request<QnaState | null>({ method: "GET", path: "/qna/active", mock: { key: "qna.active.get" } });
}

/** 임시 저장(draft) 문답 (H121). 없으면 null. 1시간이 지났으면 기준점으로 되돌린 상태 */
export function getQnaDraft() {
  return request<QnaState | null>({ method: "GET", path: "/qna/draft", mock: { key: "qna.draft.get" } });
}

/** 첫 답변: 이때 문답 기록(active)을 만들고 다음 질문을 받는다 ('생각 중…'). 오늘·어제 질문만 (422 invalid_daily_question) */
export function startQna(input: { daily_question_id: string; answer: string }) {
  return request<QnaState>({
    method: "POST",
    path: "/qna",
    body: input,
    timeoutMs: 30_000,
    mock: { key: "qna.start" },
  });
}

/**
 * 답을 기다리는 질문(pending_question)에 답하기 → 다음 질문 받기 ('생각 중…').
 * - 7번째 답변이면 finished = true, 다음 질문 없음 (W212). 이미 7개면 409 finished
 * - question_id가 지금 답을 기다리는 질문이 아니면 409 not_pending_question (두 번 보내기 막음)
 * - AI 실패면 답변은 저장되고 ai_failed = true
 */
export function answerQna(recordId: string, input: { question_id: string; answer: string }) {
  return request<QnaState>({
    method: "POST",
    path: `/qna/${recordId}/answers`,
    body: input,
    timeoutMs: 30_000,
    mock: { key: "qna.answer", params: { recordId } },
  });
}

/** [다시 시도]: 답을 기다리는 질문이 없을 때만 새 질문을 만든다. 있거나 7개를 다 채웠으면 그대로 돌려준다 */
export function requestNextQuestion(recordId: string) {
  return request<QnaState>({
    method: "POST",
    path: `/qna/${recordId}/next`,
    timeoutMs: 30_000,
    mock: { key: "qna.next", params: { recordId } },
  });
}

/**
 * [다른 질문 보기]: 답을 기다리는 후속 질문을 새 질문으로 바꾼다. 대화당 6회 (replace_left).
 * 실패하면 기존 질문·횟수 그대로 + ai_failed = true → '질문을 바꾸지 못했어요' (목록 12번)
 * 오류: not_pending_question / first_question_not_replaceable(첫 질문) / replace_limit (409)
 */
export function replaceQnaQuestion(recordId: string, questionId: string) {
  return request<QnaState>({
    method: "POST",
    path: `/qna/${recordId}/replace`,
    body: { question_id: questionId },
    timeoutMs: 30_000,
    mock: { key: "qna.replace", params: { recordId } },
  });
}

/** [임시 저장]: 이전 draft를 지우고 active → draft. 이어 쓰던 draft면 기준점만 지금으로 옮긴다 */
export function saveQnaDraft(recordId: string) {
  return request<QnaState>({
    method: "POST",
    path: `/qna/${recordId}/draft`,
    mock: { key: "qna.draft.save", params: { recordId } },
  });
}

/** 이어 쓰던 draft의 [저장하지 않고 나가기]: 마지막 [임시 저장] 시점으로 되돌린다. draft가 아니면 409 not_draft */
export function discardQnaChanges(recordId: string) {
  return request<QnaState>({
    method: "POST",
    path: `/qna/${recordId}/discard-changes`,
    mock: { key: "qna.draft.revert", params: { recordId } },
  });
}

/**
 * W210 [소재로 저장]: 답변 2개부터 (전이면 409 need_more_answers). 답을 기다리던 질문은 빼고 저장한다.
 * - 다시 보내도 안전: 이미 저장된 대화면 200 + 그 기록 (본문 없음, save_token 안 씀)
 * - 저장하면 서버가 분석을 시작한다. 시작이 실패해도 저장은 성공 → analysis_status = failed
 */
export function saveQna(recordId: string) {
  return request<RecordItem>({
    method: "POST",
    path: `/qna/${recordId}/save`,
    mock: { key: "qna.save", params: { recordId } },
  });
}

/** W211 [저장하지 않고 나가기]: 진행 중(active) 문답을 지운다. draft면 409 not_active */
export function discardQna(recordId: string) {
  return request<null>({
    method: "DELETE",
    path: `/qna/${recordId}`,
    mock: { key: "qna.discard", params: { recordId } },
  });
}
