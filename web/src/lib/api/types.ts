/**
 * 서버와 주고받는 데이터 모양.
 * 기준: ERD v7 + docs/v6_이후_수정대기목록.md (목록이 우선). 칸 이름은 FastAPI·DB와 같은 snake_case.
 * - 목록 13·15번 (합의): events.share_method = copy / share_sheet. 취소·실패는 기록 안 함(share_result 칸 없음)
 * - 목록 17번 (합의): records.status에 active(진행 중) 추가. 기록·문답·오늘의 질문 모양은 B 서버 코드
 *   (feat/backend-setup server/app/routers/records.py·qna.py) 기준. 기준점(checkpoint_*)은 서버 안에만 있고 응답에 없음
 * - 목록 7번 (전달됨, 답 대기): materials.updated_at → 합의되면 MaterialDetail에 추가
 * - 응답 모양은 B 서버 코드(feat/backend-setup server/app/routers/*.py) 기준
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

/**
 * 정해진 주제 10개. id는 B DB에 고정 (server/supabase/migrations/…_tables.sql), 순서도 그대로.
 * B에는 주제 목록 API가 없으므로 화면은 이 값을 쓴다.
 */
export const TOPICS = [
  { id: 1, name: "가족" },
  { id: 2, name: "관계" },
  { id: 3, name: "나·성장" },
  { id: 4, name: "일·직업" },
  { id: 5, name: "일상" },
  { id: 6, name: "여행·장소" },
  { id: 7, name: "음식" },
  { id: 8, name: "취향·취미" },
  { id: 9, name: "몸·건강" },
  { id: 10, name: "자연·계절" },
] as const;
export type TopicName = (typeof TOPICS)[number]["name"];
export const TOPIC_NAMES: readonly TopicName[] = TOPICS.map((t) => t.name);

/** 응답 안의 주제 (B: Topic) */
export interface TopicRef {
  id: number;
  name: string;
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
  /**
   * 오늘 AI 호출을 다 써서 새 질문을 만들지 않음 (B R32, 837618c). 답변은 저장돼 있고 ai_failed는 false.
   * 그 요청의 응답에서만 true — 다시 불러오면 false로 온다
   */
  daily_limit_reached: boolean;
}

/** AI 문답 규칙 (ERD 데이터 규칙 10) */
export const QNA_RULES = {
  maxAnswers: 7,
  minAnswersToSave: 2,
  replaceLimit: 6,
  dailyQuestionCount: 30,
} as const;

/* ---------- 소재 확인 (M120) · 보관한 원본 (M130) — B routers/analysis.py·materials.py ---------- */

/** 분석이 찾은 소재 후보 또는 보관한 소재 (B analysis.py: Material) */
export interface AnalysisMaterial {
  id: Uuid;
  title: string | null;
  summary: string | null;
  /** 근거 문장: 원문에 실제로 있는 문장 (직접 정리하면 null) */
  evidence: string | null;
  keywords: string[];
  topics: TopicRef[];
  origin: "ai" | "manual";
  /** null = 후보 (보관 전) */
  confirmed_at: IsoTime | null;
}

/** GET·POST /records/{id}/analysis, POST /records/{id}/keep-original (B: AnalysisState) */
export interface AnalysisState {
  record_id: Uuid;
  /** free → [새로 기록하기], qna → [새 대화 시작하기] */
  record_type: RecordType;
  analysis_status: AnalysisStatus;
  original_kept_at: IsoTime | null;
  /** [다시 분석]을 보여 줄지 (failed·none일 때) */
  can_reanalyze: boolean;
  /** 오늘 AI 호출을 다 씀 (R32) → '오늘 사용할 수 있는 횟수를 다 썼어요' */
  daily_limit_reached: boolean;
  material: AnalysisMaterial | null;
}

/** 원문 (읽기 전용, B: Original). 문답은 답한 질문만 */
export interface Original {
  record_id: Uuid;
  record_type: RecordType;
  title: string | null;
  /** 자유 기록 본문 */
  body: string | null;
  messages: { seq: number; question: string; answer: string }[];
  saved_at: IsoTime | null;
}

/** 소재를 쓴 글 (B: EssayRef) */
export interface EssayRef {
  id: Uuid;
  title: string | null;
}

/** 다시 분석 결과 후보 (B: Candidate) */
export interface Candidate {
  title: string | null;
  summary: string;
  evidence: string;
  keywords: string[];
  topics: TopicRef[];
}

/** M131 다시 분석 진행·결과 (B: Reanalysis) */
export interface Reanalysis {
  status: "analyzing" | "done" | "empty" | "failed";
  /** done일 때 지금 소재 옆에 보여 줄 결과 */
  result: Candidate | null;
}

/** 보관한 소재 상세 (B: MaterialDetail). POST /records/{id}/material, GET /materials/{id} */
export interface MaterialDetail {
  id: Uuid;
  title: string | null;
  summary: string | null;
  evidence: string | null;
  keywords: string[];
  topics: TopicRef[];
  origin: "ai" | "manual";
  confirmed_at: IsoTime;
  user_edited_at: IsoTime | null;
  created_at: IsoTime;
  original: Original;
  essays: EssayRef[];
  reanalysis: Reanalysis | null;
}

/** B ConfirmIn 제한 */
export const MATERIAL_RULES = {
  titleMax: 50,
  summaryMax: 200,
  keywordsMax: 10,
  keywordMax: 30,
  topicsMax: 10,
} as const;

/**
 * [소재함에 보관] · [직접 정리하기] 입력 (B: ConfirmIn). 서버가 앞뒤 공백을 지운다
 * - title: 선택, 50자 이하 (비우면 null)
 * - summary: 필수, 1~200자
 * - keywords: 10개 이하, 각 1~30자 (같은 것은 서버가 하나로)
 * - topics: 주제 id 1~10개 (1개 이상)
 */
export interface ConfirmMaterialInput {
  title?: string | null;
  summary: string;
  keywords: string[];
  topics: number[];
}

/* ---------- 소재함 (M110) — B materials.py material_box ---------- */

/**
 * 기록 카드의 표시 (B: RecordCard.label)
 * - 확인 대기: analyzing '분석 중' / to_confirm '확인해 주세요' / empty '소재 없음' / failed '분석 실패'
 * - 원본만 보관: analyzing / to_confirm / null('원본만 보관')
 * - 임시 저장: 항상 null
 */
export type RecordCardLabel = "analyzing" | "to_confirm" | "empty" | "failed" | null;

/** 소재함의 기록 카드 (확인 대기 · 임시 저장 · 원본만 보관, B: RecordCard) */
export interface RecordCard {
  record_id: Uuid;
  record_type: RecordType;
  title: string | null;
  /** 본문(또는 답변) 앞 80자 */
  preview: string;
  status: "draft" | "saved";
  analysis_status: AnalysisStatus;
  label: RecordCardLabel;
  /** 저장한 날(saved_at), 임시 저장은 마지막 수정(updated_at) */
  date: IsoTime;
}

/** 보관한 소재 카드 (B: MaterialCard) */
export interface MaterialCard {
  id: Uuid;
  record_id: Uuid;
  title: string | null;
  summary: string | null;
  topics: TopicRef[];
  created_at: IsoTime;
  /** '글 N편에 사용' */
  essay_count: number;
}

/** GET /materials (B: MaterialBox). 주제 칩으로 거르기는 화면이 topics로 한다 */
export interface MaterialBox {
  /** 확인 대기 (맨 위) */
  pending: RecordCard[];
  /** 임시 저장 기록 (맨 위) */
  drafts: RecordCard[];
  /** 보관한 소재 (최근 순) */
  materials: MaterialCard[];
  /** 원본만 보관한 기록 (맨 아래 접힌 구역) */
  kept_originals: RecordCard[];
}

/**
 * M131 소재 정보 고치기 (B: EditIn). 바뀐 칸만 보낸다. 제목은 고칠 수 없다.
 * 규칙은 ConfirmMaterialInput과 같다 (요약 1~200자, 키워드 10개·각 30자, 주제 1~10개)
 */
export interface EditMaterialInput {
  summary?: string;
  keywords?: string[];
  topics?: number[];
}

/* ---------- 함께 쓰면 좋은 소재 (N110) — B materials.py related_materials ---------- */

/** 고른 소재와 주제·키워드가 같은 소재 (B: RelatedMaterial). AI 없이 점수로 정렬, 최대 5개 */
export interface RelatedMaterial extends MaterialCard {
  /** 고른 소재와 같은 주제 이름 ('같은 주제: 가족') */
  shared_topics: string[];
  /** 고른 소재와 같은 키워드 */
  shared_keywords: string[];
}

/* ---------- 글쓰기 제안 (H110 · N130) — B suggestions.py ---------- */

/** 제안에 쓸 소재 (순서대로) */
export interface SuggestionMaterial {
  id: Uuid;
  title: string | null;
  summary: string | null;
}

/** 글쓰기 제안 (B: Suggestion). 준비된(ready) 제안만 온다 */
export interface Suggestion {
  id: Uuid;
  topic: TopicRef;
  title: string;
  /** 소재를 엮는 방식 한 문장 (목록 20번). N120·N140에서 읽기 전용으로 보여 주고 글에 넘긴다 */
  direction: string;
  reason: string;
  materials: SuggestionMaterial[];
  computed_at: IsoTime;
}

/** GET /suggestions (B: SuggestionList) */
export interface SuggestionList {
  /** 하나라도 계산 중 → 홈 '소재를 정리하고 있어요' */
  computing: boolean;
  /** 최근에 만든 순 */
  suggestions: Suggestion[];
}

/* ---------- 글 (N140 · L110 · L120) — B essays.py ---------- */

/** AI 초안 문체 (W310) */
export type Style = "감성적" | "담백함";
/** AI 초안 길이 (W320): 단문 / 장문 */
export type EssayLength = "short" | "long";

/** 길이 범위 (본문만, 공백 포함, 제목 제외). 벗어나면 서버가 1회 다시 쓰고, 그래도 벗어나면 in_length_range = false */
export const LENGTH_RANGE: Record<EssayLength, readonly [number, number]> = {
  short: [300, 500],
  long: [1000, 1500],
};

/** B essays.py 제한 */
export const ESSAY_RULES = {
  titleMax: 100,
  bodyMax: 20_000,
  directionMax: 200,
  materialsMax: 20,
} as const;

/** 글에 쓴 소재 (B: MaterialRef). 삭제된 소재는 deleted = true (누를 수 없음) */
export interface MaterialRef {
  id: Uuid;
  title: string | null;
  summary: string | null;
  deleted: boolean;
}

/** 직접 쓰기 임시 저장 1개 (B: Draft) */
export interface EssayDraft {
  id: Uuid;
  title: string | null;
  body: string;
  direction: string | null;
  materials: MaterialRef[];
  suggestion_id: Uuid | null;
  updated_at: IsoTime;
}

/** 글의 버전 (B: Version). 초안 = 0, 그다음 v1 … */
export interface Version {
  id: Uuid;
  version_no: number;
  /** 초안 / v1 / v2 … */
  label: string;
  kind: "direct_first" | "direct_new" | "ai_first" | "ai_regen";
  title: string | null;
  body: string;
  /** 본문만, 공백 포함, 제목 제외 */
  char_count: number;
  /** 감성적 / 담백함 (AI일 때) */
  style: Style | null;
  length: EssayLength | null;
  /** 고른 길이 범위 밖이면 false → 실제 글자 수를 보여 줌. 직접 쓴 글은 null */
  in_length_range: boolean | null;
  /** 몇 번째로 다시 만든 글인지 (0 = 다시 만들기 아님) */
  regen_count: number;
  created_at: IsoTime;
  updated_at: IsoTime;
}

/** 글 상세 (B: Essay). versions: 초안 → v1 → … (마지막이 가장 최근) */
export interface Essay {
  id: Uuid;
  method: "direct" | "ai";
  title: string | null;
  direction: string | null;
  created_at: IsoTime;
  updated_at: IsoTime;
  materials: MaterialRef[];
  versions: Version[];
}

/** 내 서재 카드 (B: EssayCard) */
export interface EssayCard {
  id: Uuid;
  title: string | null;
  method: "direct" | "ai";
  /** 임시 저장 / 초안 / v2 … */
  state: string;
  is_draft: boolean;
  updated_at: IsoTime;
  material_count: number;
}

/** [임시 저장] (B: DraftIn). 소재는 고른 순서대로 */
export interface SaveEssayDraftInput {
  /** 이어 쓰는 임시 저장 id */
  essay_id?: Uuid | null;
  title?: string | null;
  body: string;
  direction?: string | null;
  material_ids: Uuid[];
  suggestion_id?: Uuid | null;
}

/** [저장] 첫 저장 → v1 (B: FirstSaveIn). save_token은 N140을 열 때 한 번 만들고 [다시 시도]에도 같은 값 */
export interface SaveEssayInput extends SaveEssayDraftInput {
  save_token: string;
}

/* ---------- AI 초안 (W310~W341) — B ai_essays.py ---------- */

/** [초안 만들기] (B: FirstDraftIn). save_token은 처음 누를 때 하나, [다시 시도]에도 같은 값 */
export interface CreateAiDraftInput {
  /** 고른 소재 (1개 이상), 고른 순서대로 */
  material_ids: Uuid[];
  direction?: string | null;
  style: Style;
  length: EssayLength;
  suggestion_id?: Uuid | null;
  save_token: string;
}

/** [다시 만들기] 바탕: 보고 있던 버전 또는 직전에 다시 만든(저장 안 한) 결과 중 하나 */
export type RegenerateBase = { based_on_version_id: Uuid } | { based_on_request_id: number };

/** 다시 만든 결과 (B: RegenResult). 저장하기 전까지 버전이 아니다 */
export interface RegenResult {
  /** [저장하기]에 쓰는 번호 */
  request_id: number;
  essay_id: Uuid;
  title: string;
  body: string;
  char_count: number;
  in_length_range: boolean;
  style: Style;
  length: EssayLength;
  /** '다시 만들기 N회째' */
  regen_count: number;
  /** 저장하면 이 버전을 바탕으로 한 것으로 남는다 */
  based_on_version_id: Uuid;
  /** '삭제한 소재는 새로 넣지 않아요' 안내 */
  deleted_materials_left_out: boolean;
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
