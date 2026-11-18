/**
 * 서버와 주고받는 데이터 모양.
 * 기준: ERD v7 + docs/v6_이후_수정대기목록.md (목록이 우선). 칸 이름은 FastAPI·DB와 같은 snake_case.
 * - 목록 13·15번 (합의): events.share_method = copy / share_sheet. 취소·실패는 기록 안 함(share_result 칸 없음)
 * - 목록 17번 (합의): records.status에 active(진행 중) 추가. 기록·문답·오늘의 질문 모양은 B 서버 코드
 *   (feat/backend-setup server/app/routers/records.py·qna.py) 기준. 기준점(checkpoint_*)은 서버 안에만 있고 응답에 없음
 * - 목록 7번 (전달됨, 답 대기): materials.updated_at → 합의되면 Material에 추가
 * - 목록 16번 (전달됨, 답 대기): 서버 구조. 아래 '응답 묶음' 모양(HomeSummary 등)은 A의 임시안
 */

export type Uuid = string;
/** ISO 8601 시각 문자열 (timestamptz) */
export type IsoTime = string;

/* ---------- 사용자 ---------- */

/** GET /me · POST /me/consent (B: Me) */
export interface Me {
  id: Uuid;
  ai_consent_at: IsoTime | null;
  last_seen_at: IsoTime;
  data_cleared_at: IsoTime | null;
}

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
}

/** 오늘의 공통 첫 질문 하나 (B: DailyQuestion) */
export interface DailyQuestion {
  id: Uuid;
  /** 1~30 */
  seq: number;
  question: string;
}

/** GET /daily-questions/today (B: DailyQuestions). date = 오늘(KST) YYYY-MM-DD */
export interface DailyQuestions {
  date: string;
  questions: DailyQuestion[];
}

/** 문답 한 줄 (B: Message). 바꾼 질문은 서버가 빼고 준다 */
export interface QnaMessage {
  id: Uuid;
  seq: number;
  question: string;
  question_source: "daily" | "followup";
  answer: string | null;
}

/**
 * AI 문답 상태 (B: QnaState). 문답 API는 모두 이 모양 하나로 돌려준다.
 * GET /qna/active·/qna/draft(없으면 null), POST /qna·/answers·/next·/replace·/draft·/discard-changes
 */
export interface QnaState {
  record_id: Uuid;
  /** 열린 대화만: active(진행 중) / draft(임시 저장) */
  status: Extract<RecordStatus, "active" | "draft">;
  updated_at: IsoTime;
  /** seq 순. 바꾼 질문은 빠짐 */
  messages: QnaMessage[];
  /** 답을 기다리는 질문. 없으면 null (AI 실패 또는 답변 7개를 다 채움) */
  pending_question: QnaMessage | null;
  /** 답변 수 (진행 3/7) */
  answer_count: number;
  /** [다른 질문 보기] 남은 횟수 */
  replace_left: number;
  /** 답변 7개 → 질문 마무리 W212 */
  finished: boolean;
  /** [소재로 저장] 가능 (답변 2개부터) */
  can_save: boolean;
  /** 다음(또는 바꿀) 질문을 만들지 못함 → [다시 시도] POST /qna/{id}/next. 답변은 저장돼 있음 */
  ai_failed: boolean;
}

/** AI 문답 규칙 (ERD 데이터 규칙 10) */
export const QNA_RULES = {
  maxAnswers: 7,
  minAnswersToSave: 2,
  replaceLimit: 6,
  dailyQuestionCount: 30,
} as const;

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
/*
 * 화면이 보내는 이벤트 5개 (B server/app/routers/events.py, 목록 23~27번 합의).
 * record_saved·material_confirmed·essay_saved는 서버가 직접 기록한다 → 화면이 보내면 422.
 * 기록·글 본문은 넣지 않는다. 이벤트별로 정해진 칸 말고는 타입으로 막는다 (서버도 422).
 */

export type WriteMode = "direct" | "ai";
export type EntryPath = "home" | "materials" | "material_detail" | "suggestion" | "no_material";
export type SuggestionPlacement = "home" | "suggestion_detail";
/** 목록 13·15번 (합의): ERD v7의 share_target 대신 share_method */
export type ShareMethod = "copy" | "share_sheet";

/** 이벤트가 가질 수 있는 칸 전부 (B: FIELDS) */
export type EventField =
  | "record_id"
  | "essay_id"
  | "suggestion_id"
  | "write_mode"
  | "material_count"
  | "entry_path"
  | "share_method"
  | "record_type"
  | "placement";

/** P에 없는 칸은 넣을 수 없게 (never). 유니언이면 경우마다 따로 적용 */
type OnlyFields<P> = P extends unknown ? P & { [K in Exclude<EventField, keyof P>]?: never } : never;

/** writing_started: entry_path = suggestion이면 suggestion_id 필수, 다른 경로면 넣을 수 없음 */
type WritingStartedProps =
  | {
      write_mode: WriteMode;
      entry_path: "suggestion";
      /** 고른 소재 수. 0~100 정수 (서버 검사, 화면 선택 개수 규칙과 별개) */
      material_count: number;
      suggestion_id: Uuid;
    }
  | {
      write_mode: WriteMode;
      entry_path: Exclude<EntryPath, "suggestion">;
      /** 고른 소재 수. 0~100 정수 (서버 검사, 화면 선택 개수 규칙과 별개) */
      material_count: number;
      suggestion_id?: never;
    };

/** 이벤트 이름 → 칸 (B: RULES) */
export interface EventPropsMap {
  /** 자유 기록·AI 질문 화면에 들어올 때마다 (이어 쓰기·새로고침·재진입 포함, 재렌더링 제외). 이어 쓰기면 record_id */
  record_started: { record_type: RecordType; record_id?: Uuid };
  /** 직접: 편집기 진입 / AI: [초안 만들기] 첫 클릭 (생성 실패 뒤 재시도 제외) */
  writing_started: WritingStartedProps;
  /** 제안 카드가 실제로 화면에 보였을 때, 화면당 제안별 1번 (스크롤 재노출 제외) */
  suggestion_shown: { suggestion_id: Uuid; placement: SuggestionPlacement };
  /** [이 주제로 글쓰기] 클릭 (빠른 연속 클릭은 1번) */
  suggestion_selected: { suggestion_id: Uuid };
  /** [복사] 성공 / 공유창이 오류 없이 끝남. 취소(AbortError)·실패는 보내지 않음 */
  body_shared: { essay_id: Uuid; share_method: ShareMethod };
}

export type EventName = keyof EventPropsMap;

export type EventProps<N extends EventName = EventName> = OnlyFields<EventPropsMap[N]>;
