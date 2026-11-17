import { apiError, type ApiErrorCode, type ApiErrorKind, type ApiResult, type RequestOptions } from "../client";
import type {
  AnalysisResult,
  HomeSummary,
  Material,
  MaterialConfirmInput,
  MaterialDetail,
  MaterialManualInput,
  MaterialsOverview,
  PendingCardStatus,
  QnaAnswerResult,
  QnaFirstAnswerResult,
  QnaMessage,
  QnaNextResult,
  QnaReplaceResult,
  QnaSession,
  RecordItem,
  RecordType,
} from "../types";
import { QNA_RULES } from "../types";
import { ANALYSIS_TIMEOUT_MS, QNA_RESUME_WINDOW_MS } from "../config";
import type { MockKey } from "./keys";
import { getMockSettings, scenarioFor, type MockScenario } from "./scenario";
import { clearUserData, FOLLOWUP_QUESTIONS, getDb, newId, now, topicId } from "./store";

/** 목업에서 분석이 끝나기까지 걸리는 시간 (실제 목표 10~20초를 짧게 줄임) */
const MOCK_ANALYSIS_MS = 3_000;
/** 목업의 '60초 시간 초과'를 줄인 값 ('시간 초과' 상황을 오래 기다리지 않고 확인하려고). 실제 서버는 60초 */
const MOCK_ANALYSIS_TIMEOUT_MS = Math.min(ANALYSIS_TIMEOUT_MS, 8_000);
const SLOW_EXTRA_MS = 2_500;
const TIMEOUT_WAIT_MS = 3_000;

class MockHttpError extends Error {
  constructor(
    public kind: ApiErrorKind,
    public code?: ApiErrorCode,
  ) {
    super(code ?? kind);
  }
}
const fail = (kind: ApiErrorKind, code?: ApiErrorCode): never => {
  throw new MockHttpError(kind, code);
};

/** 목업이 돌려주는 HTTP 상태 (화면이 status를 볼 때 실제 서버와 같게) */
const MOCK_STATUS: Record<ApiErrorKind, number | undefined> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  timeout: undefined,
  network: undefined,
  server: 500,
};

interface Ctx {
  params: Record<string, string>;
  body: unknown;
  query: RequestOptions["query"];
  scenario: MockScenario;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- 도움 함수 ---------- */

function findRecord(id: string): RecordItem {
  return getDb().records.find((r) => r.id === id) ?? fail("not_found");
}

/** 문답 기록 찾기 (type = qna) */
function findQna(id: string): RecordItem {
  const record = findRecord(id);
  if (record.type !== "qna") fail("not_found");
  return record;
}

/** 아직 저장 전인 문답 (active 또는 이어 쓰는 draft)만 답·질문을 바꿀 수 있다 */
function assertOpen(record: RecordItem) {
  if (record.status === "saved") fail("conflict");
}

function hasConfirmedMaterial(recordId: string) {
  return getDb().materials.some((m) => m.record_id === recordId && m.confirmed_at && !m.deleted_at);
}

function messagesOf(recordId: string) {
  return getDb()
    .messages.filter((m) => m.record_id === recordId)
    .sort((a, b) => a.seq - b.seq);
}

function answeredCount(recordId: string) {
  return getDb().messages.filter((m) => m.record_id === recordId && m.answer && !m.is_replaced).length;
}

/** 답을 기다리는 질문: 바꾸지 않았고 답이 없는 마지막 질문 */
function pendingOf(recordId: string): QnaMessage | null {
  const open = messagesOf(recordId).filter((m) => !m.answer && !m.is_replaced);
  return open[open.length - 1] ?? null;
}

/** [다른 질문 보기] 남은 횟수 = 6 − 바꾼 질문 수 (ERD 규칙 10) */
function remainingReplaces(recordId: string) {
  const used = getDb().messages.filter((m) => m.record_id === recordId && m.is_replaced).length;
  return Math.max(0, QNA_RULES.replaceLimit - used);
}

function qnaSession(record: RecordItem): QnaSession {
  return {
    record,
    messages: messagesOf(record.id),
    pending: pendingOf(record.id),
    remaining_replaces: remainingReplaces(record.id),
  };
}

/** 마지막 활동 갱신 (문답이 추가·변경될 때, 목록 17번 ⑥) */
function touch(record: RecordItem) {
  record.updated_at = now();
}

/** 이어 쓰기 기준 시간. /dev/mock에서 짧게 바꿀 수 있다 */
function resumeWindowMs() {
  return getMockSettings().qnaResumeWindowMs ?? QNA_RESUME_WINDOW_MS;
}

/** 마지막 활동(updated_at)에서 기준 시간이 지났나 */
function isExpired(record: RecordItem) {
  return Date.now() - Date.parse(record.updated_at) > resumeWindowMs();
}

/** 기록과 딸린 문답·분석 상태를 지운다. 실제 서버는 관련 ai_requests도 지움 (목록 17번 ⑧) */
function removeRecords(ids: string[]) {
  if (ids.length === 0) return;
  const db = getDb();
  db.records = db.records.filter((r) => !ids.includes(r.id));
  db.messages = db.messages.filter((m) => !ids.includes(m.record_id));
  for (const id of ids) {
    delete db.analyses[id];
    delete db.candidates[id];
  }
}

/** 같은 방식·같은 status인 다른 기록 id (방식별 active·draft는 1개) */
function othersWithStatus(type: RecordType, status: RecordItem["status"], keepId?: string) {
  return getDb()
    .records.filter((r) => r.type === type && r.status === status && r.id !== keepId)
    .map((r) => r.id);
}

/** 기준점 뒤에 바뀐 게 있나 (seq > 기준점 문답, 또는 기다리던 질문에 답·교체) */
function changedSinceCheckpoint(record: RecordItem) {
  const cpSeq = record.checkpoint_seq ?? 0;
  const messages = messagesOf(record.id);
  if (messages.some((m) => m.seq > cpSeq)) return true;
  const waiting = messages.find((m) => m.id === record.checkpoint_pending_id);
  return !!waiting && (waiting.answer !== null || waiting.is_replaced);
}

/**
 * 기준점으로 되돌리기 (목록 17번 ⑤): seq > 기준점 삭제 + 기다리던 질문 answer = null, is_replaced = false.
 * 실제 서버는 checkpoint_at 뒤에 시작한 ai_requests도 지운다 (⑧)
 */
function revertToCheckpoint(record: RecordItem) {
  if (!changedSinceCheckpoint(record)) return;
  const db = getDb();
  const cpSeq = record.checkpoint_seq ?? 0;
  db.messages = db.messages.filter((m) => m.record_id !== record.id || m.seq <= cpSeq);
  const waiting = db.messages.find((m) => m.id === record.checkpoint_pending_id && m.record_id === record.id);
  if (waiting) {
    waiting.answer = null;
    waiting.is_replaced = false;
  }
  touch(record);
}

/**
 * 답을 받은 뒤 다음 후속 질문을 만든다. 답변 7개가 차면 마무리 (W212).
 * 'AI 실패' 상황이면 답변은 그대로 두고 next = null, next_failed = true (목록 17번 ⑦)
 */
function afterAnswer(record: RecordItem, answered: QnaMessage, scenario: MockScenario): QnaAnswerResult {
  const finished = answeredCount(record.id) >= QNA_RULES.maxAnswers;
  if (finished) return { answered, next: null, next_failed: false, finished };
  if (scenario === "ai_fail") return { answered, next: null, next_failed: true, finished };
  const next = newFollowup(record.id);
  getDb().messages.push(next);
  return { answered, next, next_failed: false, finished };
}

function cardStatus(record: RecordItem): PendingCardStatus | null {
  switch (record.analysis_status) {
    case "analyzing":
      return "analyzing";
    case "done":
      return "review";
    case "empty":
      return "empty";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** 분석 중인 기록이면 시간이 지났는지 보고 결과를 낸다 (목업 전용) */
function settleAnalysis(record: RecordItem, scenario: MockScenario) {
  const db = getDb();
  const running = db.analyses[record.id];
  if (!running || record.analysis_status !== "analyzing") return;
  const elapsed = Date.now() - running.startedAt;

  // 서버 규칙: 60초가 지나면 시간 초과 실패 (ERD 규칙 3). 판단은 서버(여기)가 한다. 목업은 8초로 줄임
  if (elapsed >= MOCK_ANALYSIS_TIMEOUT_MS) {
    delete db.analyses[record.id];
    record.analysis_status = "failed";
    failureReasons[record.id] = "timeout";
    return;
  }
  // 'timeout' 상황: 결과를 내지 않고 계속 분석 중 → 60초 뒤 위에서 시간 초과
  if (scenario === "timeout") return;
  if (elapsed < MOCK_ANALYSIS_MS) return;

  delete db.analyses[record.id];
  if (scenario === "empty") {
    record.analysis_status = "empty";
  } else if (scenario === "fail") {
    record.analysis_status = "failed";
    failureReasons[record.id] = "error";
  } else {
    record.analysis_status = "done";
    db.candidates[record.id] = makeCandidate(record);
  }
}
const failureReasons: Record<string, "error" | "timeout"> = {};

/** 분석 시작 (목업: 시작 시각만 기록하고 몇 초 뒤 결과를 냄) */
function runAnalysis(record: RecordItem) {
  const db = getDb();
  const requestId = db.nextRequestId++;
  record.analysis_status = "analyzing";
  db.analyses[record.id] = { requestId, startedAt: Date.now() };
  delete db.candidates[record.id];
  delete failureReasons[record.id];
  return requestId;
}

/**
 * 저장 직후 분석 시작. 시작이 실패해도 저장은 성공으로 두고 analysis_status = failed.
 * 목업: analysis.start 키의 상황이 실패·연결 끊김·시간 초과면 '시작 실패'
 */
function startAnalysisAfterSave(record: RecordItem) {
  const s = scenarioFor("analysis.start");
  if (s === "fail" || s === "network" || s === "timeout") {
    record.analysis_status = "failed";
    failureReasons[record.id] = "error";
    return;
  }
  runAnalysis(record);
}

/** 중복 저장 막기 (목록 17번 ⑨): 같은 save_token으로 저장한 기록. 없으면 undefined */
function recordBySaveToken(saveToken: string): RecordItem | undefined {
  const id = getDb().saveTokens[saveToken];
  return id ? getDb().records.find((r) => r.id === id) : undefined;
}

/** 저장 확정: status = saved, 기준점 비움, save_token 기록, 분석 시작 */
function markSaved(record: RecordItem, saveToken: string) {
  const t = now();
  record.status = "saved";
  record.saved_at = t;
  record.updated_at = t;
  record.checkpoint_seq = null;
  record.checkpoint_pending_id = null;
  record.checkpoint_at = null;
  getDb().saveTokens[saveToken] = record.id;
  startAnalysisAfterSave(record);
  return record;
}

function sourceText(record: RecordItem) {
  if (record.type === "free") return record.body ?? "";
  return getDb()
    .messages.filter((m) => m.record_id === record.id && m.answer)
    .map((m) => m.answer)
    .join(" ");
}

function makeCandidate(record: RecordItem) {
  const text = sourceText(record).trim();
  const firstSentence = text.split(/(?<=[.!?。])\s+/)[0] ?? text;
  return {
    title: record.title?.trim() || firstSentence.slice(0, 16) || "오늘의 기록",
    summary: firstSentence.slice(0, 40),
    evidence: firstSentence || null,
    keywords: Array.from(new Set(text.split(/\s+/).filter((w) => w.length >= 2))).slice(0, 3),
    topic_ids: [topicId("일상")],
  };
}

function newRecord(type: RecordType, status: RecordItem["status"], fields: Partial<RecordItem> = {}): RecordItem {
  const t = now();
  return {
    id: newId(),
    type,
    title: null,
    body: null,
    status,
    analysis_status: "none",
    original_kept_at: null,
    created_at: t,
    saved_at: status === "saved" ? t : null,
    updated_at: t,
    checkpoint_seq: null,
    checkpoint_pending_id: null,
    checkpoint_at: null,
    ...fields,
  };
}

function newFollowup(recordId: string): QnaMessage {
  const messages = messagesOf(recordId);
  const used = new Set(messages.map((m) => m.question));
  const question = FOLLOWUP_QUESTIONS.find((q) => !used.has(q)) ?? FOLLOWUP_QUESTIONS[0];
  const seq = (messages[messages.length - 1]?.seq ?? 0) + 1;
  return { id: newId(), record_id: recordId, seq, question, question_source: "followup", daily_question_id: null, answer: null, is_replaced: false };
}

/* ---------- 처리 함수 (키별) ---------- */

const handlers: Record<MockKey, (ctx: Ctx) => unknown> = {
  "user.start": () => {
    getDb().userStarted = true;
    return { user_id: "mock-user" };
  },

  "home.get": ({ scenario }): HomeSummary => {
    const db = getDb();
    if (scenario === "empty") return { recent_materials: [], suggestion: null, is_organizing: false };
    const recent = db.materials
      .filter((m) => m.confirmed_at && !m.deleted_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 3);
    return {
      recent_materials: recent,
      suggestion: db.suggestion?.status === "ready" ? db.suggestion : null,
      is_organizing: db.records.some((r) => r.analysis_status === "analyzing"),
    };
  },

  "topics.list": () => getDb().topics,

  /* ----- 자유 기록 ----- */

  "records.free.draft.get": ({ scenario }): RecordItem | null => {
    if (scenario === "empty") return null;
    return getDb().records.find((r) => r.type === "free" && r.status === "draft") ?? null;
  },

  // 방식별 임시 저장 1개 (ERD 규칙 16). 이어 쓰는 중이면 record_id
  "records.free.draft.save": ({ body }): RecordItem => {
    const input = body as { record_id?: string; title?: string | null; body?: string | null };
    const db = getDb();
    let record: RecordItem;
    if (input.record_id) {
      const found = db.records.find((r) => r.id === input.record_id && r.type === "free");
      // 이어 쓰던 임시 저장이 없거나 이미 저장됨 → 화면은 record_id 없이 다시 보내면 됨
      if (!found || found.status !== "draft") return fail("not_found", "draft_not_found");
      record = found;
    } else {
      record = newRecord("free", "draft");
      db.records.push(record);
    }
    // 같은 방식의 이전 임시 저장은 이때 덮어씀 (H121 [아니오] 뒤 규칙)
    removeRecords(othersWithStatus("free", "draft", record.id));
    if (input.title !== undefined) record.title = input.title;
    if (input.body !== undefined) record.body = input.body;
    touch(record);
    return record;
  },

  // [소재로 저장] (⑨): 같은 save_token·이미 저장된 record_id면 200 + 그 기록
  "records.free.save": ({ body }): RecordItem => {
    const input = body as { record_id?: string; title?: string | null; body: string; save_token?: string };
    const saveToken = input.save_token ?? fail("bad_request");
    const already = recordBySaveToken(saveToken);
    if (already) return already;
    const db = getDb();
    if (input.record_id) {
      const found = db.records.find((r) => r.id === input.record_id && r.type === "free");
      if (!found) return fail("not_found", "draft_not_found");
      if (found.status === "saved") return found;
      if (!input.body?.trim()) fail("bad_request");
      // 이어 쓰던 임시 저장(H121 [예]) → 그 기록을 저장으로
      found.title = input.title ?? null;
      found.body = input.body;
      return markSaved(found, saveToken);
    }
    if (!input.body?.trim()) fail("bad_request");
    // 새로 시작([아니오]): 기존 임시 저장은 그대로 둔다 (다음 임시 저장 때 덮어씀)
    const record = newRecord("free", "draft", { title: input.title ?? null, body: input.body });
    db.records.push(record);
    return markSaved(record, saveToken);
  },

  "records.keep": ({ params }): RecordItem => {
    const record = findRecord(params.recordId);
    record.original_kept_at = now();
    return record;
  },

  "records.delete": ({ params }) => {
    const record = findRecord(params.recordId);
    if (hasConfirmedMaterial(record.id)) fail("conflict"); // 보관 확정 소재가 있으면 지울 수 없음 (ERD 규칙 6)
    removeRecords([record.id]);
    return null;
  },

  /* ----- AI 문답 (목록 17번, 방법 B) ----- */

  "qna.daily": () => getDb().dailyQuestions,

  // H120: 진행 중 문답. 1시간 지난 active는 지우고 null (⑥)
  "qna.active.get": ({ scenario }): QnaSession | null => {
    if (scenario === "empty") return null;
    const record = getDb().records.find((r) => r.type === "qna" && r.status === "active");
    if (!record) return null;
    if (isExpired(record)) {
      removeRecords([record.id]);
      return null;
    }
    return qnaSession(record);
  },

  // H121: 임시 저장 문답. 1시간 지난 draft는 기준점으로 되돌려서 준다 (⑥). 지우지는 않음
  "qna.draft.get": ({ scenario }): QnaSession | null => {
    if (scenario === "empty") return null;
    const record = getDb().records.find((r) => r.type === "qna" && r.status === "draft");
    if (!record) return null;
    if (isExpired(record)) revertToCheckpoint(record);
    return qnaSession(record);
  },

  // 첫 답변: active + 첫 문답을 만든다. 이전 active는 지운다 (②)
  "qna.start": ({ body, scenario }): QnaFirstAnswerResult => {
    const db = getDb();
    const input = body as { daily_question_id: string; answer: string };
    if (!input.answer?.trim()) fail("bad_request");
    const daily = db.dailyQuestions.find((q) => q.id === input.daily_question_id) ?? fail("bad_request");

    removeRecords(othersWithStatus("qna", "active"));
    const record = newRecord("qna", "active");
    db.records.push(record);
    const first: QnaMessage = {
      id: newId(),
      record_id: record.id,
      seq: 1,
      question: daily.question,
      question_source: "daily",
      daily_question_id: daily.id,
      answer: input.answer,
      is_replaced: false,
    };
    db.messages.push(first);
    const result = afterAnswer(record, first, scenario);
    return { record, remaining_replaces: remainingReplaces(record.id), ...result };
  },

  "qna.answer": ({ params, body, scenario }): QnaAnswerResult => {
    const db = getDb();
    const record = findQna(params.recordId);
    assertOpen(record);
    const input = body as { message_id: string; answer: string };
    if (!input.answer?.trim()) fail("bad_request");
    // 답변 7개가 차면 더 받지 않음 (W212 질문 마무리)
    if (answeredCount(record.id) >= QNA_RULES.maxAnswers) fail("conflict");

    const message =
      db.messages.find((m) => m.id === input.message_id && m.record_id === record.id) ?? fail("not_found");
    if (message.is_replaced || message.answer) fail("conflict");
    message.answer = input.answer;
    touch(record);
    return afterAnswer(record, message, scenario);
  },

  // AI 실패 뒤 다음 질문 다시 받기 (⑦). 이미 기다리는 질문이 있으면 그 질문을 돌려줌
  "qna.next": ({ params, scenario }): QnaNextResult => {
    const record = findQna(params.recordId);
    assertOpen(record);
    if (answeredCount(record.id) >= QNA_RULES.maxAnswers) fail("conflict");
    const waiting = pendingOf(record.id);
    if (waiting) return { message: waiting };
    if (scenario === "ai_fail") fail("server");
    const next = newFollowup(record.id);
    getDb().messages.push(next);
    touch(record);
    return { message: next };
  },

  // 목록 12번 (제안): 새 질문 만들기 성공 뒤에만 교체·차감. 실패면 기존 질문·횟수 유지 (fail 상황으로 확인)
  "qna.replace": ({ params, body }): QnaReplaceResult => {
    const db = getDb();
    const record = findQna(params.recordId);
    assertOpen(record);
    const { message_id } = body as { message_id: string };
    if (remainingReplaces(record.id) <= 0) fail("conflict");
    const current = db.messages.find((m) => m.id === message_id && m.record_id === record.id) ?? fail("not_found");
    if (current.answer || current.is_replaced || current.question_source !== "followup") fail("conflict");

    current.is_replaced = true; // 바꾼 질문도 기록에 남김
    const next = newFollowup(record.id);
    db.messages.push(next);
    touch(record);
    return { message: next, remaining: remainingReplaces(record.id) };
  },

  // [임시 저장]: 이전 draft 삭제 + active → draft + 기준점 기록 (③·⑤). 이어 쓰던 draft면 기준점만 옮김
  "qna.draft.save": ({ params }): RecordItem => {
    const record = findQna(params.recordId);
    assertOpen(record);
    removeRecords(othersWithStatus("qna", "draft", record.id));
    const messages = messagesOf(record.id);
    record.status = "draft";
    record.checkpoint_seq = messages[messages.length - 1]?.seq ?? 0;
    record.checkpoint_pending_id = pendingOf(record.id)?.id ?? null;
    record.checkpoint_at = now();
    return record;
  },

  // 이어 쓰던 draft의 [저장하지 않고 나가기]: 기준점으로 되돌림 (draft만)
  "qna.draft.revert": ({ params }): RecordItem => {
    const record = findQna(params.recordId);
    if (record.status !== "draft") fail("conflict");
    revertToCheckpoint(record);
    return record;
  },

  // [소재로 저장] (⑨): 같은 save_token·이미 저장된 기록이면 200 + 그 기록
  "qna.save": ({ params, body }): RecordItem => {
    const input = (body ?? {}) as { save_token?: string };
    const saveToken = input.save_token ?? fail("bad_request");
    const already = recordBySaveToken(saveToken);
    if (already) return already;
    const record = findQna(params.recordId);
    if (record.status === "saved") return record;
    if (answeredCount(record.id) < QNA_RULES.minAnswersToSave) fail("bad_request");
    return markSaved(record, saveToken);
  },

  // W211 [저장하지 않고 나가기]: active만 지운다. draft·saved면 conflict (④)
  "qna.discard": ({ params }) => {
    const record = findQna(params.recordId);
    if (record.status !== "active") fail("conflict");
    removeRecords([record.id]);
    return null;
  },

  // 다시 분석 (실패·M130 등). 첫 분석은 소재로 저장 때 서버가 시작한다
  "analysis.start": ({ params }) => {
    const record = findRecord(params.recordId);
    if (record.status !== "saved") fail("bad_request");
    if (hasConfirmedMaterial(record.id)) fail("conflict");
    return { request_id: runAnalysis(record) };
  },

  "analysis.get": ({ params, scenario }): AnalysisResult => {
    const db = getDb();
    const record = findRecord(params.recordId);
    const running = db.analyses[record.id];
    const requestId = running?.requestId ?? null;
    const startedAt = running ? new Date(running.startedAt).toISOString() : null;
    settleAnalysis(record, scenario);
    return {
      record_id: record.id,
      request_id: requestId,
      started_at: startedAt,
      status: record.analysis_status,
      candidate: record.analysis_status === "done" ? (db.candidates[record.id] ?? makeCandidate(record)) : null,
      failure_reason: record.analysis_status === "failed" ? (failureReasons[record.id] ?? "error") : null,
    };
  },

  "material.confirm": ({ params, body }): Material => {
    const db = getDb();
    const record = findRecord(params.recordId);
    if (record.analysis_status !== "done") fail("conflict");
    const input = body as MaterialConfirmInput;
    if (!input.title?.trim() || input.topic_ids.length === 0) fail("bad_request");
    const candidate = db.candidates[record.id];
    const t = now();
    const material: Material = {
      id: newId(),
      record_id: record.id,
      ...input,
      evidence: candidate?.evidence ?? null,
      origin: "ai",
      confirmed_at: t,
      user_edited_at: null,
      deleted_at: null,
      created_at: t,
      used_count: 0,
    };
    db.materials = db.materials.filter((m) => m.record_id !== record.id);
    db.materials.push(material);
    delete db.candidates[record.id];
    return material;
  },

  // 목록 10번 (제안): 제목 필수, 주제 1개 이상, 요약·키워드 선택, 근거 문장 없음
  "material.manual": ({ params, body }): Material => {
    const db = getDb();
    const record = findRecord(params.recordId);
    const input = body as MaterialManualInput;
    if (!input.title?.trim() || input.topic_ids.length === 0) fail("bad_request");
    const t = now();
    const material: Material = {
      id: newId(),
      record_id: record.id,
      title: input.title,
      summary: input.summary ?? "",
      keywords: input.keywords ?? [],
      topic_ids: input.topic_ids,
      evidence: null,
      origin: "manual",
      confirmed_at: t,
      user_edited_at: null,
      deleted_at: null,
      created_at: t,
      used_count: 0,
    };
    db.materials = db.materials.filter((m) => m.record_id !== record.id);
    db.materials.push(material);
    return material;
  },

  "materials.list": ({ scenario }): MaterialsOverview => {
    if (scenario === "empty") return { pending: [], drafts: [], kept: [], raw_only: [] };
    const db = getDb();
    const analysisScenario = scenarioFor("analysis.get");
    db.records.forEach((r) => settleAnalysis(r, analysisScenario));

    const saved = db.records.filter((r) => r.status === "saved" && !hasConfirmedMaterial(r.id));
    return {
      // ERD 규칙 4: 원본만 보관 아님 + 보관 확정 소재 없음 + 분석 중·후보·소재 없음·실패
      pending: saved
        .filter((r) => !r.original_kept_at && cardStatus(r))
        .map((record) => ({ record, card_status: cardStatus(record)! })),
      // 임시 저장만. 진행 중(active) 문답은 넣지 않음 (목록 17번)
      drafts: db.records.filter((r) => r.status === "draft"),
      kept: db.materials
        .filter((m) => m.confirmed_at && !m.deleted_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      // ERD 규칙 5: 다시 분석 중이면 '분석 중', 결과 미확인이면 '확인해 주세요'
      raw_only: saved
        .filter((r) => r.original_kept_at)
        .map((record) => {
          const status = cardStatus(record);
          return { record, card_status: status === "analyzing" || status === "review" ? status : null };
        }),
    };
  },

  "material.get": ({ params }): MaterialDetail => {
    const db = getDb();
    const material = db.materials.find((m) => m.id === params.materialId && !m.deleted_at) ?? fail("not_found");
    const record = findRecord(material.record_id);
    return {
      material,
      record,
      messages: db.messages.filter((m) => m.record_id === record.id && !m.is_replaced),
      essays: material.used_count > 0 ? [{ id: "essay-sample-1", title: "멀리 있어 더 또렷해진 것들" }] : [],
    };
  },

  "settings.clear": () => {
    clearUserData();
    return null;
  },

  "events.log": () => null,
};

/**
 * 상황 → 요청 오류. 여기 없는 상황(ok·empty·slow)은 처리 함수가 응답을 만든다.
 * empty는 뜻이 있는 키(홈·소재함·임시 저장·분석)만 빈 결과를 주고, 나머지는 정상과 같다.
 */
const SCENARIO_ERROR: Partial<Record<MockScenario, ApiErrorKind>> = {
  fail: "server",
  network: "network",
};

/** 분석 결과는 실패·시간 초과를 '요청 오류'가 아니라 '분석 실패 상태'로 돌려준다 */
const RESULT_LEVEL_KEYS: MockKey[] = ["analysis.get"];

export async function runMock<T>(options: RequestOptions): Promise<ApiResult<T>> {
  const { key, params = {} } = options.mock;
  const scenario = scenarioFor(key);
  const settings = getMockSettings();
  const resultLevel = RESULT_LEVEL_KEYS.includes(key);

  await sleep(settings.delayMs + (scenario === "slow" ? SLOW_EXTRA_MS : 0));

  if (!resultLevel) {
    if (scenario === "timeout") {
      await sleep(TIMEOUT_WAIT_MS);
      return { ok: false, error: apiError("timeout") };
    }
    const errorKind = SCENARIO_ERROR[scenario];
    if (errorKind) return { ok: false, error: apiError(errorKind) };
  } else if (scenario === "network") {
    return { ok: false, error: apiError("network") };
  }

  try {
    const data = handlers[key]({ params, body: options.body, query: options.query, scenario });
    // 화면이 목업 DB 객체를 직접 고치지 못하게 복사해서 돌려줌
    return { ok: true, data: structuredClone(data) as T };
  } catch (e) {
    if (e instanceof MockHttpError) return { ok: false, error: apiError(e.kind, MOCK_STATUS[e.kind], e.code) };
    throw e;
  }
}
