"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BottomActionBar,
  BottomActionBarSpacer,
  Button,
  ConfirmDialog,
  Loading,
  RetryNotice,
  ScreenHeader,
  Spinner,
  useToast,
} from "@/components/ui";
import {
  answerQna,
  discardQna,
  discardQnaChanges,
  getActiveQna,
  getQnaDraft,
  getTodayQuestions,
  QNA_RULES,
  replaceQnaQuestion,
  logEvent,
  requestNextQuestion,
  saveQna,
  saveQnaDraft,
  startQna,
  type ApiError,
  type ApiResult,
  type DailyQuestions,
  type QnaState,
} from "@/lib/api";
import { routes, type ResumeMode } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { useLeaveGuard } from "./useLeaveGuard";

/** B qna.py: 답변 최대 5,000자 */
const ANSWER_MAX = 5_000;
/** 짧은 첫 답변 안내 기준 (UI 설계서 8쪽: 예 30자) */
const SHORT_FIRST_ANSWER = 30;

/** 다시 맞춰야 하는 오류: 이중 전송 등으로 서버 상태와 화면이 어긋남 */
const RESYNC_CODES = new Set(["not_pending_question", "finished", "conversation_not_found"]);

type Phase = "loading" | "ready" | "loadFailed";
type ExitChoice = "saveAndLeave" | "discardAndLeave" | "leave" | null;

type Initial =
  | { type: "chat"; qna: QnaState }
  | { type: "first"; daily: DailyQuestions; notice?: string }
  | { type: "error"; error: ApiError | null };

/** 처음 열 때 불러오기. 이어서 열 대화가 없으면 새로 시작 */
async function loadInitial(resume: ResumeMode | null): Promise<Initial> {
  let notice: string | undefined;
  if (resume) {
    const res = resume === "active" ? await getActiveQna() : await getQnaDraft();
    if (!res.ok) return { type: "error", error: res.error };
    if (res.data) return { type: "chat", qna: res.data };
    notice = "이어 쓸 대화가 없어요";
  }
  const daily = await getTodayQuestions();
  if (!daily.ok) return { type: "error", error: daily.error };
  if (daily.data.questions.length === 0) return { type: "error", error: null };
  return { type: "first", daily: daily.data, notice };
}

/**
 * W210 AI 질문에 답하기 (UI 설계서 v7 8~11쪽, 목록 1·3·12·17번)
 * - ?resume=active → getActiveQna() / ?resume=draft → getQnaDraft(). 없으면 '이어 쓸 대화가 없어요' + 새로 시작
 * - 새로 시작: 오늘 질문 30개 중 1번부터. [↻ 첫 질문 바꾸기 n/30]은 30 다음 1 (목록 1번)
 * - 첫 답변 startQna → 후속 답변 answerQna. 기다리는 동안 '생각 중…'
 * - 화면 상태는 QnaState 값으로만 판단한다 (개수를 화면에서 세지 않음)
 * - 다음 질문이 없고(pending_question = null) 끝나지 않았으면 AI 실패 → [다시 시도] requestNextQuestion
 * - 409 not_pending_question·finished, 404 conversation_not_found → 지금 상태를 다시 불러와 맞춘다
 * - [다른 질문 보기 N]: 후속 질문일 때만, N = replace_left. 실패(ai_failed)면 그대로 + '질문을 바꾸지 못했어요' (목록 12번)
 *   0이면 회색·숫자 0, 팝업 없음 + 한 줄 안내 (9·10쪽)
 * - [소재로 저장]: can_save가 false면 회색 + '질문에 하나만 더 답해 주세요' (목록 3번)
 * - W212 (finished): 마무리 말, 입력·다른 질문 보기 막음, [소재로 저장] 강조
 * - [임시 저장]: 첫 답변 뒤에만 → W111. [소재로 저장]: saveQna → M120, 실패하면 [다시 시도]
 * - W211 (헤더 [나가기]·‹·브라우저/휴대폰 뒤로가기): 첫 답변 전 [나가기]/[계속 쓰기],
 *   첫 답변 뒤 [임시 저장하고 나가기]/[저장하지 않고 나가기]/[계속 쓰기].
 *   이어 쓰던 draft를 열고 아무것도 안 바꿨으면 팝업 없이 나감
 * - 기록 시작 이벤트: 화면에 들어올 때마다 1번 (이어서 열면 record_id, 목록 23·24번)
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + resume, W110과 같은 이유: cacheComponents의 Activity)
 */
export default function QnaChatScreen() {
  const { bfcacheId } = useRouter();
  const value = useSearchParams().get("resume");
  const resume: ResumeMode | null = value === "active" || value === "draft" ? value : null;
  return <QnaChat key={`${bfcacheId}:${resume ?? "new"}`} resume={resume} />;
}

function QnaChat({ resume }: { resume: ResumeMode | null }) {
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  /** 첫 답변 전: 오늘 질문과 지금 보는 번호 */
  const [daily, setDaily] = useState<DailyQuestions | null>(null);
  const [dailyIndex, setDailyIndex] = useState(0);
  /** 첫 답변 뒤: 서버가 준 대화 상태 */
  const [qna, setQna] = useState<QnaState | null>(null);
  const [input, setInput] = useState("");
  /** 보내는 중인 답변 (응답 전까지 말풍선으로 보여 줌) */
  const [sendingAnswer, setSendingAnswer] = useState<string | null>(null);
  /** 다음 질문 다시 받는 중 */
  const [retryingNext, setRetryingNext] = useState(false);
  /** [다른 질문 보기] 요청 중 */
  const [replacing, setReplacing] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingRecord, setSavingRecord] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [draftSavedOpen, setDraftSavedOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  /** 마지막으로 불러오거나 임시 저장했을 때의 updated_at (draft의 바뀜 여부) */
  const [savedUpdatedAt, setSavedUpdatedAt] = useState<string | null>(null);
  const busy = useRef(false);
  /** W211에서 고른 것. 팝업이 다 닫힌 뒤 실행 */
  const exitChoice = useRef<ExitChoice>(null);
  /** 이어서 연 대화 id (이벤트용) */
  const openedRecordId = useRef<string | null>(null);
  const eventLogged = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  /* ---------- 불러오기 ---------- */

  const applyInitial = useCallback(
    (result: Initial) => {
      if (result.type === "error") {
        if (!result.error || !goOnboardingIfNeeded(result.error)) setPhase("loadFailed");
        return;
      }
      if (result.type === "chat") {
        setQna(result.qna);
      } else {
        setQna(null);
        setDaily(result.daily);
        setDailyIndex(0);
        if (result.notice) toast(result.notice);
      }
      setPhase("ready");
    },
    [goOnboardingIfNeeded, toast],
  );

  useEffect(() => {
    let cancelled = false;
    void loadInitial(resume).then((result) => {
      if (cancelled) return;
      if (result.type === "chat") {
        openedRecordId.current = result.qna.record_id;
        setSavedUpdatedAt(result.qna.updated_at);
      }
      applyInitial(result);
    });
    return () => {
      cancelled = true;
    };
  }, [resume, loadAttempt, applyInitial]);

  /* ---------- 나가기 확인 (W211) ---------- */

  const typed = input.trim() !== "";
  const dirty =
    phase === "ready" &&
    (qna === null ? typed : qna.status === "active" || qna.updated_at !== savedUpdatedAt || typed);
  const { leave } = useLeaveGuard({ dirty, onBlocked: () => setExitOpen(true) });

  /* ---------- 기록 시작 이벤트 (23·24번) ---------- */

  useEffect(() => {
    if (phase !== "ready" || eventLogged.current) return;
    eventLogged.current = true;
    const recordId = openedRecordId.current;
    void logEvent("record_started", recordId ? { record_type: "qna", record_id: recordId } : { record_type: "qna" });
  }, [phase]);

  // 새 말풍선이 생기면 맨 아래로
  const messageCount = qna?.messages.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messageCount, sendingAnswer, qna?.finished]);

  /* ---------- 서버 상태와 다시 맞추기 ---------- */

  /** 지금 대화를 다시 불러온다. 없어졌으면(1시간 지남 등) 새로 시작 */
  const resync = async (status: QnaState["status"]) => {
    const res = status === "active" ? await getActiveQna() : await getQnaDraft();
    if (res.ok && res.data) {
      setQna(res.data);
      return;
    }
    if (!res.ok) {
      if (!goOnboardingIfNeeded(res.error)) toast("연결이 불안정해요");
      return;
    }
    applyInitial(await loadInitial(null));
    toast("이어 쓸 대화가 없어요");
  };

  /** 문답 요청 실패 처리. 다시 맞춰야 하면 맞추고 true */
  const handleQnaError = async (error: ApiError, failMessage: string) => {
    if (goOnboardingIfNeeded(error)) return;
    if (qna && error.code && RESYNC_CODES.has(error.code)) {
      await resync(qna.status);
      return;
    }
    toast(failMessage);
  };

  /* ---------- 답하기 ---------- */

  const currentDaily = daily?.questions[dailyIndex] ?? null;

  const send = async () => {
    const answer = input.trim();
    if (busy.current || !answer) return;
    if (qna ? !qna.pending_question : !currentDaily) return;
    busy.current = true;
    setSendingAnswer(answer);
    setInput("");

    let res: ApiResult<QnaState>;
    if (!qna) {
      res = await startQna({ daily_question_id: currentDaily!.id, answer });
    } else {
      res = await answerQna(qna.record_id, { question_id: qna.pending_question!.id, answer });
    }

    busy.current = false;
    setSendingAnswer(null);
    if (res.ok) {
      setQna(res.data);
      return;
    }
    setInput(answer); // 보내지 못한 답변은 입력창에 되돌림
    if (!qna && res.error.code === "invalid_daily_question") {
      // 날짜가 바뀌어 오늘 질문이 달라짐 → 다시 받기
      const fresh = await getTodayQuestions();
      if (fresh.ok && fresh.data.questions.length > 0) {
        setDaily(fresh.data);
        setDailyIndex(0);
      }
      toast("오늘의 질문이 바뀌었어요. 다시 답해 주세요");
      return;
    }
    await handleQnaError(res.error, "답변을 보내지 못했어요");
  };

  /** AI 실패 뒤 [다시 시도] */
  const retryNext = async () => {
    if (busy.current || !qna) return;
    busy.current = true;
    setRetryingNext(true);
    const res = await requestNextQuestion(qna.record_id);
    busy.current = false;
    setRetryingNext(false);
    if (res.ok) setQna(res.data);
    else await handleQnaError(res.error, "질문을 만들지 못했어요");
  };

  /** [다른 질문 보기]: 성공한 뒤에만 바뀌고 횟수가 준다 (서버). AI 실패면 그대로 */
  const replace = async () => {
    const pending = qna?.pending_question;
    if (busy.current || !qna || !pending) return;
    busy.current = true;
    setReplacing(true);
    const res = await replaceQnaQuestion(qna.record_id, pending.id);
    busy.current = false;
    setReplacing(false);
    if (!res.ok) {
      await handleQnaError(res.error, "질문을 바꾸지 못했어요");
      return;
    }
    setQna(res.data);
    if (res.data.ai_failed) toast("질문을 바꾸지 못했어요");
  };

  /* ---------- 임시 저장 · 소재로 저장 ---------- */

  /** 임시 저장. 성공 여부를 돌려준다 (실패 안내는 여기서) */
  const saveDraft = async (): Promise<boolean> => {
    if (busy.current || !qna) return false;
    busy.current = true;
    setSavingDraft(true);
    const res = await saveQnaDraft(qna.record_id);
    busy.current = false;
    setSavingDraft(false);
    if (res.ok) {
      setQna(res.data);
      setSavedUpdatedAt(res.data.updated_at);
      return true;
    }
    if (!goOnboardingIfNeeded(res.error)) toast("임시 저장하지 못했어요");
    return false;
  };

  const saveRecord = async () => {
    if (busy.current || !qna?.can_save) return;
    busy.current = true;
    setSavingRecord(true);
    setSaveFailed(false);
    const res = await saveQna(qna.record_id);
    if (res.ok) {
      // 이동하는 동안 막힌 채로 둔다
      leave(routes.materialReview(res.data.id));
      return;
    }
    busy.current = false;
    setSavingRecord(false);
    if (goOnboardingIfNeeded(res.error)) return;
    if (res.error.code && RESYNC_CODES.has(res.error.code)) await resync(qna.status);
    else setSaveFailed(true);
  };

  const requestExit = () => {
    if (dirty) setExitOpen(true);
    else leave();
  };

  const onExitDialogClosed = async () => {
    setExitOpen(false);
    const choice = exitChoice.current;
    exitChoice.current = null;
    if (choice === "leave") leave();
    if (choice === "saveAndLeave" && (await saveDraft())) leave();
    if (choice === "discardAndLeave") {
      // 실패해도 나간다: active는 1시간 뒤 서버가 지우고, draft는 다음에 열 때 되돌린다
      if (qna) await (qna.status === "active" ? discardQna(qna.record_id) : discardQnaChanges(qna.record_id));
      leave();
    }
  };

  /* ---------- 화면 ---------- */

  if (phase === "loading") return <Loading fullScreen />;

  if (phase === "loadFailed") {
    return (
      <>
        <ScreenHeader title="AI 질문" back />
        <div className="px-5 pt-6">
          <RetryNotice
            message="연결이 불안정해요"
            onRetry={() => {
              setPhase("loading");
              setLoadAttempt((n) => n + 1);
            }}
          />
        </div>
      </>
    );
  }

  const sending = sendingAnswer !== null;
  const thinking = sending || retryingNext;
  const finished = qna?.finished ?? false;
  // 다음 질문이 없고 끝나지도 않음 = AI가 질문을 만들지 못함 (답변은 저장돼 있음)
  const nextMissing = qna !== null && !qna.pending_question && !qna.finished && !thinking;
  const canType = !thinking && !replacing && !savingRecord && !finished && !nextMissing && (qna ? !!qna.pending_question : !!currentDaily);
  const answerCount = qna?.answer_count ?? 0;
  const pending = qna?.pending_question ?? null;
  // 첫 질문은 바꿀 수 없음 → 후속 질문일 때만 (W212에서는 막음)
  const showReplace = !!pending && pending.question_source === "followup" && !finished && !sending;
  const replaceLeft = qna?.replace_left ?? 0;
  const canSave = qna?.can_save ?? false;
  const showShortHint = !qna && input.trim().length > 0 && input.trim().length < SHORT_FIRST_ANSWER;

  return (
    <>
      <ScreenHeader
        title="AI 질문"
        back
        onBack={requestExit}
        right={
          <>
            <Button
              variant="ghost"
              className="h-9 px-2.5 text-sm"
              loading={savingDraft}
              disabled={!qna || thinking || replacing || savingRecord}
              onClick={async () => {
                if (await saveDraft()) setDraftSavedOpen(true);
              }}
            >
              임시 저장
            </Button>
            <Button variant="ghost" className="h-9 px-2.5 text-sm" disabled={savingRecord} onClick={requestExit}>
              나가기
            </Button>
          </>
        }
      />

      <div className="px-5 pt-3" aria-label="진행도">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold">
            {answerCount} / {QNA_RULES.maxAnswers}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-subtle">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(answerCount / QNA_RULES.maxAnswers) * 100}%` }} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 px-5 pt-5 pb-4" aria-live="polite">
        {/* 첫 답변 전: 오늘의 질문 */}
        {!qna && currentDaily && daily && (
          <>
            <QuestionBubble text={currentDaily.question} />
            {!sending && (
              <button
                type="button"
                onClick={() => setDailyIndex((i) => (i + 1) % daily.questions.length)}
                className="self-start rounded-full border border-line px-3 py-1.5 text-[13px] text-ink-soft active:bg-subtle"
              >
                ↻ 첫 질문 바꾸기 <span className="ml-1 text-ink-mute">{dailyIndex + 1}/{daily.questions.length}</span>
              </button>
            )}
          </>
        )}

        {/* 첫 답변 뒤: 질문·답변 순서대로 (바꾼 질문은 서버가 빼고 줌) */}
        {qna?.messages.map((m) => (
          <div key={m.id} className="flex flex-col gap-3">
            <QuestionBubble text={m.question} />
            {m.answer !== null && <AnswerBubble text={m.answer} />}
          </div>
        ))}

        {showReplace && (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => void replace()}
              disabled={replaceLeft === 0 || replacing || thinking}
              aria-busy={replacing || undefined}
              className="inline-flex h-8 items-center gap-1.5 self-start rounded-full border border-line px-3 text-[13px] text-ink-soft active:bg-subtle disabled:cursor-not-allowed disabled:bg-subtle disabled:text-ink-mute"
            >
              {replacing && <Spinner className="size-3.5" />}
              다른 질문 보기 <span className="font-semibold">{replaceLeft}</span>
            </button>
            {replaceLeft === 0 && (
              <p className="text-xs text-ink-soft">
                {/* answer_count ≥ 2 = 후속 답변 1개 이상 */}
                {answerCount >= QNA_RULES.minAnswersToSave
                  ? "짧게 답하거나, 지금까지 내용으로 저장해 보세요."
                  : "한 줄만 더 답하면 저장할 수 있어요."}
              </p>
            )}
          </div>
        )}

        {/* W212 질문 마무리 */}
        {finished && <QuestionBubble text="오늘 이야기는 여기까지예요. 나눈 대화를 소재로 저장해 볼까요?" />}

        {sending && <AnswerBubble text={sendingAnswer} />}
        {thinking && (
          <p className="flex items-center gap-2 self-start text-sm text-ink-mute">
            <Spinner className="size-4" /> 생각 중…
          </p>
        )}

        {nextMissing && (
          <RetryNotice message="질문을 만들지 못했어요" onRetry={() => void retryNext()} retrying={retryingNext} />
        )}

        <div ref={bottomRef} />
      </div>

      <BottomActionBarSpacer height="10rem" />
      <BottomActionBar>
        {finished ? (
          <>
            <p className="mb-2 text-center text-sm text-ink-mute">질문이 모두 끝났어요</p>
            {saveFailed && (
              <div className="mb-2">
                <RetryNotice message="연결이 불안정해요" onRetry={() => void saveRecord()} retrying={savingRecord} />
              </div>
            )}
            <Button block size="lg" disabled={!canSave} loading={savingRecord} onClick={() => void saveRecord()}>
              소재로 저장
            </Button>
          </>
        ) : (
          <>
            {qna && !canSave && <p className="mb-1.5 text-center text-xs text-ink-soft">질문에 하나만 더 답해 주세요</p>}
            {saveFailed && (
              <div className="mb-2">
                <RetryNotice message="연결이 불안정해요" onRetry={() => void saveRecord()} retrying={savingRecord} />
              </div>
            )}
            <Button
              block
              variant="secondary"
              className="mb-2"
              disabled={!canSave || thinking || replacing}
              loading={savingRecord}
              onClick={() => void saveRecord()}
            >
              소재로 저장
            </Button>
            {showShortHint && (
              <p className="mb-2 text-xs text-ink-soft">어디서, 누구와, 어떤 기분이었는지 적으면 소재를 찾기 쉬워요</p>
            )}
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={ANSWER_MAX}
                rows={1}
                disabled={!canType}
                placeholder="답변을 입력하세요"
                aria-label="답변"
                className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] leading-snug outline-none focus:border-ink disabled:bg-subtle disabled:opacity-60 field-sizing-content"
              />
              <button
                type="submit"
                aria-label="보내기"
                disabled={!canType || !input.trim()}
                className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-lg font-bold text-white active:brightness-90 disabled:opacity-40"
              >
                ↑
              </button>
            </form>
          </>
        )}
      </BottomActionBar>

      {/* W111 임시 저장됨 */}
      <ConfirmDialog
        open={draftSavedOpen}
        onClose={() => setDraftSavedOpen(false)}
        title="임시 저장됐습니다."
        actions={[{ label: "확인", variant: "primary", onClick: () => {} }]}
      />

      {/* W211 나가기 확인. 고른 동작은 팝업이 닫힌 뒤 onExitDialogClosed에서 실행 */}
      <ConfirmDialog
        open={exitOpen}
        onClose={() => void onExitDialogClosed()}
        title="대화를 그만할까요?"
        description={qna ? "임시 저장하지 않은 대화는 사라져요." : undefined}
        actions={
          qna
            ? [
                { label: "임시 저장하고 나가기", variant: "primary", onClick: () => (exitChoice.current = "saveAndLeave") },
                { label: "저장하지 않고 나가기", onClick: () => (exitChoice.current = "discardAndLeave") },
                { label: "계속 쓰기", variant: "ghost", onClick: () => (exitChoice.current = null) },
              ]
            : [
                { label: "나가기", onClick: () => (exitChoice.current = "leave") },
                { label: "계속 쓰기", variant: "primary", onClick: () => (exitChoice.current = null) },
              ]
        }
      />
    </>
  );
}

function QuestionBubble({ text }: { text: string }) {
  return <p className="max-w-[85%] self-start rounded-2xl rounded-tl-md bg-subtle px-4 py-3 text-[15px] leading-relaxed">{text}</p>;
}

function AnswerBubble({ text }: { text: string }) {
  return (
    <p className="max-w-[85%] self-end rounded-2xl rounded-tr-md bg-primary px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap text-white">
      {text}
    </p>
  );
}
