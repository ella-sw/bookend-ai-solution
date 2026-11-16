import { apiError, type ApiErrorKind, type ApiResult, type RequestOptions } from "../client";
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
  QnaReplaceResult,
  RecordDraft,
  RecordItem,
  RecordType,
} from "../types";
import { QNA_RULES } from "../types";
import { ANALYSIS_TIMEOUT_MS } from "../config";
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
  constructor(public kind: ApiErrorKind) {
    super(kind);
  }
}
const fail = (kind: ApiErrorKind): never => {
  throw new MockHttpError(kind);
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

function hasConfirmedMaterial(recordId: string) {
  return getDb().materials.some((m) => m.record_id === recordId && m.confirmed_at && !m.deleted_at);
}

function answeredCount(recordId: string) {
  return getDb().messages.filter((m) => m.record_id === recordId && m.answer && !m.is_replaced).length;
}

/** [다른 질문 보기] 남은 횟수 = 6 − 바꾼 질문 수 (ERD 규칙 10) */
function remainingReplaces(recordId: string) {
  const used = getDb().messages.filter((m) => m.record_id === recordId && m.is_replaced).length;
  return Math.max(0, QNA_RULES.replaceLimit - used);
}

/** 답을 받고 다음 후속 질문을 만든다. 답변 7개가 차면 마무리 (W212) */
function afterAnswer(record: RecordItem, answered: QnaMessage): QnaAnswerResult {
  const db = getDb();
  const finished = answeredCount(record.id) >= QNA_RULES.maxAnswers;
  let next: QnaMessage | null = null;
  if (!finished) {
    next = newFollowup(record.id);
    db.messages.push(next);
  }
  return { answered, next, finished };
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

function newFollowup(recordId: string): QnaMessage {
  const db = getDb();
  const used = new Set(db.messages.filter((m) => m.record_id === recordId).map((m) => m.question));
  const question = FOLLOWUP_QUESTIONS.find((q) => !used.has(q)) ?? FOLLOWUP_QUESTIONS[0];
  const seq = db.messages.filter((m) => m.record_id === recordId).length + 1;
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

  "records.draft.get": ({ query, scenario }): RecordDraft | null => {
    if (scenario === "empty") return null;
    const db = getDb();
    const record = db.records.find((r) => r.type === query?.type && r.status === "draft");
    if (!record) return null;
    return { record, messages: db.messages.filter((m) => m.record_id === record.id) };
  },

  "records.draft.save": ({ body }): RecordItem => {
    const input = body as { type: RecordType; record_id?: string; title?: string | null; body?: string | null };
    const db = getDb();
    // 방식별 임시 저장은 1개만 (ERD 규칙 16)
    let record = input.record_id ? db.records.find((r) => r.id === input.record_id) : undefined;
    record ??= db.records.find((r) => r.type === input.type && r.status === "draft");
    if (!record) {
      record = newRecord(input.type, "draft");
      db.records.push(record);
    }
    if (record.status === "saved") fail("conflict"); // 저장한 원본은 고칠 수 없음 (ERD 규칙 2)
    // 방식별 임시 저장 1개: 같은 방식의 이전 임시 저장은 이때 덮어씀 (H121 [아니오] 뒤 규칙)
    const keepId = record.id;
    const dropped = db.records.filter((r) => r.type === input.type && r.status === "draft" && r.id !== keepId).map((r) => r.id);
    db.records = db.records.filter((r) => !dropped.includes(r.id));
    db.messages = db.messages.filter((m) => !dropped.includes(m.record_id));
    if (input.type === "free") {
      record.title = input.title ?? record.title;
      record.body = input.body ?? record.body;
    }
    record.updated_at = now();
    return record;
  },

  "records.save.free": ({ body }): RecordItem => {
    const input = body as { record_id?: string; title?: string | null; body: string };
    if (!input.body?.trim()) fail("bad_request");
    const db = getDb();
    // 이어 쓰던 임시 저장(H121 [예])이면 그 기록을 저장으로 바꿈.
    // 새로 시작했으면([아니오]) 기존 임시 저장은 그대로 둔다 (다음 임시 저장 때 덮어씀)
    const draft = input.record_id
      ? db.records.find((r) => r.id === input.record_id && r.type === "free" && r.status === "draft")
      : undefined;
    const t = now();
    if (draft) {
      Object.assign(draft, { title: input.title ?? null, body: input.body, status: "saved", saved_at: t, updated_at: t });
      return draft;
    }
    const record = newRecord("free", "saved", { title: input.title ?? null, body: input.body });
    db.records.push(record);
    return record;
  },

  "records.save.qna": ({ params }): RecordItem => {
    const record = findRecord(params.recordId);
    if (answeredCount(record.id) < QNA_RULES.minAnswersToSave) fail("bad_request");
    record.status = "saved";
    record.saved_at = record.updated_at = now();
    return record;
  },

  "records.keep": ({ params }): RecordItem => {
    const record = findRecord(params.recordId);
    record.original_kept_at = now();
    return record;
  },

  "records.delete": ({ params }) => {
    const db = getDb();
    const record = findRecord(params.recordId);
    if (hasConfirmedMaterial(record.id)) fail("conflict"); // 보관 확정 소재가 있으면 지울 수 없음 (ERD 규칙 6)
    db.records = db.records.filter((r) => r.id !== record.id);
    db.messages = db.messages.filter((m) => m.record_id !== record.id);
    delete db.candidates[record.id];
    return null;
  },

  // 목록 17번 (방법 A): 첫 답변 때 문답 기록을 처음 만든다. 들어오기만 해서는 아무것도 안 생김
  "qna.start": ({ body }): QnaFirstAnswerResult => {
    const db = getDb();
    const input = body as { daily_question_id: string; answer: string };
    if (!input.answer?.trim()) fail("bad_request");
    const daily = db.dailyQuestions.find((q) => q.id === input.daily_question_id) ?? fail("bad_request");

    const record = newRecord("qna", "draft");
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
    return { record, remaining_replaces: remainingReplaces(record.id), ...afterAnswer(record, first) };
  },

  "qna.daily": () => getDb().dailyQuestions,

  "qna.answer": ({ params, body }): QnaAnswerResult => {
    const db = getDb();
    const record = findRecord(params.recordId);
    if (record.type !== "qna" || record.status !== "draft") fail("conflict");
    const input = body as { message_id: string; answer: string };
    if (!input.answer?.trim()) fail("bad_request");
    // 답변 7개가 차면 더 받지 않음 (W212 질문 마무리)
    if (answeredCount(record.id) >= QNA_RULES.maxAnswers) fail("conflict");

    const message =
      db.messages.find((m) => m.id === input.message_id && m.record_id === record.id) ?? fail("not_found");
    if (message.is_replaced || message.answer) fail("conflict");
    message.answer = input.answer;
    record.updated_at = now();
    return afterAnswer(record, message);
  },

  // 목록 12번 (제안): 새 질문 만들기 성공 뒤에만 교체·차감. 실패면 기존 질문·횟수 유지 (fail 상황으로 확인)
  "qna.replace": ({ params, body }): QnaReplaceResult => {
    const db = getDb();
    const record = findRecord(params.recordId);
    const { message_id } = body as { message_id: string };
    if (remainingReplaces(record.id) <= 0) fail("conflict");
    const current = db.messages.find((m) => m.id === message_id && m.record_id === record.id) ?? fail("not_found");
    if (current.answer || current.is_replaced || current.question_source !== "followup") fail("conflict");

    current.is_replaced = true; // 바꾼 질문도 기록에 남김
    const next = newFollowup(record.id);
    db.messages.push(next);
    return { message: next, remaining: remainingReplaces(record.id) };
  },

  // W211 [저장하지 않고 나가기]: 임시 저장 전 문답 기록을 지움
  "qna.discard": ({ params }) => {
    const db = getDb();
    const record = findRecord(params.recordId);
    if (record.type !== "qna" || record.status !== "draft") fail("conflict");
    db.records = db.records.filter((r) => r.id !== record.id);
    db.messages = db.messages.filter((m) => m.record_id !== record.id);
    return null;
  },

  "analysis.start": ({ params }) => {
    const db = getDb();
    const record = findRecord(params.recordId);
    if (record.status !== "saved") fail("bad_request");
    if (hasConfirmedMaterial(record.id)) fail("conflict");
    const requestId = db.nextRequestId++;
    record.analysis_status = "analyzing";
    db.analyses[record.id] = { requestId, startedAt: Date.now() };
    delete db.candidates[record.id];
    delete failureReasons[record.id];
    return { request_id: requestId };
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
    if (e instanceof MockHttpError) return { ok: false, error: apiError(e.kind) };
    throw e;
  }
}
