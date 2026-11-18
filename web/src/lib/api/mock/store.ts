import type {
  DailyQuestion,
  Material,
  QnaMessage,
  RecordItem,
  SuggestionCard,
  Topic,
  Uuid,
} from "../types";
import { TOPIC_NAMES } from "../types";

/**
 * 목업용 가짜 DB (브라우저 탭 메모리). 새로고침하면 처음 상태로 돌아간다.
 * 가짜 데이터는 여기에만 둔다 — 화면 코드에서 데이터를 만들지 않는다.
 */

export function newId(): Uuid {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `mock-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

const now = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const topics: Topic[] = TOPIC_NAMES.map((name, i) => ({ id: i + 1, name, sort_order: i + 1 }));
export const topicId = (name: (typeof TOPIC_NAMES)[number]) => topics.find((t) => t.name === name)!.id;

const DAILY_QUESTION_TEXTS = [
  "요즘 가장 자주 떠올리는 장면이 있나요? 언제, 어디였나요?",
  "최근에 누군가에게 고마웠던 순간이 있나요?",
  "이번 주에 가장 오래 머문 장소는 어디였나요?",
  "요즘 자주 먹는 음식에 얽힌 이야기가 있나요?",
  "최근에 나를 웃게 한 일은 무엇이었나요?",
  "어릴 때 살던 동네에서 기억나는 곳이 있나요?",
  "요즘 마음이 쓰이는 사람이 있나요?",
  "최근에 처음 해 본 일이 있나요?",
  "요즘 퇴근길이나 하굣길에 보이는 풍경은 어떤가요?",
  "최근에 혼자 보낸 시간 중 기억에 남는 때가 있나요?",
  "가족과 나눈 대화 중 오래 남은 말이 있나요?",
  "요즘 나를 지치게 하는 일은 무엇인가요?",
  "계절이 바뀌는 걸 느낀 순간이 있었나요?",
  "최근에 다시 연락한 사람이 있나요?",
  "요즘 빠져 있는 취미나 즐거움이 있나요?",
  "몸이 보내는 신호를 느낀 적이 있나요?",
  "최근에 결정을 내리기 어려웠던 일이 있나요?",
  "다시 가 보고 싶은 여행지가 있나요?",
  "요즘 일하면서 뿌듯했던 순간이 있나요?",
  "친구와 함께한 시간 중 떠오르는 장면이 있나요?",
  "최근에 나 자신이 조금 달라졌다고 느낀 적이 있나요?",
  "오래 간직한 물건에 얽힌 이야기가 있나요?",
  "요즘 잠들기 전에 자주 하는 생각이 있나요?",
  "최근에 서운했던 일이 있었나요?",
  "날씨 때문에 기분이 달라진 날이 있었나요?",
  "요즘 배우고 싶은 것이 있나요?",
  "최근에 들은 말 중 마음에 남은 말이 있나요?",
  "어떤 냄새를 맡고 떠오른 기억이 있나요?",
  "요즘 나에게 위로가 되는 것은 무엇인가요?",
  "오늘 하루를 한 장면으로 남긴다면 어떤 장면인가요?",
];

export const FOLLOWUP_QUESTIONS = [
  "그때 누구와 함께 있었나요?",
  "그 순간 어떤 기분이 들었나요?",
  "그 일이 있고 나서 달라진 게 있나요?",
  "그 장면에서 가장 또렷하게 기억나는 건 무엇인가요?",
  "그때 하고 싶었지만 하지 못한 말이 있나요?",
  "지금 다시 그 순간으로 돌아간다면 어떻게 하고 싶나요?",
  "그 일을 떠올리면 어떤 소리나 냄새가 함께 떠오르나요?",
  "그 사람은 그때 어떤 표정이었나요?",
  "그날 이후로 그 장소에 다시 가 본 적이 있나요?",
  "그 경험이 지금의 나에게 어떤 의미인가요?",
];

function seedRecord(partial: Partial<RecordItem> & Pick<RecordItem, "id" | "type">): RecordItem {
  return {
    title: null,
    body: null,
    status: "saved",
    analysis_status: "done",
    original_kept_at: null,
    created_at: daysAgo(3),
    saved_at: daysAgo(3),
    updated_at: daysAgo(3),
    ...partial,
  };
}

function seedMaterial(partial: Partial<Material> & Pick<Material, "id" | "record_id" | "title">): Material {
  return {
    summary: "",
    evidence: null,
    keywords: [],
    topic_ids: [],
    origin: "ai",
    confirmed_at: daysAgo(2),
    user_edited_at: null,
    deleted_at: null,
    created_at: daysAgo(2),
    used_count: 0,
    ...partial,
  };
}

/** 목업 DB의 문답 행 (qna_messages). 화면에는 QnaMessage 칸만 나간다 */
export interface MockMessage extends QnaMessage {
  record_id: Uuid;
  daily_question_id: Uuid | null;
  /** [다른 질문 보기]로 바뀐 질문. 응답 messages에서는 빠짐 */
  is_replaced: boolean;
}

/** 이어 쓰기 기준점 (records.checkpoint_*). 서버 안에만 있고 응답에는 없음 */
export interface MockCheckpoint {
  seq: number;
  pendingId: Uuid | null;
  at: string;
}

/** 오늘의 질문 (daily_questions 행) */
export interface MockDailyQuestion extends DailyQuestion {
  question_date: string;
}

export interface MockDb {
  topics: Topic[];
  dailyQuestions: MockDailyQuestion[];
  records: RecordItem[];
  messages: MockMessage[];
  /** 기록 id → 기준점 (임시 저장한 문답만) */
  checkpoints: Record<Uuid, MockCheckpoint>;
  materials: Material[];
  /** 분석 중 기록: 시작 시각 (목업에서 몇 초 뒤 결과를 냄) */
  /**
   * 분석 중 기록. 목업은 조회 횟수로 끝낸다 (polls가 pollsNeeded에 닿으면 결과).
   * startedAt: 60초 시간 초과 판단용 (서버 규칙)
   */
  analyses: Record<Uuid, { requestId: number; startedAt: number; polls: number; pollsNeeded: number }>;
  suggestion: SuggestionCard | null;
  /** 저장한 글 id (essays). 이벤트 essay_id 확인용 — 글 기능 목업은 아직 없음 */
  essayIds: Uuid[];
  nextRequestId: number;
  /** 중복 저장 막기: save_token → 저장된 기록 id (목록 17번 ⑨) */
  saveTokens: Record<string, Uuid>;
}

function createDb(): MockDb {
  const today = new Date().toISOString().slice(0, 10);

  const r1 = seedRecord({ id: "rec-sample-1", type: "free", title: "혼자 아팠던 날", body: "감기로 혼자 누워 있던 날, 엄마가 전화로 죽 끓이는 법을 알려 줬다." });
  const r2 = seedRecord({ id: "rec-sample-2", type: "free", title: "퇴근길 노을", body: "버스 창밖으로 본 노을이 유난히 붉었다. 작년에 엄마랑 같이 본 노을이 생각났다." });
  const r3 = seedRecord({ id: "rec-sample-3", type: "qna", created_at: daysAgo(5), saved_at: daysAgo(5) });
  const pendingReview = seedRecord({ id: "rec-pending-review", type: "free", title: "이사 첫날", body: "짐을 다 풀지도 못한 채 바닥에 앉아 컵라면을 먹었다.", created_at: daysAgo(1), saved_at: daysAgo(1) });
  const pendingEmpty = seedRecord({ id: "rec-pending-empty", type: "qna", analysis_status: "empty", created_at: daysAgo(1), saved_at: daysAgo(1) });
  const pendingFailed = seedRecord({ id: "rec-pending-failed", type: "free", title: "회의 끝나고", body: "회의가 끝나고 한참 창밖만 봤다.", analysis_status: "failed" });
  const rawOnly = seedRecord({ id: "rec-raw-only", type: "free", title: "아무 일 없던 일요일", body: "하루 종일 집에 있었다.", analysis_status: "empty", original_kept_at: daysAgo(4) });
  const draftFree = seedRecord({ id: "rec-draft-free", type: "free", title: null, body: "오늘 아침에", status: "draft", analysis_status: "none", saved_at: null, updated_at: daysAgo(0) });
  // AI 문답 임시 저장 (H121 확인용): 답변 2개 + 답을 기다리는 질문 1개에서 임시 저장
  const draftQnaAt = minutesAgo(10);
  const draftQna = seedRecord({
    id: "rec-draft-qna",
    type: "qna",
    status: "draft",
    analysis_status: "none",
    created_at: minutesAgo(20),
    saved_at: null,
    updated_at: draftQnaAt,
  });

  return {
    topics,
    dailyQuestions: DAILY_QUESTION_TEXTS.map((question, i) => ({
      id: `dq-${today}-${i + 1}`,
      question_date: today,
      seq: i + 1,
      question,
    })),
    records: [r1, r2, r3, pendingReview, pendingEmpty, pendingFailed, rawOnly, draftFree, draftQna],
    messages: [
      { id: "msg-sample-1", record_id: r3.id, seq: 1, question: DAILY_QUESTION_TEXTS[0], question_source: "daily", daily_question_id: null, answer: "이사 첫날 밤 엄마와 통화한 장면이요.", is_replaced: false },
      { id: "msg-sample-2", record_id: r3.id, seq: 2, question: "그때 어떤 이야기를 나눴나요?", question_source: "followup", daily_question_id: null, answer: "밥은 먹었냐고, 문단속 잘하라고 하셨어요.", is_replaced: false },
      { id: "msg-draft-1", record_id: draftQna.id, seq: 1, question: DAILY_QUESTION_TEXTS[2], question_source: "daily", daily_question_id: `dq-${today}-3`, answer: "동네 도서관 창가 자리요.", is_replaced: false },
      { id: "msg-draft-2", record_id: draftQna.id, seq: 2, question: FOLLOWUP_QUESTIONS[0], question_source: "followup", daily_question_id: null, answer: "혼자 갔어요. 조용한 게 좋아서요.", is_replaced: false },
      { id: "msg-draft-3", record_id: draftQna.id, seq: 3, question: FOLLOWUP_QUESTIONS[1], question_source: "followup", daily_question_id: null, answer: null, is_replaced: false },
    ],
    materials: [
      seedMaterial({ id: "mat-sample-1", record_id: r1.id, title: "혼자 아팠던 날", summary: "아플 때 전화로 들은 엄마의 레시피", evidence: "엄마가 전화로 죽 끓이는 법을 알려 줬다.", keywords: ["감기", "엄마", "죽"], topic_ids: [topicId("가족"), topicId("몸·건강")], used_count: 1, created_at: daysAgo(1) }),
      seedMaterial({ id: "mat-sample-2", record_id: r2.id, title: "퇴근길 노을", summary: "노을을 보며 떠올린 엄마와의 기억", evidence: "작년에 엄마랑 같이 본 노을이 생각났다.", keywords: ["노을", "퇴근길"], topic_ids: [topicId("일상"), topicId("가족")], created_at: daysAgo(2) }),
      // 확인 대기 후보 = 확정 전 소재 (B: materials.confirmed_at = null)
      seedMaterial({ id: "mat-candidate-1", record_id: pendingReview.id, title: "이사 첫날", summary: "짐 사이에서 먹은 첫 끼", evidence: "바닥에 앉아 컵라면을 먹었다.", keywords: ["이사", "컵라면"], topic_ids: [topicId("일상")], confirmed_at: null, created_at: daysAgo(1) }),
      seedMaterial({ id: "mat-sample-3", record_id: r3.id, title: "이사 첫날 밤의 통화", summary: "독립한 첫날 밤 엄마의 걱정", evidence: "밥은 먹었냐고, 문단속 잘하라고 하셨어요.", keywords: ["이사", "통화"], topic_ids: [topicId("가족")], created_at: daysAgo(4) }),
    ],
    checkpoints: { [draftQna.id]: { seq: 3, pendingId: "msg-draft-3", at: draftQnaAt } },
    analyses: {},
    suggestion: {
      id: "sug-sample-1",
      topic_id: topicId("가족"),
      status: "ready",
      title: "독립한 뒤 달라진 가족의 의미",
      direction: "혼자 살면서 가족을 떠올린 순간들을 시간 순서로 엮기",
      reason: "혼자 살면서 가족을 떠올린 기록들을 함께 엮어볼 수 있어요.",
      materials: [
        { id: "mat-sample-3", title: "이사 첫날 밤의 통화" },
        { id: "mat-sample-1", title: "혼자 아팠던 날" },
        { id: "mat-sample-2", title: "퇴근길 노을" },
      ],
    },
    essayIds: ["essay-sample-1"],
    nextRequestId: 1,
    saveTokens: {},
  };
}

let db: MockDb | null = null;

export function getDb(): MockDb {
  if (!db) db = createDb();
  return db;
}

/** 목업 DB를 처음 상태로 (/dev/mock) */
export function resetDb() {
  db = createDb();
}

/**
 * 모든 기록 지우기 목업: 기록(진행 중 active·임시 저장 draft·저장 saved 모두)·소재·제안은 비우고
 * 주제·오늘의 질문은 남김 (ERD 규칙 14)
 */
export function clearUserData() {
  const d = getDb();
  d.records = [];
  d.saveTokens = {};
  d.checkpoints = {};
  d.messages = [];
  d.materials = [];
  d.analyses = {};
  d.suggestion = null;
  d.essayIds = [];
}

export { now };
