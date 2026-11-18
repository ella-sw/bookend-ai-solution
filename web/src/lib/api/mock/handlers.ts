import { apiError, readErrorCode, type ApiErrorCode, type ApiErrorKind, type ApiResult, type RequestOptions } from "../client";
import type {
  AnalysisMaterial,
  AnalysisState,
  ConfirmMaterialInput,
  DailyQuestions,
  HomeSummary,
  Material,
  MaterialDetail,
  EditMaterialInput,
  Essay,
  EssayDraft,
  MaterialRef,
  RelatedMaterial,
  SaveEssayInput,
  Suggestion,
  SuggestionList,
  MaterialBox,
  MaterialCard,
  Original,
  RecordCard,
  Me,
  QnaMessage,
  QnaState,
  RecordItem,
  RecordType,
} from "../types";
import { ESSAY_RULES, MATERIAL_RULES, QNA_RULES, TOPICS } from "../types";
import { ANALYSIS_TIMEOUT_MS, QNA_RESUME_WINDOW_MS } from "../config";
import type { MockKey } from "./keys";
import { getMockSettings, scenarioFor, type MockScenario } from "./scenario";
import { clearMockSession, getMockSession, setMockConsent, type MockSession } from "./session";
import {
  clearUserData,
  FOLLOWUP_QUESTIONS,
  getDb,
  MOCK_ESSAYS,
  newId,
  now,
  topicId,
  type MockEssay,
  type MockMessage,
  type MockReanalysis,
  type MockSuggestion,
} from "./store";

/**
 * 목업 응답. 모양·오류 코드는 B 서버(feat/backend-setup server/app/routers/*.py)와 같게 맞춘다.
 */

/** 분석 결과가 나오기까지의 조회 횟수 (목업: 2~4번째 조회에서 결과) */
const randomPollsNeeded = () => 2 + Math.floor(Math.random() * 3);
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
  unauthorized: 401,
  not_consented: 403,
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

/** 열린 문답(active·draft)만. 없거나 저장됐으면 404 conversation_not_found (B: _lock_open_record) */
function findOpenQna(id: string): RecordItem {
  const record = getDb().records.find(
    (r) => r.id === id && r.type === "qna" && (r.status === "active" || r.status === "draft"),
  );
  return record ?? fail("not_found", "conversation_not_found");
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
/** 질문 만들기 결과 (B: _generate_question → "ok" / "failed" / "limit") */
type GenerateResult = "ok" | "failed" | "limit";

function qnaState(record: RecordItem, result: GenerateResult = "ok"): QnaState {
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
    ai_failed: result === "failed",
    daily_limit_reached: result === "limit",
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
  }
  db.materials = db.materials.filter((m) => !ids.includes(m.record_id));
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
function generateQuestion(record: RecordItem, scenario: MockScenario, replaceOf?: MockMessage): GenerateResult {
  // 하루 한도: AI를 부르지 않음, 아무것도 바꾸지 않음 (B R32)
  if (scenario === "daily_limit") return "limit";
  if (scenario === "ai_fail") return "failed";
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
  return "ok";
}

/** 소재함 기록 카드 (B: RecordCard). preview = 본문 또는 답변 앞 80자 */
function recordCard(record: RecordItem, label: RecordCard["label"]): RecordCard {
  return {
    record_id: record.id,
    record_type: record.type,
    title: record.title,
    preview: sourceText(record).slice(0, 80),
    status: record.status === "draft" ? "draft" : "saved",
    analysis_status: record.analysis_status,
    label,
    date: record.status === "saved" ? (record.saved_at ?? record.updated_at) : record.updated_at,
  };
}

/**
 * 보관한 소재의 다시 분석 결과를 낸다 (목업 전용). 결과는 '다시 분석 결과 (M131)' 상황으로 고른다
 * - 정상: 2~4번째 조회에서 done / 빈 결과: empty / 실패: failed / 시간 초과: 60초 뒤 failed
 */
function settleReanalysis(material: Material, re: MockReanalysis) {
  if (re.status !== "analyzing") return;
  const scenario = scenarioFor("material.reanalysis.result");
  if (Date.now() - re.startedAt >= ANALYSIS_TIMEOUT_MS) {
    re.status = "failed";
    return;
  }
  if (scenario === "timeout" || re.polls < re.pollsNeeded) return;
  if (scenario === "empty") re.status = "empty";
  else if (scenario === "fail") re.status = "failed";
  else {
    const record = getDb().records.find((r) => r.id === material.record_id);
    const text = record ? sourceText(record).trim() : "";
    const sentences = text.split(/(?<=[.!?。])\s+/).filter(Boolean);
    const evidence = sentences[sentences.length - 1] ?? text;
    re.status = "done";
    re.result = {
      title: material.title,
      summary: `${evidence.slice(0, 40)} (다시 찾은 소재)`,
      evidence,
      keywords: Array.from(new Set(text.split(/\s+/).filter((w) => w.length >= 2))).slice(-3),
      topics: topicRefs([topicId("일상"), topicId("나·성장")]),
    };
  }
}

/** 보관한 소재만 (확정됨·삭제 안 함). 없으면 404 material_not_found (B: _live_material) */
function liveMaterial(id: string): Material {
  const m = getDb().materials.find((x) => x.id === id && x.confirmed_at && !x.deleted_at);
  return m ?? fail("not_found", "material_not_found");
}

/** B EditIn 검사: 보낸 칸만 (규칙은 ConfirmIn과 같음) */
function checkEditInput(body: unknown) {
  const input = (body ?? {}) as EditMaterialInput;
  const out: { summary?: string; keywords?: string[]; topics?: number[] } = {};
  if (input.summary !== undefined) {
    const summary = String(input.summary).trim();
    if (summary.length < 1 || summary.length > MATERIAL_RULES.summaryMax) fail("bad_request");
    out.summary = summary;
  }
  if (input.keywords !== undefined) {
    const keywords = input.keywords.map((k) => String(k).trim());
    if (keywords.length > MATERIAL_RULES.keywordsMax) fail("bad_request");
    if (keywords.some((k) => k.length < 1 || k.length > MATERIAL_RULES.keywordMax)) fail("bad_request");
    out.keywords = Array.from(new Set(keywords));
  }
  if (input.topics !== undefined) {
    if (input.topics.length < 1 || input.topics.length > MATERIAL_RULES.topicsMax) fail("bad_request");
    if (input.topics.some((id) => !TOPICS.some((t) => t.id === id))) fail("bad_request", "unknown_topic");
    out.topics = Array.from(new Set(input.topics)).sort((x, y) => x - y);
  }
  return out;
}


/**
 * 분석 중인 기록의 결과를 낸다 (목업 전용). 상황은 analysis.get 키로 고른다
 * - 정상: 2~4번째 조회에서 done (확정 전 소재를 만든다) / 빈 결과: empty / 실패: failed
 * - 시간 초과: 결과 없이 분석 중 → 시작 후 60초가 지나면 failed (서버 규칙, 판단은 서버가 함)
 */
function settleAnalysis(record: RecordItem, scenario: MockScenario) {
  const db = getDb();
  const running = db.analyses[record.id];
  if (!running || record.analysis_status !== "analyzing") return;
  if (Date.now() - running.startedAt >= ANALYSIS_TIMEOUT_MS) {
    delete db.analyses[record.id];
    record.analysis_status = "failed";
    return;
  }
  if (scenario === "timeout") return;
  if (running.polls < running.pollsNeeded) return;

  delete db.analyses[record.id];
  if (scenario === "empty") {
    record.analysis_status = "empty";
  } else if (scenario === "fail") {
    record.analysis_status = "failed";
  } else {
    record.analysis_status = "done";
    putCandidate(record);
  }
}

/** 분석 시작 (목업: 시작 시각·필요한 조회 횟수만 기록). 이전 후보(확정 전 소재)는 버린다 */
function runAnalysis(record: RecordItem) {
  const db = getDb();
  const requestId = db.nextRequestId++;
  record.analysis_status = "analyzing";
  db.analyses[record.id] = { requestId, startedAt: Date.now(), polls: 0, pollsNeeded: randomPollsNeeded() };
  db.materials = db.materials.filter((m) => m.record_id !== record.id || m.confirmed_at || m.deleted_at);
  return requestId;
}

/**
 * 오늘 AI 호출을 다 썼나 (B R32). 목업: analysis.start 키의 상황이 '하루 한도'면 true
 * → 저장 때 분석이 failed + 한도 표시, 다시 분석은 429 daily_limit
 */
function analysisLimitReached() {
  return scenarioFor("analysis.start") === "daily_limit";
}

/**
 * 저장 확정 + 분석 시작 (B: start_analysis_after). 시작이 실패해도 저장은 성공 → analysis_status = failed.
 * 목업: analysis.start 키의 상황이 실패·연결 끊김·시간 초과·하루 한도면 '시작 실패'
 */
function markSaved(record: RecordItem) {
  const t = now();
  record.status = "saved";
  record.saved_at = t;
  record.updated_at = t;
  delete getDb().checkpoints[record.id];
  const s = scenarioFor("analysis.start");
  if (s === "fail" || s === "network" || s === "timeout" || s === "daily_limit") {
    record.analysis_status = "failed";
  } else {
    runAnalysis(record);
  }
  return record;
}

const topicRefs = (ids: number[]) =>
  TOPICS.filter((t) => ids.includes(t.id)).map((t) => ({ id: t.id, name: t.name as string }));

/** 이 기록의 소재 (삭제하지 않은 것: 후보 또는 보관한 소재) */
function materialOf(recordId: string) {
  return getDb().materials.find((m) => m.record_id === recordId && !m.deleted_at) ?? null;
}

function materialDeleted(recordId: string) {
  return getDb().materials.some((m) => m.record_id === recordId && m.deleted_at);
}

function toAnalysisMaterial(m: Material): AnalysisMaterial {
  return {
    id: m.id,
    title: m.title,
    summary: m.summary,
    evidence: m.evidence,
    keywords: m.keywords,
    topics: topicRefs(m.topic_ids),
    origin: m.origin,
    confirmed_at: m.confirmed_at,
  };
}

/** 저장된 기록만 (B: status = 'saved'). 없으면 404 record_not_found */
function findSavedRecord(id: string): RecordItem {
  const record = getDb().records.find((r) => r.id === id && r.status === "saved");
  return record ?? fail("not_found", "record_not_found");
}

/** B analysis.py: _state */
function analysisState(record: RecordItem): AnalysisState {
  const m = materialOf(record.id);
  return {
    record_id: record.id,
    record_type: record.type,
    analysis_status: record.analysis_status,
    original_kept_at: record.original_kept_at,
    can_reanalyze: record.analysis_status === "failed" || record.analysis_status === "none",
    daily_limit_reached: analysisLimitReached(),
    material: m ? toAnalysisMaterial(m) : null,
  };
}

/** B materials.py: _original */
function originalOf(record: RecordItem): Original {
  return {
    record_id: record.id,
    record_type: record.type,
    title: record.title,
    body: record.body,
    messages: rowsOf(record.id)
      .filter((m) => !m.is_replaced && m.answer !== null)
      .map((m) => ({ seq: m.seq, question: m.question, answer: m.answer! })),
    saved_at: record.saved_at,
  };
}

/** B materials.py: _reanalysis — 진행 중이거나, 아직 [바꾸기]·[그대로 두기]를 하지 않은 결과 */
function reanalysisOf(materialId: string): MaterialDetail["reanalysis"] {
  const re = getDb().reanalyses[materialId];
  if (!re) return null;
  return { status: re.status, result: re.status === "done" ? re.result : null };
}

/** B materials.py: _detail */
function materialDetail(m: Material): MaterialDetail {
  const record = findSavedRecord(m.record_id);
  return {
    id: m.id,
    title: m.title,
    summary: m.summary,
    evidence: m.evidence,
    keywords: m.keywords,
    topics: topicRefs(m.topic_ids),
    origin: m.origin,
    confirmed_at: m.confirmed_at!,
    user_edited_at: m.user_edited_at,
    created_at: m.created_at,
    original: originalOf(record),
    essays: MOCK_ESSAYS.slice(0, m.used_count),
    reanalysis: reanalysisOf(m.id),
  };
}

/**
 * B ConfirmIn 검사 (FastAPI 입력 검사: 422, 코드 없음). 주제 id가 없으면 422 unknown_topic.
 * 앞뒤 공백을 지운 값을 돌려준다
 */
function checkConfirmInput(body: unknown) {
  const input = (body ?? {}) as Partial<ConfirmMaterialInput>;
  const title = typeof input.title === "string" ? input.title.trim() : null;
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  const keywords = Array.isArray(input.keywords) ? input.keywords.map((k) => String(k).trim()) : [];
  const topics = Array.isArray(input.topics) ? input.topics : [];
  if (title !== null && title.length > MATERIAL_RULES.titleMax) fail("bad_request");
  if (summary.length < 1 || summary.length > MATERIAL_RULES.summaryMax) fail("bad_request");
  if (keywords.length > MATERIAL_RULES.keywordsMax) fail("bad_request");
  if (keywords.some((k) => k.length < 1 || k.length > MATERIAL_RULES.keywordMax)) fail("bad_request");
  if (topics.length < 1 || topics.length > MATERIAL_RULES.topicsMax) fail("bad_request");
  if (topics.some((id) => !TOPICS.some((t) => t.id === id))) fail("bad_request", "unknown_topic");
  return {
    title: title || null,
    summary,
    keywords: Array.from(new Set(keywords)),
    topics: Array.from(new Set(topics)).sort((x, y) => x - y),
  };
}

function sourceText(record: RecordItem) {
  if (record.type === "free") return record.body ?? "";
  return getDb()
    .messages.filter((m) => m.record_id === record.id && m.answer)
    .map((m) => m.answer)
    .join(" ");
}

/** 분석 성공: 원문에서 후보를 만들어 확정 전 소재로 넣는다 (근거 문장은 원문의 첫 문장) */
function putCandidate(record: RecordItem) {
  const db = getDb();
  const text = sourceText(record).trim();
  const firstSentence = text.split(/(?<=[.!?。])\s+/)[0] ?? text;
  db.materials = db.materials.filter((m) => m.record_id !== record.id || m.confirmed_at || m.deleted_at);
  db.materials.push({
    id: newId(),
    record_id: record.id,
    title: record.title?.trim() || firstSentence.slice(0, 16) || "오늘의 기록",
    summary: firstSentence.slice(0, 40) || "오늘의 기록",
    evidence: firstSentence || null,
    keywords: Array.from(new Set(text.split(/\s+/).filter((w) => w.length >= 2))).slice(0, 3),
    topic_ids: [topicId("일상")],
    origin: "ai",
    confirmed_at: null,
    user_edited_at: null,
    deleted_at: null,
    created_at: now(),
    used_count: 0,
  });
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

function toMe(session: MockSession): Me {
  return { id: session.user_id, ai_consent_at: session.consented_at, last_seen_at: now(), data_cleared_at: null };
}

/* ---------- 이벤트 검사 (B: routers/events.py) ---------- */

const EVENT_FIELDS = [
  "record_id",
  "essay_id",
  "suggestion_id",
  "write_mode",
  "material_count",
  "entry_path",
  "share_method",
  "record_type",
  "placement",
] as const;
type EventFieldName = (typeof EVENT_FIELDS)[number];

/** 이름 → [필수 칸, 선택 칸] (B: RULES) */
const EVENT_RULES: Record<string, [EventFieldName[], EventFieldName[]]> = {
  record_started: [["record_type"], ["record_id"]],
  writing_started: [["write_mode", "entry_path", "material_count"], ["suggestion_id"]],
  suggestion_shown: [["suggestion_id", "placement"], []],
  suggestion_selected: [["suggestion_id"], []],
  body_shared: [["essay_id", "share_method"], []],
};

/** 값 모양 (B: EventIn의 Literal·Field 검사). 맞지 않으면 422 (FastAPI 입력 검사 오류, 코드 없음) */
const EVENT_VALUES: Partial<Record<EventFieldName, readonly string[]>> = {
  record_type: ["free", "qna"],
  placement: ["home", "suggestion_detail"],
  write_mode: ["direct", "ai"],
  entry_path: ["home", "materials", "material_detail", "suggestion", "no_material"],
  share_method: ["copy", "share_sheet"],
};

function checkEvent(body: unknown) {
  const input = (body ?? {}) as Record<string, unknown>;
  // ① 입력 모양 (FastAPI가 먼저 거절): 모르는 이름·모르는 칸·값 모양
  if (typeof input.name !== "string" || !(input.name in EVENT_RULES)) fail("bad_request");
  for (const k of Object.keys(input)) {
    if (k !== "name" && !(EVENT_FIELDS as readonly string[]).includes(k)) fail("bad_request"); // extra = forbid
  }
  for (const f of EVENT_FIELDS) {
    const v = input[f];
    if (v === undefined || v === null) continue;
    const allowed = EVENT_VALUES[f];
    if (allowed && !allowed.includes(v as string)) fail("bad_request");
    if (f === "material_count" && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100)) fail("bad_request");
    if (f.endsWith("_id") && typeof v !== "string") fail("bad_request");
  }

  // ② 이벤트별 필수·허용 칸
  const name = input.name as string;
  const [required, optional] = EVENT_RULES[name];
  const given = EVENT_FIELDS.filter((f) => input[f] !== undefined && input[f] !== null);
  const missing = required.filter((f) => !given.includes(f)).sort();
  if (missing.length) fail("bad_request", `missing_field: ${missing.join(", ")}`);
  const extra = given.filter((f) => !required.includes(f) && !optional.includes(f)).sort();
  if (extra.length) fail("bad_request", `unexpected_field: ${extra.join(", ")}`);
  if (name === "writing_started") {
    const fromSuggestion = input.entry_path === "suggestion";
    if (fromSuggestion && !given.includes("suggestion_id")) fail("bad_request", "missing_field: suggestion_id");
    if (!fromSuggestion && given.includes("suggestion_id")) fail("bad_request", "unexpected_field: suggestion_id");
  }

  // ③ 내 기록·글·제안인지 (목업 DB에 있는지)
  const db = getDb();
  const exists: Record<"record_id" | "essay_id" | "suggestion_id", (id: string) => boolean> = {
    record_id: (id) => db.records.some((r) => r.id === id),
    essay_id: (id) => db.essayIds.includes(id) || db.essays.some((e) => e.id === id),
    suggestion_id: (id) => db.suggestions.some((x) => x.id === id),
  };
  for (const f of ["record_id", "essay_id", "suggestion_id"] as const) {
    const v = input[f];
    if (typeof v === "string" && !exists[f](v)) fail("not_found", `${f.replace(/_id$/, "")}_not_found`);
  }

  // ④ 이어 쓰기 record_id의 방식이 record_type과 같은지
  if (typeof input.record_id === "string") {
    const record = db.records.find((r) => r.id === input.record_id)!;
    if (record.type !== input.record_type) fail("bad_request", "record_type_mismatch");
  }
}

/* ---------- 글쓰기 제안 · 글 (B suggestions.py · essays.py) ---------- */

/** B: Suggestion — 소재는 지금 제목·요약으로 */
function suggestionOf(sg: MockSuggestion): Suggestion {
  const db = getDb();
  return {
    id: sg.id,
    topic: topicRefs([sg.topic_id])[0],
    title: sg.title,
    direction: sg.direction,
    reason: sg.reason,
    materials: sg.material_ids
      .map((id) => db.materials.find((m) => m.id === id))
      .filter((m): m is Material => !!m)
      .map((m) => ({ id: m.id, title: m.title, summary: m.summary })),
    computed_at: sg.computed_at,
  };
}

/** B essays.py: _materials (고른 순서, 삭제된 소재는 deleted) */
function materialRefs(ids: string[]): MaterialRef[] {
  const db = getDb();
  return ids
    .map((id) => db.materials.find((m) => m.id === id))
    .filter((m): m is Material => !!m)
    .map((m) => ({ id: m.id, title: m.title, summary: m.summary, deleted: !!m.deleted_at }));
}

function draftOf(e: MockEssay): EssayDraft {
  return {
    id: e.id,
    title: e.title,
    body: e.draft_body ?? "",
    direction: e.direction,
    materials: materialRefs(e.material_ids),
    suggestion_id: e.suggestion_id,
    updated_at: e.updated_at,
  };
}

/** B essays.py: _essay */
function essayOf(e: MockEssay): Essay {
  return {
    id: e.id,
    method: e.method,
    title: e.title,
    direction: e.direction,
    created_at: e.created_at,
    updated_at: e.updated_at,
    materials: materialRefs(e.material_ids),
    versions: [...e.versions]
      .sort((a, b) => a.version_no - b.version_no)
      .map((v) => ({
        id: v.id,
        version_no: v.version_no,
        label: v.version_no === 0 ? "초안" : `v${v.version_no}`,
        kind: v.kind,
        title: v.title,
        body: v.body,
        char_count: v.body.length,
        style: null,
        length: null,
        in_length_range: null,
        regen_count: 0,
        created_at: v.created_at,
        updated_at: v.updated_at,
      })),
  };
}

/**
 * B DraftIn·FirstSaveIn 검사 + _check_refs: 입력 모양(422 코드 없음) → 소재(422 material_not_available)
 * → 제안(404 suggestion_not_found). 소재 id는 중복을 빼고 고른 순서대로
 */
function checkEssayInput(body: unknown) {
  const input = (body ?? {}) as Partial<SaveEssayInput>;
  const title = typeof input.title === "string" ? input.title.trim() : null;
  const text = typeof input.body === "string" ? input.body : "";
  const direction = typeof input.direction === "string" ? input.direction.trim() : null;
  const ids = Array.isArray(input.material_ids) ? input.material_ids : [];
  if (title !== null && title.length > ESSAY_RULES.titleMax) fail("bad_request");
  if (text.length > ESSAY_RULES.bodyMax) fail("bad_request");
  if (direction !== null && direction.length > ESSAY_RULES.directionMax) fail("bad_request");
  if (ids.length > ESSAY_RULES.materialsMax) fail("bad_request");
  const db = getDb();
  const unique = Array.from(new Set(ids));
  if (unique.some((id) => !db.materials.some((m) => m.id === id && m.confirmed_at && !m.deleted_at))) {
    fail("bad_request", "material_not_available");
  }
  if (input.suggestion_id && !db.suggestions.some((x) => x.id === input.suggestion_id)) fail("not_found", "suggestion_not_found");
  return {
    essay_id: input.essay_id ?? null,
    title: title || null,
    body: text,
    direction: direction || null,
    material_ids: unique,
    suggestion_id: input.suggestion_id ?? null,
    save_token: typeof input.save_token === "string" ? input.save_token : null,
  };
}

/** B related_materials: 같은 키워드 2점 + 같은 주제 1점, 같으면 최근 순, 최대 5개 (AI 없음) */
function relatedMaterials(selected: string[], limit = 5): RelatedMaterial[] {
  const db = getDb();
  const usable = db.materials.filter((m) => m.confirmed_at && !m.deleted_at);
  const ids = Array.from(new Set(selected));
  if (ids.length === 0) return [];
  if (ids.some((id) => !usable.some((m) => m.id === id))) fail("not_found", "material_not_found");
  const chosen = usable.filter((m) => ids.includes(m.id));
  const selTopics = new Set(chosen.flatMap((m) => m.topic_ids));
  const norm = (k: string) => k.trim().toLowerCase();
  const selKeywords = new Set(chosen.flatMap((m) => m.keywords.map(norm)));
  return usable
    .filter((m) => !ids.includes(m.id))
    .map((m) => {
      const sharedTopics = TOPICS.filter((t) => m.topic_ids.includes(t.id) && selTopics.has(t.id)).map((t) => t.name as string);
      const sharedKeywords = m.keywords.filter((k) => selKeywords.has(norm(k)));
      return { m, sharedTopics, sharedKeywords, score: 2 * sharedKeywords.length + sharedTopics.length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.created_at.localeCompare(a.m.created_at))
    .slice(0, limit)
    .map(({ m, sharedTopics, sharedKeywords }) => ({
      id: m.id,
      record_id: m.record_id,
      title: m.title,
      summary: m.summary,
      topics: topicRefs(m.topic_ids),
      created_at: m.created_at,
      essay_count: m.used_count,
      shared_topics: sharedTopics,
      shared_keywords: sharedKeywords,
    }));
}

/* ---------- 처리 함수 (키별) ---------- */

const handlers: Record<MockKey, (ctx: Ctx) => unknown> = {
  // 동의 전이면 404 not_consented (B: GET /me)
  "me.get": (): Me => {
    const session = getMockSession() ?? fail("unauthorized");
    if (!session.consented_at) fail("not_found", "not_consented");
    return toMe(session);
  },

  // 처음 동의 시각은 다시 불러도 그대로 (B: on conflict do update set last_seen_at)
  "me.consent": (): Me => {
    if (!getMockSession()) fail("unauthorized");
    setMockConsent(now());
    return toMe(getMockSession()!);
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
      suggestion: db.suggestions[0] ? suggestionOf(db.suggestions[0]) : null,
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

  // [원본만 보관] (B analysis.py keep_original). 두 번 불러도 안전
  "records.keep": ({ params }): AnalysisState => {
    const record = findSavedRecord(params.recordId);
    if (materialOf(record.id)?.confirmed_at) fail("conflict", "material_confirmed");
    if (materialDeleted(record.id)) fail("conflict", "material_deleted");
    record.original_kept_at ??= now();
    return analysisState(record);
  },

  // M132 기록 삭제 (B materials.py delete_record): 보관 확정 소재가 없는 저장된 원본만. 204
  "records.delete": ({ params }) => {
    const record = findSavedRecord(params.recordId);
    const confirmed = getDb().materials.find((m) => m.record_id === record.id && m.confirmed_at);
    if (confirmed) fail("conflict", confirmed.deleted_at ? "material_deleted" : "material_confirmed");
    removeRecords([record.id]);
    return null;
  },

  // 원문 (읽기 전용, B materials.py get_original)
  "records.original": ({ params }): Original => originalOf(findSavedRecord(params.recordId)),

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
    return qnaState(record, generateQuestion(record, scenario));
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
    return qnaState(record, generateQuestion(record, scenario));
  },

  // [다시 시도] (⑦): 답을 기다리는 질문이 없을 때만 새로 만든다. 있거나 7개면 그대로
  "qna.next": ({ params, scenario }): QnaState => {
    const record = findOpenQna(params.recordId);
    const s = summary(record.id);
    if (s.pending || s.answerCount >= QNA_RULES.maxAnswers) return qnaState(record);
    return qnaState(record, generateQuestion(record, scenario));
  },

  // [다른 질문 보기] (목록 12번): 성공 뒤에만 교체·차감. 실패면 그대로 + ai_failed
  "qna.replace": ({ params, body, scenario }): QnaState => {
    const record = findOpenQna(params.recordId);
    const { question_id } = body as { question_id: string };
    const s = summary(record.id);
    if (!s.pending || s.pending.id !== question_id) fail("conflict", "not_pending_question");
    if (s.pending!.question_source !== "followup") fail("conflict", "first_question_not_replaceable");
    if (s.replaced >= QNA_RULES.replaceLimit) fail("conflict", "replace_limit");
    return qnaState(record, generateQuestion(record, scenario, s.pending!));
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

  // [다시 분석] (B analysis.py reanalyze): 실패일 때만. 분석 중이면 그대로 (200)
  "analysis.start": ({ params }): AnalysisState => {
    const record = findSavedRecord(params.recordId);
    if (record.analysis_status === "analyzing") return analysisState(record);
    if (materialDeleted(record.id)) fail("conflict", "material_deleted");
    if (!analysisState(record).can_reanalyze) fail("conflict", "cannot_reanalyze");
    if (analysisLimitReached()) fail("bad_request", "daily_limit", 429);
    runAnalysis(record);
    return analysisState(record);
  },

  // M120 분석 상태 (B analysis.py get_analysis). 부를 때마다 조회 횟수를 센다 (목업)
  "analysis.get": ({ params, scenario }): AnalysisState => {
    const record = findSavedRecord(params.recordId);
    const running = getDb().analyses[record.id];
    if (running) running.polls += 1;
    settleAnalysis(record, scenario);
    return analysisState(record);
  },

  // [소재함에 보관] · [직접 정리하기] (B materials.py confirm_material). 이미 보관됐으면 그 소재 (200)
  "material.confirm": ({ params, body }): MaterialDetail => {
    const db = getDb();
    const record = findSavedRecord(params.recordId);
    const input = checkConfirmInput(body);
    if (materialDeleted(record.id)) fail("conflict", "material_deleted");
    const existing = materialOf(record.id);
    if (existing?.confirmed_at) return materialDetail(existing);
    const t = now();
    if (!existing) {
      // [직접 정리하기]: 후보가 없으면 직접 쓴 값으로 새 소재 (근거 문장 없음)
      const material: Material = {
        id: newId(),
        record_id: record.id,
        title: input.title,
        summary: input.summary,
        evidence: null,
        keywords: input.keywords,
        topic_ids: input.topics,
        origin: "manual",
        confirmed_at: t,
        user_edited_at: null,
        deleted_at: null,
        created_at: t,
        used_count: 0,
      };
      db.materials.push(material);
      return materialDetail(material);
    }
    // AI 후보를 (고쳐서) 보관
    const edited =
      input.title !== existing.title ||
      input.summary !== existing.summary ||
      input.keywords.join("\n") !== existing.keywords.join("\n") ||
      input.topics.join(",") !== [...existing.topic_ids].sort((x, y) => x - y).join(",");
    Object.assign(existing, {
      title: input.title,
      summary: input.summary,
      keywords: input.keywords,
      topic_ids: input.topics,
      confirmed_at: t,
      user_edited_at: edited ? t : null,
    });
    return materialDetail(existing);
  },

  // M110 (B materials.py material_box)
  "materials.list": ({ scenario }): MaterialBox => {
    if (scenario === "empty") return { pending: [], drafts: [], materials: [], kept_originals: [] };
    const db = getDb();
    const analysisScenario = scenarioFor("analysis.get");
    db.records.forEach((r) => settleAnalysis(r, analysisScenario));

    const hasCandidate = (id: string) => db.materials.some((m) => m.record_id === id && !m.confirmed_at);
    // 보관 확정한 적이 있으면 (삭제했어도) 목록에 나오지 않는다 (목록 22번)
    const noConfirmed = (id: string) => !db.materials.some((m) => m.record_id === id && m.confirmed_at);
    const saved = db.records.filter((r) => r.status === "saved" && noConfirmed(r.id));
    const bySavedDesc = (a: RecordItem, b: RecordItem) => (b.saved_at ?? "").localeCompare(a.saved_at ?? "");

    return {
      pending: saved
        .filter((r) => !r.original_kept_at && ["analyzing", "done", "empty", "failed"].includes(r.analysis_status))
        .sort(bySavedDesc)
        .map((r) =>
          recordCard(
            r,
            r.analysis_status === "analyzing" ? "analyzing" : hasCandidate(r.id) ? "to_confirm" : r.analysis_status === "empty" ? "empty" : "failed",
          ),
        ),
      drafts: db.records
        .filter((r) => r.status === "draft")
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((r) => recordCard(r, null)),
      materials: db.materials
        .filter((m) => m.confirmed_at && !m.deleted_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(
          (m): MaterialCard => ({
            id: m.id,
            record_id: m.record_id,
            title: m.title,
            summary: m.summary,
            topics: topicRefs(m.topic_ids),
            created_at: m.created_at,
            essay_count: m.used_count,
          }),
        ),
      kept_originals: saved
        .filter((r) => r.original_kept_at)
        .sort((a, b) => (b.original_kept_at ?? "").localeCompare(a.original_kept_at ?? ""))
        .map((r) => recordCard(r, r.analysis_status === "analyzing" ? "analyzing" : hasCandidate(r.id) ? "to_confirm" : null)),
    };
  },

  // M130 (B materials.py material_detail). 다시 분석 중이면 부를 때마다 조회 횟수를 센다 (목업)
  "material.get": ({ params }): MaterialDetail => {
    const material = liveMaterial(params.materialId);
    const re = getDb().reanalyses[material.id];
    if (re?.status === "analyzing") {
      re.polls += 1;
      settleReanalysis(material, re);
    }
    return materialDetail(material);
  },

  // M131 소재 정보 고치기: 요약·키워드·주제만, 보낸 칸만
  "material.edit": ({ params, body }): MaterialDetail => {
    const material = liveMaterial(params.materialId);
    const input = checkEditInput(body);
    if (input.summary !== undefined) material.summary = input.summary;
    if (input.keywords !== undefined) material.keywords = input.keywords;
    if (input.topics !== undefined) material.topic_ids = input.topics;
    if (Object.keys(input).length > 0) material.user_edited_at = now();
    return materialDetail(material);
  },

  // M131 다시 분석: 소재는 그대로, 결과는 reanalysis에. 이미 분석 중이면 그대로 (200). 이전 결과는 버림
  "material.reanalyze": ({ params, scenario }): MaterialDetail => {
    const db = getDb();
    const material = liveMaterial(params.materialId);
    if (db.reanalyses[material.id]?.status === "analyzing") return materialDetail(material);
    if (scenario === "daily_limit" || analysisLimitReached()) fail("bad_request", "daily_limit", 429);
    db.reanalyses[material.id] = { status: "analyzing", startedAt: Date.now(), polls: 0, pollsNeeded: randomPollsNeeded(), result: null };
    return materialDetail(material);
  },

  // [바꾸기]: 결과로 소재 정보를 바꾼다 (origin = ai). 결과가 없으면 409 no_result
  "material.reanalysis.apply": ({ params }): MaterialDetail => {
    const db = getDb();
    const material = liveMaterial(params.materialId);
    const re = db.reanalyses[material.id];
    if (!re || re.status !== "done" || !re.result) fail("conflict", "no_result");
    const result = re!.result!;
    Object.assign(material, {
      title: result.title,
      summary: result.summary,
      evidence: result.evidence,
      keywords: result.keywords,
      topic_ids: result.topics.map((t) => t.id),
      origin: "ai",
    });
    delete db.reanalyses[material.id]; // ERD 규칙 12: 저장하면 AI 결과를 비운다
    return materialDetail(material);
  },

  // [그대로 두기] · 소재 없음·실패 안내의 [확인]: 진행 중이 아니면 결과를 비운다
  "material.reanalysis.dismiss": ({ params }): MaterialDetail => {
    const db = getDb();
    const material = liveMaterial(params.materialId);
    if (db.reanalyses[material.id] && db.reanalyses[material.id].status !== "analyzing") delete db.reanalyses[material.id];
    return materialDetail(material);
  },

  // M131 소재 삭제: 논리 삭제 (204). 원본 기록과 쓴 글은 남는다
  "material.delete": ({ params }) => {
    const material = liveMaterial(params.materialId);
    material.deleted_at = now();
    delete getDb().reanalyses[material.id];
    return null;
  },

  // 목업 전용 (요청 없음): '다시 분석 결과 (M131)' 상황을 고르는 자리
  "material.reanalysis.result": () => null,

  // N110 함께 쓰면 좋은 소재 (B materials.py related_materials)
  "materials.related": ({ query }): RelatedMaterial[] => {
    const raw = query?.selected;
    const selected = Array.isArray(raw) ? raw.map(String) : raw !== undefined ? [String(raw)] : [];
    return relatedMaterials(selected);
  },

  // 글쓰기 제안 (B suggestions.py)
  "suggestions.list": ({ scenario }): SuggestionList => {
    if (scenario === "empty") return { computing: false, suggestions: [] };
    return { computing: false, suggestions: getDb().suggestions.map(suggestionOf) };
  },

  "suggestion.get": ({ params }): Suggestion => {
    const sg = getDb().suggestions.find((x) => x.id === params.suggestionId);
    return suggestionOf(sg ?? fail("not_found", "suggestion_not_found"));
  },

  // N140 직접 쓰기 임시 저장 1개 (B essays.py get_draft). 없으면 404 no_draft
  "essays.draft.get": ({ scenario }): EssayDraft => {
    if (scenario === "empty") fail("not_found", "no_draft");
    const e = getDb().essays.find((x) => x.status === "draft");
    return draftOf(e ?? fail("not_found", "no_draft"));
  },

  // [임시 저장] (B save_draft): 만들거나 덮어쓴다. 이어 쓰면 essay_id (이미 저장됐으면 404 draft_not_found)
  "essays.draft.save": ({ body }): EssayDraft => {
    const db = getDb();
    const input = checkEssayInput(body);
    const t = now();
    let essay: MockEssay | undefined;
    if (input.essay_id) {
      essay = db.essays.find((x) => x.id === input.essay_id && x.status === "draft") ?? fail("not_found", "draft_not_found");
    } else {
      essay = db.essays.find((x) => x.status === "draft");
      if (!essay) {
        essay = { id: newId(), method: "direct", status: "draft", title: null, draft_body: "", direction: null, suggestion_id: null, material_ids: [], versions: [], created_at: t, updated_at: t };
        db.essays.push(essay);
      }
    }
    Object.assign(essay, {
      title: input.title,
      draft_body: input.body,
      direction: input.direction,
      suggestion_id: input.suggestion_id,
      material_ids: input.material_ids,
      updated_at: t,
    });
    return draftOf(essay);
  },

  // [저장] 첫 저장 → v1 (B first_save). 같은 save_token·이미 저장된 essay_id면 그 글 (200)
  "essays.save": ({ body }): Essay => {
    const db = getDb();
    const raw = (body ?? {}) as Partial<SaveEssayInput>;
    if (typeof raw.body !== "string" || !raw.body.trim()) fail("bad_request", "empty_body");
    if (!raw.save_token) fail("bad_request");
    const done = db.essays.find((x) => x.versions.some((v) => v.save_token === raw.save_token));
    if (done) return essayOf(done);
    const input = checkEssayInput(body);
    const t = now();
    let essay: MockEssay;
    if (input.essay_id) {
      const found = db.essays.find((x) => x.id === input.essay_id);
      if (found?.status === "saved") return essayOf(found);
      if (!found) return fail("not_found", "draft_not_found");
      essay = found;
    } else {
      essay = { id: newId(), method: "direct", status: "saved", title: null, draft_body: null, direction: null, suggestion_id: null, material_ids: [], versions: [], created_at: t, updated_at: t };
      db.essays.push(essay);
    }
    Object.assign(essay, {
      status: "saved",
      title: input.title,
      draft_body: null,
      direction: input.direction,
      suggestion_id: input.suggestion_id,
      material_ids: input.material_ids,
      updated_at: t,
    });
    essay.versions.push({ id: newId(), version_no: 1, kind: "direct_first", title: input.title, body: input.body, save_token: input.save_token, created_at: t, updated_at: t });
    // 소재를 쓴 글 수 (M110·M130 '글 N편에 사용')
    for (const id of input.material_ids) {
      const m = db.materials.find((x) => x.id === id);
      if (m) m.used_count += 1;
    }
    return essayOf(essay);
  },

  "settings.clear": () => {
    clearUserData();
    return null;
  },

  // R33 이벤트 (B: routers/events.py와 같은 순서로 검사). 성공은 204 빈 응답
  "events.log": ({ body }) => {
    checkEvent(body);
    return null;
  },
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

/**
 * 인증 (B 기준: auth.current_user · db.require_consent)
 * - 세션만 있으면 되는 키 (UserConn·owner_tx): GET /me, POST /me/consent, GET /daily-questions/today
 * - 그 밖의 데이터 API는 동의도 필요 (ConsentedConn·require_consent) → 동의 전이면 403 not_consented
 * 세션이 없으면 실제 client.ts는 서버를 부르지 않고 unauthorized → 목업도 같게 (다른 상황보다 먼저)
 */
const SESSION_ONLY_KEYS: MockKey[] = ["me.get", "me.consent", "qna.daily"];

/** 분석 결과는 실패·시간 초과를 '요청 오류'가 아니라 '분석 실패 상태'로 돌려준다 */
const RESULT_LEVEL_KEYS: MockKey[] = ["analysis.get"];

export async function runMock<T>(options: RequestOptions): Promise<ApiResult<T>> {
  const { key, params = {} } = options.mock;
  const scenario = scenarioFor(key);
  const settings = getMockSettings();
  const resultLevel = RESULT_LEVEL_KEYS.includes(key);

  // 세션 없음: 서버를 부르지 않는 것과 같으므로 기다림 없이 바로
  const session = getMockSession();
  if (!session) return { ok: false, error: apiError("unauthorized", 401) };

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
    // 세션 무효 흉내: 401 → 새 토큰 받기가 거절되고 access token도 만료돼 SDK가 세션을 지운 경우
    // (우리 코드는 세션을 지우지 않는다 — 여기서 지우는 건 SDK 동작을 흉내 낸 것)
    if (scenario === "unauthorized") {
      clearMockSession();
      return { ok: false, error: apiError("unauthorized", 401) };
    }
    // 동의 전 흉내: 403 not_consented (GET /me는 B처럼 404). 세션은 남김
    if (scenario === "not_consented") {
      const status = key === "me.get" ? 404 : 403;
      return { ok: false, error: apiError(key === "me.get" ? "not_found" : "not_consented", status, "not_consented") };
    }
  } else if (scenario === "network") {
    return { ok: false, error: apiError("network") };
  }

  // 동의 전: 403 not_consented (세션은 그대로)
  if (!SESSION_ONLY_KEYS.includes(key) && !session.consented_at) {
    return { ok: false, error: apiError("not_consented", 403, "not_consented") };
  }

  try {
    const data = handlers[key]({ params, body: options.body, query: options.query, scenario });
    // 화면이 목업 DB 객체를 직접 고치지 못하게 복사해서 돌려줌
    return { ok: true, data: structuredClone(data) as T };
  } catch (e) {
    if (e instanceof MockHttpError) {
      // 서버 detail("missing_field: record_type" 등)을 실제 client.ts와 같은 방법으로 code로 바꾼다
      const code = e.code ? readErrorCode(JSON.stringify({ detail: e.code })) : undefined;
      return { ok: false, error: apiError(e.kind, e.status, code) };
    }
    throw e;
  }
}
