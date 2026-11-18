"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BottomActionBar, BottomActionBarSpacer, Loading, RetryNotice, ScreenHeader, Spinner, useToast } from "@/components/ui";
import {
  answerQna,
  getActiveQna,
  getQnaDraft,
  getTodayQuestions,
  QNA_RULES,
  requestNextQuestion,
  startQna,
  type ApiError,
  type ApiResult,
  type DailyQuestions,
  type QnaState,
} from "@/lib/api";
import type { ResumeMode } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/** B qna.py: 답변 최대 5,000자 */
const ANSWER_MAX = 5_000;
/** 짧은 첫 답변 안내 기준 (UI 설계서 8쪽: 예 30자) */
const SHORT_FIRST_ANSWER = 30;

/** 다시 맞춰야 하는 오류: 이중 전송 등으로 서버 상태와 화면이 어긋남 */
const RESYNC_CODES = new Set(["not_pending_question", "finished", "conversation_not_found"]);

type Phase = "loading" | "ready" | "loadFailed";

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
  const busy = useRef(false);
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
      if (!cancelled) applyInitial(result);
    });
    return () => {
      cancelled = true;
    };
  }, [resume, loadAttempt, applyInitial]);

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
  const canType = !thinking && !finished && !nextMissing && (qna ? !!qna.pending_question : !!currentDaily);
  const answerCount = qna?.answer_count ?? 0;
  const showShortHint = !qna && input.trim().length > 0 && input.trim().length < SHORT_FIRST_ANSWER;

  return (
    <>
      <ScreenHeader title="AI 질문" back />

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

      <BottomActionBarSpacer height="7rem" />
      <BottomActionBar>
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
      </BottomActionBar>
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
