"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLeaveGuard } from "@/components/collect/useLeaveGuard";
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
  confirmMaterial,
  deleteRecord,
  getOriginal,
  keepOriginal,
  MATERIAL_RULES,
  reanalyze,
  TOPICS,
  waitForAnalysis,
  type AnalysisMaterial,
  type AnalysisState,
  type ApiError,
  type MaterialDetail,
  type Original,
} from "@/lib/api";
import { collectRoutes, routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/** 보관한 소재 (보관 완료 화면에 보여 줄 만큼) */
type KeptMaterial = Pick<AnalysisMaterial, "id" | "title" | "summary" | "keywords" | "topics">;

const LIMIT_MESSAGE = "오늘 사용할 수 있는 횟수를 다 썼어요";

/** 고치는 칸 */
type Form = { title: string; summary: string; keywords: string[]; topics: number[] };
type FieldErrors = Partial<Record<keyof Form | "form", string>>;

const formOf = (m: AnalysisMaterial | null): Form => ({
  title: m?.title ?? "",
  summary: m?.summary ?? "",
  keywords: m?.keywords ?? [],
  topics: m?.topics.map((t) => t.id) ?? [],
});

const sameForm = (a: Form, b: Form) =>
  a.title === b.title &&
  a.summary === b.summary &&
  a.keywords.join("\n") === b.keywords.join("\n") &&
  [...a.topics].sort().join(",") === [...b.topics].sort().join(",");

/** B ConfirmIn과 같은 규칙으로 화면에서 먼저 확인 */
function validate(form: Form): FieldErrors {
  const errors: FieldErrors = {};
  if (form.title.trim().length > MATERIAL_RULES.titleMax) errors.title = `제목은 ${MATERIAL_RULES.titleMax}자까지 적을 수 있어요`;
  const summary = form.summary.trim();
  if (!summary) errors.summary = "소재 요약을 적어 주세요";
  else if (summary.length > MATERIAL_RULES.summaryMax) errors.summary = `요약은 ${MATERIAL_RULES.summaryMax}자까지 적을 수 있어요`;
  if (form.topics.length === 0) errors.topics = "주제를 하나 이상 골라 주세요";
  return errors;
}

/**
 * M120 소재 확인 (UI 설계서 v7 12쪽, 목록 9·21·22번)
 * - 열면 waitForAnalysis로 분석이 끝날 때까지 기다린다 (화면을 나가면 멈춤. 분석은 서버에서 계속)
 * - 75초가 지나도 분석 중이면 '아직 찾고 있어요' + [소재함으로]
 * - done: 후보를 고쳐서 [소재함에 보관] → 보관 완료 ([이 소재로 바로 글쓰기] / [소재함으로])
 *   이미 보관된 소재로 열면 처음부터 보관 완료
 * - 뒤로가기: 고친 내용이 있으면 '고친 내용은 저장되지 않아요' 확인 1번 (보관하지 않은 소재는 확인 대기에 남음)
 * - empty (목록 21번): 안내 + [새로 기록하기]/[새 대화 시작하기](keepOriginal 뒤 새로 시작) + [기록 삭제].
 *   [직접 정리하기]·[다시 분석]·[원본만 보관]은 두지 않음
 * - failed: [다시 분석](can_reanalyze, 하루 한도면 막고 안내) / [직접 정리하기] / [원본만 보관]
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + recordId)
 */
export default function MaterialReviewScreen({ recordId }: { recordId: string }) {
  const { bfcacheId } = useRouter();
  return <MaterialReview key={`${bfcacheId}:${recordId}`} recordId={recordId} />;
}

function MaterialReview({ recordId }: { recordId: string }) {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [state, setState] = useState<AnalysisState | null>(null);
  /** 75초가 지나도 분석 중 */
  const [slow, setSlow] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [waitAttempt, setWaitAttempt] = useState(0);
  /** 보관 완료된 소재 (보관했거나, 이미 보관된 소재로 열었을 때) */
  const [kept, setKept] = useState<KeptMaterial | null>(null);

  const [form, setForm] = useState<Form>(formOf(null));
  const [initialForm, setInitialForm] = useState<Form>(formOf(null));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  /** 실패 뒤 [직접 정리하기] 중 */
  const [manual, setManual] = useState(false);
  /** 다시 분석·원본만 보관·기록 삭제·새로 시작 요청 중 */
  const [acting, setActing] = useState<"reanalyze" | "keep" | "delete" | "restart" | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** 삭제 확인에서 [지우기]를 골랐나. 팝업이 다 닫힌 뒤 지운다 */
  const deleteChosen = useRef(false);
  /** 나가기 확인에서 [나가기]를 골랐나. 팝업이 다 닫힌 뒤(뒤로가기 기록 정리 뒤) 나간다 */
  const leaveChosen = useRef(false);
  const busy = useRef(false);

  /** 공통 오류: O110 / 기록 없음 → 홈. 처리했으면 true */
  const handleCommonError = useCallback(
    (error: ApiError) => {
      if (goOnboardingIfNeeded(error)) return true;
      if (error.code === "record_not_found") {
        toast("기록을 찾을 수 없어요");
        router.replace(routes.home);
        return true;
      }
      return false;
    },
    [goOnboardingIfNeeded, router, toast],
  );

  /** 분석 상태를 화면에 반영. 후보가 처음 오면 고치는 칸을 채운다 */
  const applyState = useCallback((next: AnalysisState) => {
    setState(next);
    const m = next.material;
    if (m?.confirmed_at) {
      setKept(m);
    } else if (next.analysis_status === "done" && m) {
      const initial = formOf(m);
      setForm(initial);
      setInitialForm(initial);
    }
  }, []);

  /* ---------- 분석 기다리기 ---------- */

  useEffect(() => {
    const controller = new AbortController();
    void waitForAnalysis(recordId, { signal: controller.signal, onUpdate: applyState }).then((res) => {
      if (controller.signal.aborted) return;
      if (!res.ok) {
        if (!handleCommonError(res.error)) setLoadFailed(true);
        return;
      }
      applyState(res.data);
      setSlow(res.data.analysis_status === "analyzing");
    });
    return () => controller.abort(); // 화면을 나가면 기다림만 멈춘다 (분석은 서버에서 계속)
  }, [recordId, waitAttempt, applyState, handleCommonError]);

  /* ---------- 나가기 ---------- */

  const editing = !kept && (manual || state?.analysis_status === "done");
  const dirty = editing && !sameForm(form, initialForm);
  const { leave } = useLeaveGuard({ dirty, onBlocked: () => setLeaveOpen(true) });

  const requestLeave = () => {
    if (dirty) setLeaveOpen(true);
    else leave();
  };

  const onLeaveDialogClosed = () => {
    setLeaveOpen(false);
    if (leaveChosen.current) {
      leaveChosen.current = false;
      leave();
    }
  };

  /* ---------- 보관 ---------- */

  const submit = async () => {
    if (busy.current) return;
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    busy.current = true;
    setSaving(true);
    const res = await confirmMaterial(recordId, {
      title: form.title.trim() || null,
      summary: form.summary.trim(),
      keywords: form.keywords,
      topics: form.topics,
    });
    busy.current = false;
    setSaving(false);
    if (res.ok) {
      setKept(toKept(res.data));
      return;
    }
    if (handleCommonError(res.error)) return;
    if (res.error.code === "material_deleted") {
      toast("이미 삭제한 소재예요");
      leave(routes.materials);
      return;
    }
    if (res.error.code === "unknown_topic") {
      setErrors({ topics: "주제를 다시 골라 주세요" });
      return;
    }
    if (res.error.kind === "bad_request") {
      setErrors({ form: "입력한 내용을 확인해 주세요" });
      return;
    }
    toast("보관하지 못했어요");
  };

  /* ---------- 소재 없음·실패 ---------- */

  const run = async <T,>(kind: NonNullable<typeof acting>, fn: () => Promise<T>) => {
    if (busy.current) return null;
    busy.current = true;
    setActing(kind);
    const result = await fn();
    busy.current = false;
    setActing(null);
    return result;
  };

  /** [새로 기록하기]/[새 대화 시작하기]: 지금 기록은 '원본만 보관'으로 남기고 새로 시작 (실패해도 이동) */
  const restart = async () => {
    const res = await run("restart", () => keepOriginal(recordId));
    if (res === null) return;
    if (!res.ok && goOnboardingIfNeeded(res.error)) return;
    leave(state?.record_type === "qna" ? collectRoutes.ai() : collectRoutes.free());
  };

  const removeRecord = async () => {
    const res = await run("delete", () => deleteRecord(recordId));
    if (res === null) return;
    if (res.ok) {
      toast("기록을 지웠어요");
      leave(routes.home);
      return;
    }
    if (handleCommonError(res.error)) return;
    toast(res.error.code === "material_confirmed" || res.error.code === "material_deleted" ? "이 기록은 지울 수 없어요" : "지우지 못했어요");
  };

  const keepOnly = async () => {
    const res = await run("keep", () => keepOriginal(recordId));
    if (res === null) return;
    if (res.ok) {
      leave(routes.materials);
      return;
    }
    if (handleCommonError(res.error)) return;
    if (res.error.code === "material_deleted") {
      toast("이미 삭제한 소재예요");
      leave(routes.materials);
      return;
    }
    toast("보관하지 못했어요");
  };

  const retryAnalysis = async () => {
    const res = await run("reanalyze", () => reanalyze(recordId));
    if (res === null) return;
    if (res.ok) {
      applyState(res.data);
      setSlow(false);
      setWaitAttempt((n) => n + 1); // 다시 기다리기
      return;
    }
    if (handleCommonError(res.error)) return;
    if (res.error.code === "daily_limit") {
      toast(LIMIT_MESSAGE);
      setState((s) => (s ? { ...s, daily_limit_reached: true } : s));
      return;
    }
    if (res.error.code === "material_deleted") {
      toast("이미 삭제한 소재예요");
      leave(routes.materials);
      return;
    }
    if (res.error.code === "cannot_reanalyze") {
      setWaitAttempt((n) => n + 1); // 상태가 바뀜 → 다시 불러오기
      return;
    }
    toast("다시 분석하지 못했어요");
  };

  const startManual = () => {
    const empty = formOf(null);
    setForm(empty);
    setInitialForm(empty);
    setErrors({});
    setManual(true);
  };

  /* ---------- 화면 ---------- */

  const header = <ScreenHeader title="소재 확인" back onBack={requestLeave} />;

  if (loadFailed) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice
            message="연결이 불안정해요"
            onRetry={() => {
              setLoadFailed(false);
              setWaitAttempt((n) => n + 1);
            }}
          />
        </div>
      </>
    );
  }

  if (kept) {
    return (
      <>
        {header}
        <KeptView material={kept} onWrite={() => leave(`${routes.newSelect}?selected=${kept.id}`)} onBox={() => leave(routes.materials)} />
      </>
    );
  }

  if (!state || state.analysis_status === "analyzing") {
    return (
      <>
        {header}
        {slow ? (
          <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <p className="text-[15px] font-semibold">아직 찾고 있어요.</p>
            <p className="text-sm text-ink-soft">소재함에서 이어서 볼 수 있어요.</p>
            <Button variant="secondary" onClick={() => leave(routes.materials)}>
              소재함으로
            </Button>
          </section>
        ) : (
          <section className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role="status">
            <Spinner className="size-8" />
            <p className="text-[15px] font-semibold">기록에서 소재를 찾고 있어요…</p>
            <p className="text-sm text-ink-soft">화면을 닫아도 계속 찾아요.</p>
          </section>
        )}
      </>
    );
  }

  // 고치는 칸: 후보 확인(done) 또는 직접 정리하기
  if (editing) {
    const candidate = !manual ? state.material : null;
    return (
      <>
        {header}
        <div className="flex flex-col gap-6 px-5 pt-5">
          <p className="text-[15px] font-semibold">
            {manual ? "기록을 보고 소재를 직접 정리해 보세요." : "이 기록에서 찾은 소재예요. 고쳐도 돼요."}
          </p>
          <MaterialFields form={form} setForm={setForm} errors={errors} disabled={saving} />
          <Evidence recordId={recordId} evidence={candidate?.evidence ?? null} />
          {errors.form && <p className="text-sm text-danger">{errors.form}</p>}
          {manual && (
            <button type="button" onClick={() => setManual(false)} disabled={saving} className="self-start text-sm text-ink-mute underline">
              돌아가기
            </button>
          )}
        </div>
        <BottomActionBarSpacer />
        <BottomActionBar>
          <Button block size="lg" loading={saving} onClick={() => void submit()}>
            소재함에 보관
          </Button>
        </BottomActionBar>

        {/* 고친 내용이 있을 때 나가기 확인 (1번) */}
        <ConfirmDialog
          open={leaveOpen}
          onClose={onLeaveDialogClosed}
          title="고친 내용은 저장되지 않아요"
          description={manual ? "보관하지 않은 기록은 소재함 '확인 대기'에 남아요." : "보관하지 않은 소재는 소재함 '확인 대기'에 남아요."}
          actions={[
            { label: "계속 고치기", onClick: () => (leaveChosen.current = false) },
            { label: "나가기", variant: "primary", onClick: () => (leaveChosen.current = true) },
          ]}
        />
      </>
    );
  }

  // 소재 없음 (목록 21번): 새로 쓰기 또는 삭제로 단순화
  if (state.analysis_status === "empty") {
    const restartLabel = state.record_type === "qna" ? "새 대화 시작하기" : "새로 기록하기";
    return (
      <>
        {header}
        <section className="flex flex-1 flex-col justify-center gap-3 px-6">
          <p className="text-lg font-bold">소재를 찾지 못했어요</p>
          <p className="text-[15px] leading-relaxed text-ink-soft">
            이 기록에서는 글감을 찾기 어려웠어요. 기억나는 장면이나 대화를 조금 더 자세히 남겨 보세요.
          </p>
        </section>
        <BottomActionBarSpacer height="8rem" />
        <BottomActionBar>
          <div className="flex flex-col gap-2">
            <Button block size="lg" loading={acting === "restart"} disabled={acting !== null} onClick={() => void restart()}>
              {restartLabel}
            </Button>
            <Button block variant="ghost" loading={acting === "delete"} disabled={acting !== null} onClick={() => setDeleteOpen(true)}>
              기록 삭제
            </Button>
          </div>
        </BottomActionBar>

        <ConfirmDialog
          open={deleteOpen}
          onClose={() => {
            setDeleteOpen(false);
            if (deleteChosen.current) {
              deleteChosen.current = false;
              void removeRecord();
            }
          }}
          title="이 기록을 지울까요?"
          description="지운 기록은 되돌릴 수 없어요."
          actions={[
            { label: "취소", onClick: () => (deleteChosen.current = false) },
            { label: "지우기", variant: "danger", onClick: () => (deleteChosen.current = true) },
          ]}
        />
      </>
    );
  }

  // 분석 실패 (오류·시간 초과·하루 한도)
  const limit = state.daily_limit_reached;
  return (
    <>
      {header}
      <section className="flex flex-1 flex-col justify-center gap-3 px-6">
        <p className="text-lg font-bold">분석하지 못했어요.</p>
        <p className="text-[15px] text-ink-soft">원본 기록은 저장돼 있어요.</p>
        {limit && <p className="rounded-xl bg-subtle px-4 py-3 text-sm text-ink-soft">{LIMIT_MESSAGE}</p>}
      </section>
      <BottomActionBarSpacer height="11rem" />
      <BottomActionBar>
        <div className="flex flex-col gap-2">
          {(state.can_reanalyze || limit) && (
            <Button block size="lg" loading={acting === "reanalyze"} disabled={limit || acting !== null} onClick={() => void retryAnalysis()}>
              다시 분석
            </Button>
          )}
          <Button block variant="secondary" disabled={acting !== null} onClick={startManual}>
            직접 정리하기
          </Button>
          <Button block variant="ghost" loading={acting === "keep"} disabled={acting !== null} onClick={() => void keepOnly()}>
            원본만 보관
          </Button>
        </div>
      </BottomActionBar>
    </>
  );
}

const toKept = (d: MaterialDetail): KeptMaterial => ({
  id: d.id,
  title: d.title,
  summary: d.summary,
  keywords: d.keywords,
  topics: d.topics,
});

/* ---------- 고치는 칸 (제목·요약·키워드·주제) ---------- */

function MaterialFields({
  form,
  setForm,
  errors,
  disabled,
}: {
  form: Form;
  setForm: (updater: (f: Form) => Form) => void;
  errors: FieldErrors;
  disabled: boolean;
}) {
  const [keywordInput, setKeywordInput] = useState("");
  const [keywordError, setKeywordError] = useState<string | null>(null);

  const addKeyword = () => {
    const k = keywordInput.trim();
    if (!k) return;
    if (k.length > MATERIAL_RULES.keywordMax) {
      setKeywordError(`키워드는 ${MATERIAL_RULES.keywordMax}자까지 적을 수 있어요`);
      return;
    }
    if (form.keywords.length >= MATERIAL_RULES.keywordsMax) {
      setKeywordError(`키워드는 ${MATERIAL_RULES.keywordsMax}개까지 넣을 수 있어요`);
      return;
    }
    setKeywordError(null);
    setKeywordInput("");
    if (!form.keywords.includes(k)) setForm((f) => ({ ...f, keywords: [...f.keywords, k] }));
  };

  const toggleTopic = (id: number) =>
    setForm((f) => ({ ...f, topics: f.topics.includes(id) ? f.topics.filter((t) => t !== id) : [...f.topics, id] }));

  return (
    <>
      <Field label="제목 (선택)" error={errors.title}>
        <input
          type="text"
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          maxLength={MATERIAL_RULES.titleMax}
          disabled={disabled}
          className="h-11 w-full rounded-xl border border-line px-3 text-[15px] outline-none focus:border-ink disabled:opacity-60"
        />
      </Field>

      <Field label="소재" error={errors.summary} hint={`${form.summary.trim().length}/${MATERIAL_RULES.summaryMax}`}>
        <textarea
          value={form.summary}
          onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
          maxLength={MATERIAL_RULES.summaryMax}
          rows={3}
          disabled={disabled}
          className="w-full resize-none rounded-xl border border-line px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-ink disabled:opacity-60"
        />
      </Field>

      <Field label="키워드" error={keywordError ?? undefined}>
        <div className="flex flex-wrap gap-2">
          {form.keywords.map((k) => (
            <span key={k} className="inline-flex h-8 items-center gap-1 rounded-full bg-subtle pr-1 pl-3 text-[13px]">
              {k}
              <button
                type="button"
                aria-label={`${k} 빼기`}
                disabled={disabled}
                onClick={() => setForm((f) => ({ ...f, keywords: f.keywords.filter((x) => x !== k) }))}
                className="flex size-6 items-center justify-center rounded-full text-ink-mute active:bg-line"
              >
                ×
              </button>
            </span>
          ))}
          {form.keywords.length < MATERIAL_RULES.keywordsMax && (
            <form
              className="inline-flex h-8 items-center rounded-full border border-dashed border-line pr-1 pl-3"
              onSubmit={(e) => {
                e.preventDefault();
                addKeyword();
              }}
            >
              <input
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                maxLength={MATERIAL_RULES.keywordMax}
                disabled={disabled}
                placeholder="키워드"
                aria-label="키워드 추가"
                className="w-20 bg-transparent text-[13px] outline-none"
              />
              <button type="submit" aria-label="키워드 추가" disabled={disabled} className="flex size-6 items-center justify-center text-ink-soft">
                +
              </button>
            </form>
          )}
        </div>
      </Field>

      <Field label="주제" error={errors.topics}>
        <div className="flex flex-wrap gap-2">
          {TOPICS.map((t) => {
            const selected = form.topics.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => toggleTopic(t.id)}
                className={`inline-flex h-8 items-center rounded-full border px-3 text-[13px] ${
                  selected ? "border-ink bg-ink font-semibold text-white" : "border-line text-ink-soft active:bg-subtle"
                }`}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      </Field>
    </>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink-soft">{label}</span>
        {hint && <span className="text-xs text-ink-mute">{hint}</span>}
      </div>
      {children}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/* ---------- 근거 문장 · 원문 보기 ---------- */

function Evidence({ recordId, evidence }: { recordId: string; evidence: string | null }) {
  const [original, setOriginal] = useState<Original | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (original || loading) return;
    setLoading(true);
    setFailed(false);
    const res = await getOriginal(recordId);
    setLoading(false);
    if (res.ok) setOriginal(res.data);
    else setFailed(true);
  };

  return (
    <div className="flex flex-col gap-2">
      {evidence && (
        <>
          <span className="text-sm font-semibold text-ink-soft">근거 문장</span>
          <blockquote className="rounded-xl border-l-4 border-primary bg-subtle px-4 py-3 text-sm leading-relaxed text-ink">
            “{evidence}”
          </blockquote>
        </>
      )}
      <button type="button" onClick={() => void toggle()} className="self-start text-sm font-semibold text-primary" aria-expanded={open}>
        원문 보기 (읽기 전용) {open ? "︿" : "›"}
      </button>
      {open && (
        <div className="rounded-xl border border-line px-4 py-3 text-sm leading-relaxed text-ink-soft">
          {loading && <Loading />}
          {failed && <p>원문을 불러오지 못했어요</p>}
          {original && <OriginalText original={original} />}
        </div>
      )}
    </div>
  );
}

export function OriginalText({ original }: { original: Original }) {
  if (original.record_type === "free") {
    return (
      <div className="flex flex-col gap-2">
        {original.title && <p className="font-semibold text-ink">{original.title}</p>}
        <p className="whitespace-pre-wrap">{original.body}</p>
      </div>
    );
  }
  return (
    <dl className="flex flex-col gap-3">
      {original.messages.map((m) => (
        <div key={m.seq}>
          <dt className="font-semibold text-ink">{m.question}</dt>
          <dd className="mt-1 whitespace-pre-wrap">{m.answer}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- 보관 완료 ---------- */

function KeptView({ material, onWrite, onBox }: { material: KeptMaterial; onWrite: () => void; onBox: () => void }) {
  return (
    <>
      <div className="flex flex-col gap-4 px-5 pt-6">
        <p className="text-[15px] font-semibold">소재함에 보관했어요</p>
        <div className="rounded-2xl border border-line p-4">
          {material.title && <p className="text-base font-bold">{material.title}</p>}
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">{material.summary}</p>
          {material.topics.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {material.topics.map((t) => (
                <span key={t.id} className="inline-flex h-6 items-center rounded-md bg-primary-soft px-2 text-xs text-primary">
                  {t.name}
                </span>
              ))}
              {material.keywords.map((k) => (
                <span key={k} className="inline-flex h-6 items-center rounded-md bg-subtle px-2 text-xs text-ink-soft">
                  #{k}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <BottomActionBarSpacer height="8rem" />
      <BottomActionBar>
        <div className="flex flex-col gap-2">
          <Button block size="lg" onClick={onWrite}>
            이 소재로 바로 글쓰기
          </Button>
          <Button block variant="secondary" onClick={onBox}>
            소재함으로
          </Button>
        </div>
      </BottomActionBar>
    </>
  );
}
