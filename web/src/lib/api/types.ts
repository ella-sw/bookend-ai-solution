/**
 * 서버와 주고받는 데이터 모양.
 * 기준: ERD v7 + docs/v6_이후_수정대기목록.md (목록이 우선). 칸 이름은 FastAPI·DB와 같은 snake_case.
 * - 목록 13·15번 (합의): events.share_method = copy / share_sheet. 취소·실패는 기록 안 함(share_result 칸 없음)
 * - 목록 17번 (합의): records.status에 active(진행 중) 추가, 이어 쓰기 기준점(checkpoint_*), 중복 저장 막기(save_token)
 * - 목록 7번 (전달됨, 답 대기): materials.updated_at → 합의되면 Material에 추가
 * - 목록 16번 (전달됨, 답 대기): 서버 구조. 아래 '응답 묶음' 모양(HomeSummary 등)은 A의 임시안
 */

export type Uuid = string;
/** ISO 8601 시각 문자열 (timestamptz) */
export type IsoTime = string;

/* ---------- 주제 ---------- */

/** 정해진 주제 10개 (ERD v7 topics) */
export const TOPIC_NAMES = [
  "가족",
  "관계",
  "나·성장",
  "일·직업",
  "일상",
  "여행·장소",
  "음식",
  "취향·취미",
  "몸·건강",
  "자연·계절",
] as const;
export type TopicName = (typeof TOPIC_NAMES)[number];

export interface Topic {
  id: number;
  name: TopicName;
  sort_order: number;
}

/* ---------- 원본 기록 · AI 문답 ---------- */

export type RecordType = "free" | "qna";
/**
 * active: AI 문답 진행 중 (첫 답변 때 만들어짐, 임시 저장 전) / draft: 임시 저장 / saved: 저장 (목록 17번)
 * 자유 기록은 active를 쓰지 않는다.
 */
export type RecordStatus = "active" | "draft" | "saved";
export type AnalysisStatus = "none" | "analyzing" | "done" | "empty" | "failed";

export interface RecordItem {
  id: Uuid;
  type: RecordType;
  title: string | null;
  /** qna는 비움 (문답은 QnaMessage) */
  body: string | null;
  status: RecordStatus;
  analysis_status: AnalysisStatus;
  original_kept_at: IsoTime | null;
  created_at: IsoTime;
  saved_at: IsoTime | null;
  /** 마지막 활동. 문답이 추가되거나 바뀌면 갱신 → 1시간 이어 쓰기 기준 (목록 17번 ⑥) */
  updated_at: IsoTime;
  /**
   * 이어 쓰기 기준점 (AI 문답 임시 저장 때 기록, 목록 17번 ⑤).
   * 되돌리기 = seq > checkpoint_seq 삭제 + checkpoint_pending_id 질문의 answer = null, is_replaced = false
   */
  checkpoint_seq: number | null;
  /** 임시 저장 때 답을 기다리던 질문 id (없었으면 null) */
  checkpoint_pending_id: Uuid | null;
  checkpoint_at: IsoTime | null;
}

export interface DailyQuestion {
  id: Uuid;
  question_date: string;
  /** 1~30 */
  seq: number;
  question: string;
}

export interface QnaMessage {
  id: Uuid;
  record_id: Uuid;
  seq: number;
  question: string;
  question_source: "daily" | "followup";
  daily_question_id: Uuid | null;
  answer: string | null;
  /** [다른 질문 보기]로 바뀐 질문 (답 없음) */
  is_replaced: boolean;
}

/**
 * 진행 중 문답(GET /qna/active) · 임시 저장 문답(GET /qna/draft) 불러오기
 */
export interface QnaSession {
  record: RecordItem;
  /** 바꾼 질문(is_replaced)도 포함, seq 순 */
  messages: QnaMessage[];
  /** 답을 기다리는 질문. 없으면 null (AI 실패로 다음 질문을 못 받았거나, 답변 7개를 다 채움) */
  pending: QnaMessage | null;
  /** [다른 질문 보기] 남은 횟수 */
  remaining_replaces: number;
}

/** AI 문답 규칙 (ERD 데이터 규칙 10) */
export const QNA_RULES = {
  maxAnswers: 7,
  minAnswersToSave: 2,
  replaceLimit: 6,
  dailyQuestionCount: 30,
} as const;

export interface QnaAnswerResult {
  /** 저장된 답변 (AI가 실패해도 답변은 저장됨) */
  answered: QnaMessage;
  /** 다음 후속 질문. 답변 7개가 찼거나(finished) AI가 실패하면(next_failed) null */
  next: QnaMessage | null;
  /** 다음 질문 만들기 실패 → POST /qna/{id}/next 로 다시 받는다 (목록 17번 ⑦) */
  next_failed: boolean;
  /** 답변 7개가 참 (질문 마무리 W212) */
  finished: boolean;
}

/** 첫 답변 결과: 이때 문답 기록(status = active)이 처음 만들어진다 (목록 17번 ②) */
export interface QnaFirstAnswerResult extends QnaAnswerResult {
  record: RecordItem;
  /** [다른 질문 보기] 남은 횟수 (처음 6) */
  remaining_replaces: number;
}

/** [다른 질문 보기] 결과 — 목록 12번 (제안, C 합의 전 → 목업만) */
export interface QnaReplaceResult {
  message: QnaMessage;
  remaining: number;
}

/** 다음 질문 다시 받기 결과 (POST /qna/{id}/next) */
export interface QnaNextResult {
  message: QnaMessage;
}

/* ---------- 소재 ---------- */

export interface MaterialCandidate {
  title: string;
  summary: string;
  evidence: string | null;
  keywords: string[];
  topic_ids: number[];
}

export interface Material extends MaterialCandidate {
  id: Uuid;
  record_id: Uuid;
  origin: "ai" | "manual";
  confirmed_at: IsoTime | null;
  user_edited_at: IsoTime | null;
  deleted_at: IsoTime | null;
  created_at: IsoTime;
  /** 이 소재를 쓴 글 수 (essay_materials에서 셈) */
  used_count: number;
}

export interface AnalysisResult {
  record_id: Uuid;
  request_id: number | null;
  /** 분석 요청 시작 시각 (분석 중일 때). 화면은 이 시각 + 60초를 기준으로 기다린다 */
  started_at: IsoTime | null;
  status: AnalysisStatus;
  /** status = done일 때 소재 후보 */
  candidate: MaterialCandidate | null;
  /** status = failed일 때: 오류 / 시간 초과(60초, ERD 규칙 3) */
  failure_reason: "error" | "timeout" | null;
}

/** 소재 확인(M120)에서 고친 뒤 [소재함에 보관] */
export type MaterialConfirmInput = Pick<MaterialCandidate, "title" | "summary" | "keywords" | "topic_ids">;

/**
 * [직접 정리하기] 입력 — 목록 10번 (제안, C 합의 전 → 목업만)
 * 제목 필수, 주제 1개 이상 필수, 요약·키워드 선택, 근거 문장 없음 (origin = manual)
 */
export interface MaterialManualInput {
  title: string;
  topic_ids: number[];
  summary?: string;
  keywords?: string[];
}

/** 소재함 카드 상태 (components/ui/MaterialCard와 같은 이름) */
export type PendingCardStatus = "review" | "analyzing" | "empty" | "failed";

/** 소재함(M110) 한 번에 받기 */
export interface MaterialsOverview {
  /** 확인 대기 (ERD 규칙 4) */
  pending: { record: RecordItem; card_status: PendingCardStatus }[];
  /** 임시 저장 기록 (방식별 1개). 진행 중(active)은 넣지 않음 */
  drafts: RecordItem[];
  /** 보관 확정 소재 */
  kept: Material[];
  /** 원본만 보관한 기록 (ERD 규칙 5). 다시 분석 중이면 card_status가 붙음 */
  raw_only: { record: RecordItem; card_status: PendingCardStatus | null }[];
}

export interface MaterialDetail {
  material: Material;
  record: RecordItem;
  messages: QnaMessage[];
  essays: { id: Uuid; title: string }[];
}

/* ---------- 글쓰기 제안 ---------- */

export type SuggestionStatus = "computing" | "ready" | "none" | "failed";

export interface SuggestionCard {
  id: Uuid;
  topic_id: number;
  status: SuggestionStatus;
  title: string;
  direction: string;
  reason: string;
  materials: { id: Uuid; title: string }[];
}

/** 홈(H110) 한 번에 받기 */
export interface HomeSummary {
  /** 최근 보관 확정 소재 3개 */
  recent_materials: Material[];
  /** 보일 제안 카드. 없거나 실패면 null (카드 숨김) */
  suggestion: SuggestionCard | null;
  /** 분석 중이면 '소재를 정리하고 있어요' */
  is_organizing: boolean;
}

/* ---------- 이벤트 ---------- */

export type EventName =
  | "record_started"
  | "record_saved"
  | "material_confirmed"
  | "writing_started"
  | "suggestion_shown"
  | "suggestion_selected"
  | "essay_saved"
  | "body_shared";

interface EventPropsBase {
  record_id?: Uuid;
  essay_id?: Uuid;
  suggestion_id?: Uuid;
  write_mode?: "direct" | "ai";
  material_count?: number;
  entry_path?: "home" | "materials" | "material_detail" | "suggestion" | "no_material";
}

export type ShareMethod = "copy" | "share_sheet";

/**
 * 이벤트별 값. body_shared는 share_method가 꼭 있어야 하고, 다른 이벤트에는 넣을 수 없다 (타입 검사로 막음).
 * 목록 13·15번 (합의): ERD v7의 share_target 대신 share_method
 */
export type EventProps<N extends EventName = EventName> = N extends "body_shared"
  ? EventPropsBase & { share_method: ShareMethod }
  : EventPropsBase & { share_method?: never };
