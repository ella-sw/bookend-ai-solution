import { apiError, type ApiErrorCode, type ApiErrorKind, type ApiResult, type RequestOptions } from "../client";
import type {
  AnalysisResult,
  DailyQuestions,
  HomeSummary,
  Material,
  MaterialConfirmInput,
  MaterialDetail,
  MaterialManualInput,
  MaterialsOverview,
  Me,
  PendingCardStatus,
  QnaMessage,
  QnaState,
  RecordItem,
  RecordType,
} from "../types";
import { QNA_RULES } from "../types";
import { ANALYSIS_TIMEOUT_MS, QNA_RESUME_WINDOW_MS } from "../config";
import type { MockKey } from "./keys";
import { getMockSettings, scenarioFor, type MockScenario } from "./scenario";
import { clearUserData, FOLLOWUP_QUESTIONS, getDb, newId, now, topicId, type MockMessage } from "./store";

/**
 * 목업 응답. 모양·오류 코드는 B 서버(feat/backend-setup server/app/routers/*.py)와 같게 맞춘다.
 */

/** 목업에서 분석이 끝나기까지 걸리는 시간 (실제 목표 10~20초를 짧게 줄임) */
const MOCK_ANALYSIS_MS = 3_000;
/** 목업의 '60초 시간 초과'를 줄인 값 ('시간 초과' 상황을 오래 기다리지 않고 확인하려고). 실제 서버는 60초 */
const MOCK_ANALYSIS_TIMEOUT_MS = Math.min(ANALYSIS_TIMEOUT_MS, 8_000);
const SLOW_EXTRA_MS = 2_500;
const TIMEOUT_WAIT_MS = 3_000;

/** 오류 종류별 HTTP 상태 (실제 서버와 같게). bad_request는 B가 주로 422를 쓴다 */
const MOCK_STATUS: Record<ApiErrorKind, number | undefined> = {
  bad_request: 422,
  not_found: 404,
  conflict: 409,
  timeout: undefined,
  network: undefined,
  server: 500,
};

class MockHttpError extends Error {
  constructor(
    public kind: ApiErrorKind,
    public code?: ApiErrorCode,
    public status: number | undefined = MOCK_STATUS[kind],
  ) {
    super(code ?? kind);
  }
}
const fail = (kind: ApiErrorKind, code?: ApiErrorCode, status?: number): never => {
  throw new MockHttpError(kind, code, status ?? MOCK_STATUS[kind]);
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
  return getDb().records.find((r) => r.id === id) ?? fail("not_found", "record_not_found");
}

/** 열린 문답(active·draft)만. 없거나 저장됐으면 404 conversation_not_found (B: _lock_open_record) */
function findOpenQna(id: string): RecordItem {
  const record = getDb().records.find(
    (r) => r.id === id && r.type === "qna" && (r.status === "active" || r.status === "draft"),
  );
  return record ?? fail("not_found", "conversation_not_found");
}

function hasConfirmedMaterial(recordId: string) {
  return getDb().materials.some((m) => m.record_id === recordId && m.confirmed_at && !m.deleted_at);
}

/** 이 기록의 문답 행 전부 (바꾼 질문 포함), seq 순 */
function rowsOf(recordId: string): MockMessage[] {
  return getDb()
    .messages.filter((m) => m.record_id === recordId)
    .sort((a, b) => a.seq - b.seq);
}

/** 화면에 나가는 모양 (B: Message) */
function toMessage(m: MockMessage): QnaMessage {
  return { id: m.id, seq: m.seq, question: m.question, question_source: m.question_source, answer: m.answer };
}

/** B: _summary — 바꾼 질문을 뺀 문답, 답변 수, 바꾼 수, 답을 기다리는 질문, 마지막 seq */
function summary(recordId: string) {
  const rows = rowsOf(recordId);
  const live = rows.filter((m) => !m.is_replaced);
  const open = live.filter((m) => m.answer === null);
  return {
    live,
    answerCount: live.length - open.length,
    replaced: rows.length - live.length,
    pending: open[open.length - 1] ?? null,
    maxSeq: rows[rows.length - 1]?.seq ?? 0,
  };
}

/** B: _state */
function qnaState(record: RecordItem, aiFailed = false): QnaState {
  const s = summary(record.id);
  return {
    record_id: record.id,
    status: record.status === "draft" ? "draft" : "active",
    updated_at: record.updated_at,
    messages: s.live.map(toMessage),
    pending_question: s.pending ? toMessage(s.pending) : null,
    answer_count: s.answerCount,
    replace_left: Math.max(0, QNA_RULES.replaceLimit - s.replaced),
    finished: s.answerCount >= QNA_RULES.maxAnswers,
    can_save: s.answerCount >= QNA_RULES.minAnswersToSave,
    ai_failed: aiFailed,
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

/** 기록과 딸린 문답·기준점·분석 상태를 지운다. 실제 서버는 관련 ai_requests도 지움 (목록 17번 ⑧) */
function removeRecords(ids: string[]) {
  if (ids.length === 0) return;
  const db = getDb();
  db.records = db.records.filter((r) => !ids.includes(r.id));
  db.messages = db.messages.filter((m) => !ids.includes(m.record_id));
  for (const id of ids) {
    delete db.checkpoints[id];
    delete db.analyses[id];
    delete db.candidates[id];
  }
}

/** 같은 방식·같은 status인 기록 id (방식별 active·draft는 1개) */
function idsWithStatus(type: RecordType, status: RecordItem["status"], exceptId?: string) {
  return getDb()
    .records.filter((r) => r.type === type && r.status === status && r.id !== exceptId)
    .map((r) => r.id);
}

/**
 * 기준점으로 되돌리기 (목록 17번 ⑤, B: revert_qna_draft):
 * seq > 기준점 삭제 + 기다리던 질문 answer = null, is_replaced = false. 바뀐 게 없으면 그대로.
 * 실제 서버는 기준점 뒤에 시작한 ai_requests도 지운다 (⑧)
 */
function revertToCheckpoint(record: RecordItem) {
  const db = getDb();
  const cp = db.checkpoints[record.id];
  if (!cp) return;
  const rows = rowsOf(record.id);
  const waiting = rows.find((m) => m.id === cp.pendingId);
  const changed = rows.some((m) => m.seq > cp.seq) || (!!waiting && (waiting.answer !== null || waiting.is_replaced));
  if (!changed) return;
  db.messages = db.messages.filter((m) => m.record_id !== record.id || m.seq <= cp.seq);
  if (waiting) {
    waiting.answer = null;
    waiting.is_replaced = false;
  }
  touch(record);
}

/**
 * 다음(또는 바꿀) 질문 만들기 (B: _generate_question). 'AI 실패' 상황이면 아무것도 바꾸지 않고 false.
 * replaceOf가 있으면 그 질문을 is_replaced로 바꾼 뒤 새 질문을 붙인다.
 */
function generateQuestion(record: RecordItem, scenario: MockScenario, replaceOf?: MockMessage): boolean {
  if (scenario === "ai_fail") return false;
  const rows = rowsOf(record.id);
  const used = new Set(rows.map((m) => m.question));
  const question = FOLLOWUP_QUESTIONS.find((q) => !used.has(q)) ?? FOLLOWUP_QUESTIONS[0];
  if (replaceOf) replaceOf.is_replaced = true; // 바꾼 질문도 기록에는 남김 (응답에서는 빠짐)
  getDb().messages.push({
    id: newId(),
    record_id: record.id,
    seq: (rows[rows.length - 1]?.seq ?? 0) + 1,
    question,
    question_source: "followup",
    daily_question_id: null,
    answer: null,
    is_replaced: false,
  });
  touch(record);
  return true;
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
 * 저장 확정 + 분석 시작 (B: start_analysis_after). 시작이 실패해도 저장은 성공 → analysis_status = failed.
 * 목업: analysis.start 키의 상황이 실패·연결 끊김·시간 초과면 '시작 실패'
 */
function markSaved(record: RecordItem) {
  const t = now();
  record.status = "saved";
  record.saved_at = t;
  record.updated_at = t;
  delete getDb().checkpoints[record.id];
  const s = scenarioFor("analysis.start");
  if (s === "fail" || s === "network" || s === "timeout") {
    record.analysis_status = "failed";
    failureReasons[record.id] = "error";
  } else {
    runAnalysis(record);
  }
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
    ...fields,
  };
}

/** "" → null (제목은 선택, B: _clean_title) */
const cleanTitle = (title: string | null | undefined) => title?.trim() || null;

/** 오늘(KST) 날짜 YYYY-MM-DD */
function kstToday() {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/* ---------- 처리 함수 (키별) ---------- */

const handlers: Record<MockKey, (ctx: Ctx) => unknown> = {
  "me.get": (): Me => {
    const db = getDb();
    if (!db.consentAt) fail("not_found", "not_consented");
    return { id: "mock-user", ai_consent_at: db.consentAt, last_seen_at: now(), data_cleared_at: null };
  },

  "me.consent": (): Me => {
    const db = getDb();
    db.consentAt ??= now();
    return { id: "mock-user", ai_consent_at: db.consentAt, last_seen_at: now(), data_cleared_at: null };
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

  /* ----- 자유 기록 (B: routers/records.py) ----- */

  // 없으면 404 no_draft (getFreeDraft가 null로 바꿈)
  "records.free.draft.get": ({ scenario }): RecordItem => {
    if (scenario === "empty") fail("not_found", "no_draft");
    return getDb().records.find((r) => r.type === "free" && r.status === "draft") ?? fail("not_found", "no_draft");
  },

  // 임시 저장 1개: 이어 쓰기면 record_id의 draft를, 아니면 있던 draft를 덮어쓰거나 새로 만든다
  "records.free.draft.save": ({ body }): RecordItem => {
    const input = body as { record_id?: string | null; title?: string | null; body?: string };
    const db = getDb();
    let record: RecordItem | undefined;
    if (input.record_id) {
      record = db.records.find((r) => r.id === input.record_id && r.type === "free" && r.status === "draft");
      // 이어 쓰던 임시 저장이 없거나 이미 저장됨 → 화면은 record_id 없이 다시 보내면 됨
      if (!record) return fail("not_found", "draft_not_found");
    } else {
      record = db.records.find((r) => r.type === "free" && r.status === "draft");
      if (!record) {
        record = newRecord("free", "draft");
        db.records.push(record);
      }
    }
    record.title = cleanTitle(input.title);
    record.body = input.body ?? "";
    touch(record);
    return record;
  },

  // [소재로 저장] (⑨): 같은 save_token·이미 저장된 record_id면 200 + 그 기록
  "records.free.save": ({ body }): RecordItem => {
    const input = body as { record_id?: string | null; title?: string | null; body?: string; save_token?: string };
    if (!input.body?.trim()) fail("bad_request", "empty_body");
    const saveToken = input.save_token ?? fail("bad_request");
    const db = getDb();
    const byToken = db.saveTokens[saveToken];
    const already = byToken ? db.records.find((r) => r.id === byToken && r.status === "saved") : undefined;
    if (already) return already;

    let record: RecordItem;
    if (input.record_id) {
      const found = db.records.find((r) => r.id === input.record_id && r.type === "free");
      if (found?.status === "saved") return found;
      // 이어 쓰던 임시 저장(H121 [예]) → 그 기록을 저장으로
      if (!found || found.status !== "draft") return fail("not_found", "draft_not_found");
      record = found;
    } else {
      // 새로 시작([아니오]): 기존 임시 저장은 그대로 둔다 (다음 임시 저장 때 덮어씀)
      record = newRecord("free", "draft");
      db.records.push(record);
    }
    record.title = cleanTitle(input.title);
    record.body = input.body ?? "";
    db.saveTokens[saveToken] = record.id;
    return markSaved(record);
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

  /* ----- AI 문답 (B: routers/qna.py, 목록 17번) ----- */

  "qna.daily": (): DailyQuestions => {
    const db = getDb();
    const today = kstToday();
    // 목업 DB의 질문을 오늘 날짜로 보여 줌 (날짜가 바뀌어도 새로고침 전까지 같은 30개)
    return {
      date: today,
      questions: db.dailyQuestions.map(({ id, seq, question }) => ({ id, seq, question })),
    };
  },

  // H120: 진행 중 문답. 1시간 지난 active는 지우고 null (⑥)
  "qna.active.get": ({ scenario }): QnaState | null => {
    if (scenario === "empty") return null;
    const record = getDb().records.find((r) => r.type === "qna" && r.status === "active");
    if (!record) return null;
    if (isExpired(record)) {
      removeRecords([record.id]);
      return null;
    }
    return qnaState(record);
  },

  // H121: 임시 저장 문답. 1시간 지난 draft는 기준점으로 되돌려서 준다 (⑥). 지우지는 않음
  "qna.draft.get": ({ scenario }): QnaState | null => {
    if (scenario === "empty") return null;
    const record = getDb().records.find((r) => r.type === "qna" && r.status === "draft");
    if (!record) return null;
    if (isExpired(record)) revertToCheckpoint(record);
    return qnaState(record);
  },

  // 첫 답변: active + 첫 문답을 만든다. 이전 active는 지운다 (②)
  "qna.start": ({ body, scenario }): QnaState => {
    const db = getDb();
    const input = body as { daily_question_id: string; answer: string };
    if (!input.answer?.trim()) fail("bad_request");
    const daily =
      db.dailyQuestions.find((q) => q.id === input.daily_question_id) ?? fail("bad_request", "invalid_daily_question");

    removeRecords(idsWithStatus("qna", "active"));
    const record = newRecord("qna", "active");
    db.records.push(record);
    db.messages.push({
      id: newId(),
      record_id: record.id,
      seq: 1,
      question: daily.question,
      question_source: "daily",
      daily_question_id: daily.id,
      answer: input.answer.trim(),
      is_replaced: false,
    });
    const ok = generateQuestion(record, scenario);
    return qnaState(record, !ok);
  },

  // 후속 답변. 7번째 답변이면 더 묻지 않음 (finished → W212)
  "qna.answer": ({ params, body, scenario }): QnaState => {
    const record = findOpenQna(params.recordId);
    const input = body as { question_id: string; answer: string };
    if (!input.answer?.trim()) fail("bad_request");
    const s = summary(record.id);
    if (s.answerCount >= QNA_RULES.maxAnswers) fail("conflict", "finished");
    if (!s.pending || s.pending.id !== input.question_id) fail("conflict", "not_pending_question");
    s.pending!.answer = input.answer.trim();
    touch(record);
    if (s.answerCount + 1 >= QNA_RULES.maxAnswers) return qnaState(record);
    const ok = generateQuestion(record, scenario);
    return qnaState(record, !ok);
  },

  // [다시 시도] (⑦): 답을 기다리는 질문이 없을 때만 새로 만든다. 있거나 7개면 그대로
  "qna.next": ({ params, scenario }): QnaState => {
    const record = findOpenQna(params.recordId);
    const s = summary(record.id);
    if (s.pending || s.answerCount >= QNA_RULES.maxAnswers) return qnaState(record);
    const ok = generateQuestion(record, scenario);
    return qnaState(record, !ok);
  },

  // [다른 질문 보기] (목록 12번): 성공 뒤에만 교체·차감. 실패면 그대로 + ai_failed
  "qna.replace": ({ params, body, scenario }): QnaState => {
    const record = findOpenQna(params.recordId);
    const { question_id } = body as { question_id: string };
    const s = summary(record.id);
    if (!s.pending || s.pending.id !== question_id) fail("conflict", "not_pending_question");
    if (s.pending!.question_source !== "followup") fail("conflict", "first_question_not_replaceable");
    if (s.replaced >= QNA_RULES.replaceLimit) fail("conflict", "replace_limit");
    const ok = generateQuestion(record, scenario, s.pending!);
    return qnaState(record, !ok);
  },

  // [임시 저장] (③·⑤): active면 이전 draft를 지우고 → draft. 기준점(마지막 seq·기다리던 질문·시각) 기록
  "qna.draft.save": ({ params }): QnaState => {
    const db = getDb();
    const record = findOpenQna(params.recordId);
    if (record.status === "active") removeRecords(idsWithStatus("qna", "draft"));
    const s = summary(record.id);
    record.status = "draft";
    db.checkpoints[record.id] = { seq: s.maxSeq, pendingId: s.pending?.id ?? null, at: now() };
    return qnaState(record);
  },

  // 이어 쓰던 draft의 [저장하지 않고 나가기]: 기준점으로 되돌림
  "qna.draft.revert": ({ params }): QnaState => {
    const record = findOpenQna(params.recordId);
    if (record.status !== "draft") fail("conflict", "not_draft");
    revertToCheckpoint(record);
    return qnaState(record);
  },

  // [소재로 저장]: 답변 2개부터. 답을 기다리던 질문은 빼고 저장. 이미 저장됐으면 200 + 그 기록
  "qna.save": ({ params }): RecordItem => {
    const db = getDb();
    const record =
      db.records.find((r) => r.id === params.recordId && r.type === "qna") ?? fail("not_found", "conversation_not_found");
    if (record.status === "saved") return record;
    const s = summary(record.id);
    if (s.answerCount < QNA_RULES.minAnswersToSave) fail("conflict", "need_more_answers");
    if (s.pending) db.messages = db.messages.filter((m) => m.id !== s.pending!.id);
    return markSaved(record);
  },

  // W211 [저장하지 않고 나가기]: active만 지운다 (④)
  "qna.discard": ({ params }) => {
    const record = findOpenQna(params.recordId);
    if (record.status !== "active") fail("conflict", "not_active");
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
      messages: db.messages.filter((m) => m.record_id === record.id && !m.is_replaced).map(toMessage),
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

/** '실패' 상황에서 키별로 실제 서버가 주는 상태·코드 (없으면 500) */
const FAIL_DETAIL: Partial<Record<MockKey, { status: number; code: ApiErrorCode }>> = {
  // 오늘의 질문을 AI로 만들지 못함 (B: 502 detail = ai_failed)
  "qna.daily": { status: 502, code: "ai_failed" },
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
    if (errorKind === "server") {
      const detail = FAIL_DETAIL[key];
      return { ok: false, error: apiError("server", detail?.status ?? 500, detail?.code) };
    }
    if (errorKind) return { ok: false, error: apiError(errorKind) };
  } else if (scenario === "network") {
    return { ok: false, error: apiError("network") };
  }

  try {
    const data = handlers[key]({ params, body: options.body, query: options.query, scenario });
    // 화면이 목업 DB 객체를 직접 고치지 못하게 복사해서 돌려줌
    return { ok: true, data: structuredClone(data) as T };
  } catch (e) {
    if (e instanceof MockHttpError) return { ok: false, error: apiError(e.kind, e.status, e.code) };
    throw e;
  }
}
