"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLeaveGuard } from "@/components/collect/useLeaveGuard";
import { BottomActionBar, BottomActionBarSpacer, Button, Loading, RetryNotice, ScreenHeader, Spinner, useToast } from "@/components/ui";
import {
  createAiDraft,
  getEssay,
  getMaterialBox,
  getSuggestion,
  logEvent,
  newSaveToken,
  regenerateEssay,
  type ApiError,
  type EssayLength,
  type RegenerateBase,
  type Style,
} from "@/lib/api";
import {
  draftRegenerateHref,
  draftResultHref,
  newEssayHref,
  readNewEssayParams,
  readRegenParams,
  writingStartedProps,
  type NewEssayParams,
  type RegenBaseParam,
} from "@/lib/newEssayParams";
import { getRegenResult, putRegenResult } from "@/lib/regenResultStore";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

const LIMIT_MESSAGE = "오늘 사용할 수 있는 횟수를 다 썼어요";

const STYLES: { value: Style; description: string }[] = [
  { value: "감성적", description: "마음이 느껴지는 부드러운 문장" },
  { value: "담백함", description: "군더더기 없는 간결한 문장" },
];
const LENGTHS: { value: EssayLength; label: string; description: string }[] = [
  { value: "short", label: "단문", description: "약 300~500자" },
  { value: "long", label: "장문", description: "약 1,000~1,500자" },
];

type Phase = "choose" | "making" | "failed" | "limit";

/** 처음 만들기에 쓰는 값 (N120처럼 소재함·제안에서) */
interface NewInfo {
  materialIds: string[];
  materialTitles: string[];
  direction: string | null;
  suggestionId: string | null;
}

/**
 * W310 문체 · W320 길이 (한 화면 2단계, UI 설계서 v7 21쪽, 목록 20·24·28번, B ai_essays.py)
 * - 처음 만들기: 고른 소재(m)·제안(s)으로 [에세이 만들기] → W330
 *   writing_started(ai)는 처음 누를 때만 (다시 시도 제외). save_token도 처음 누를 때 하나
 * - 다시 만들기 (?regen={essayId}&version=… 또는 &request=…): 처음 고른 소재로 [다시 만들기] → W340.
 *   보던 글의 문체·길이를 미리 골라 둔다 (값이 없으면(직접 쓴 글) 고르지 않음, 28번 미정)
 * - 만드는 동안 화면 전체를 덮고 다른 조작(뒤로가기 포함)을 막는다
 * - 실패: AI 실패·시간 초과·연결 → [다시 시도](같은 옵션·같은 토큰) / 하루 한도 → 안내 + [돌아가기]
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + 주소 검색값)
 */
export default function AiStyleScreen() {
  const { bfcacheId } = useRouter();
  const query = useSearchParams().toString();
  // 주소 문자열이 같으면 같은 객체 (다시 그려져도 불러오기가 다시 돌지 않게)
  const params = useMemo(() => readNewEssayParams(new URLSearchParams(query)), [query]);
  const regen = useMemo(() => readRegenParams(new URLSearchParams(query)), [query]);
  return <AiStyle key={`${bfcacheId}:${query}`} params={params} regen={regen} />;
}

function AiStyle({ params, regen }: { params: NewEssayParams; regen: { essayId: string; base: RegenBaseParam | null } | null }) {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [info, setInfo] = useState<NewInfo | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [infoOpen, setInfoOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [style, setStyle] = useState<Style | null>(null);
  const [length, setLength] = useState<EssayLength | null>(null);
  const [phase, setPhase] = useState<Phase>("choose");

  /** 처음 누를 때 하나, [다시 시도]에도 같은 값 */
  const saveToken = useRef<string | null>(null);
  const eventSent = useRef(false);
  /** 제안이 없어졌으면(404) 제안 없이 보낸다 */
  const dropSuggestion = useRef(false);

  // 만드는 동안 뒤로가기를 막는다 (가로채고 아무것도 하지 않음)
  const { leave } = useLeaveGuard({ dirty: phase === "making", onBlocked: () => {} });

  /* ---------- 열기 ---------- */

  useEffect(() => {
    let cancelled = false;
    if (regen) {
      // 다시 만들기: 보던 글의 문체·길이를 미리 고른다
      void (async () => {
        let preset: { style: Style | null; length: EssayLength | null } | null = null;
        if (regen.base && "request" in regen.base) {
          const r = getRegenResult(regen.essayId, regen.base.request);
          if (r) preset = { style: r.style, length: r.length };
        } else if (regen.base && "version" in regen.base) {
          const res = await getEssay(regen.essayId);
          if (!res.ok) {
            if (cancelled || goOnboardingIfNeeded(res.error)) return;
            if (res.error.code === "essay_not_found") {
              toast("글을 찾을 수 없어요");
              router.replace(routes.library);
              return;
            }
          } else {
            const versionId = regen.base.version;
            const v = res.data.versions.find((x) => x.id === versionId);
            if (v) preset = { style: v.style, length: v.length };
          }
        }
        if (cancelled) return;
        if (preset?.style) setStyle(preset.style);
        if (preset?.length) setLength(preset.length);
        setInfo({ materialIds: [], materialTitles: [], direction: null, suggestionId: null });
      })();
      return () => {
        cancelled = true;
      };
    }

    void Promise.all([getMaterialBox(), params.s ? getSuggestion(params.s) : Promise.resolve(null)]).then(([box, sg]) => {
      if (cancelled) return;
      if (!box.ok) {
        if (!goOnboardingIfNeeded(box.error)) setLoadFailed(true);
        return;
      }
      const byId = new Map(box.data.materials.map((m) => [m.id, m]));
      const usable = params.m.filter((id) => byId.has(id));
      setInfo({
        materialIds: usable,
        materialTitles: usable.map((id) => byId.get(id)?.title?.trim() || "(제목 없음)"),
        direction: sg && sg.ok ? sg.data.direction : null,
        suggestionId: sg && sg.ok ? sg.data.id : null,
      });
      setLoadFailed(false);
    });
    return () => {
      cancelled = true;
    };
  }, [params, regen, attempt, goOnboardingIfNeeded, router, toast]);

  /* ---------- 만들기 ---------- */

  const handleFailure = (error: ApiError, regenMode: boolean) => {
    if (goOnboardingIfNeeded(error)) return;
    if (error.code === "daily_limit") {
      setPhase("limit");
      return;
    }
    if (error.code === "material_not_available") {
      toast("삭제된 소재가 있어요. 소재를 다시 골라 주세요");
      router.replace(newEssayHref(routes.newDirection, params));
      return;
    }
    if (regenMode && error.code === "no_result") {
      toast("이전 결과가 사라졌어요");
      router.replace(draftResultHref(routes.draftResult, regen!.essayId));
      return;
    }
    if (error.code === "essay_not_found") {
      toast("글을 찾을 수 없어요");
      router.replace(routes.library);
      return;
    }
    if (error.code === "version_not_found") {
      toast("이전 결과가 사라졌어요");
      router.replace(routes.essay(regen!.essayId));
      return;
    }
    setPhase("failed"); // AI 실패(502)·시간 초과·연결 → [다시 시도]
  };

  const make = async () => {
    if (!style || !length || !info || phase === "making") return;
    setPhase("making");

    if (regen) {
      if (!regen.base) return handleFailure({ kind: "conflict", code: "no_result", message: "" }, true);
      const base: RegenerateBase = "version" in regen.base ? { based_on_version_id: regen.base.version } : { based_on_request_id: regen.base.request };
      const res = await regenerateEssay(regen.essayId, base, style, length);
      if (res.ok) {
        putRegenResult(res.data);
        leave(draftRegenerateHref(routes.draftRegenerate, res.data.essay_id, res.data.request_id));
        return;
      }
      return handleFailure(res.error, true);
    }

    // 처음 누를 때만: 이벤트(24번)·save_token
    if (!eventSent.current) {
      eventSent.current = true;
      void logEvent("writing_started", writingStartedProps("ai", { s: info.suggestionId, from: params.from }, info.materialIds.length));
    }
    saveToken.current ??= newSaveToken();
    const send = () =>
      createAiDraft({
        material_ids: info.materialIds,
        direction: dropSuggestion.current ? null : info.direction,
        style,
        length,
        suggestion_id: dropSuggestion.current ? null : info.suggestionId,
        save_token: saveToken.current!,
      });
    let res = await send();
    // 제안이 없어졌으면 제안 없이 같은 토큰으로 한 번 더
    if (!res.ok && res.error.code === "suggestion_not_found" && !dropSuggestion.current) {
      dropSuggestion.current = true;
      res = await send();
    }
    if (res.ok) {
      leave(draftResultHref(routes.draftResult, res.data.id));
      return;
    }
    handleFailure(res.error, false);
  };

  /* ---------- 화면 ---------- */

  const regenMode = regen !== null;

  if (phase === "making") {
    return (
      <div className="fixed inset-y-0 left-1/2 z-40 flex w-full max-w-(--app-max-width) -translate-x-1/2 flex-col items-center justify-center gap-4 bg-surface px-6 text-center" role="status" aria-live="polite">
        <Spinner className="size-9" />
        <p className="text-[15px] font-semibold">{regenMode ? "다시 쓰고 있어요…" : "소재를 엮어 글을 쓰고 있어요…"}</p>
      </div>
    );
  }

  const header = <ScreenHeader title={regenMode ? "다시 만들기" : "AI 초안"} back />;

  if (phase === "limit") {
    return (
      <>
        {header}
        <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-[15px] font-semibold">{LIMIT_MESSAGE}</p>
          <Button variant="secondary" onClick={() => router.back()}>
            돌아가기
          </Button>
        </section>
      </>
    );
  }

  if (loadFailed && !info) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!info) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  if (!regenMode && info.materialIds.length === 0) {
    return (
      <>
        {header}
        <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-[15px] font-semibold">소재를 1개 이상 골라 주세요</p>
          <Button variant="secondary" onClick={() => router.replace(newEssayHref(routes.newSelect, params))}>
            소재 고르기
          </Button>
        </section>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex flex-col gap-6 px-5 pt-4 pb-4">
        {/* 단계 표시 */}
        <ol className="flex items-center gap-2 text-sm">
          <StepBadge no={1} label="문체" active={step === 1} done={step === 2} />
          <span aria-hidden className="h-px w-6 bg-line" />
          <StepBadge no={2} label="길이" active={step === 2} done={false} />
        </ol>

        {regenMode ? (
          <p className="rounded-xl bg-subtle px-4 py-3 text-sm text-ink-soft">처음 고른 소재로 다시 만들어요</p>
        ) : (
          <section className="rounded-xl bg-subtle px-4 py-3 text-sm">
            <button type="button" aria-expanded={infoOpen} onClick={() => setInfoOpen((o) => !o)} className="flex w-full items-center justify-between font-semibold">
              고른 소재 {info.materialIds.length}개 · 방향 {info.direction ? "있음" : "없음"}
              <span aria-hidden>{infoOpen ? "▴" : "▾"}</span>
            </button>
            {infoOpen && (
              <div className="mt-2 flex flex-col gap-1 leading-relaxed text-ink-soft">
                <p>{info.materialTitles.join(" · ")}</p>
                {info.direction && <p>방향: {info.direction}</p>}
              </div>
            )}
          </section>
        )}

        {phase === "failed" && (
          <RetryNotice message={regenMode ? "다시 만들지 못했어요" : "에세이를 만들지 못했어요"} onRetry={() => void make()} />
        )}

        {step === 1 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">어떤 느낌으로 써볼까요?</h2>
            {STYLES.map((s) => (
              <OptionCard key={s.value} title={s.value} description={s.description} selected={style === s.value} onClick={() => setStyle(s.value)} />
            ))}
          </section>
        ) : (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">얼마나 길게 쓸까요?</h2>
            {LENGTHS.map((l) => (
              <OptionCard key={l.value} title={l.label} description={l.description} selected={length === l.value} onClick={() => setLength(l.value)} />
            ))}
          </section>
        )}
      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        {step === 1 ? (
          <Button block size="lg" disabled={!style} onClick={() => setStep(2)}>
            다음
          </Button>
        ) : (
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <Button variant="secondary" size="lg" onClick={() => setStep(1)}>
              이전
            </Button>
            <Button size="lg" disabled={!style || !length} onClick={() => void make()}>
              {regenMode ? "다시 만들기" : "에세이 만들기"}
            </Button>
          </div>
        )}
      </BottomActionBar>
    </>
  );
}

function StepBadge({ no, label, active, done }: { no: number; label: string; active: boolean; done: boolean }) {
  return (
    <li className={`flex items-center gap-1.5 ${active ? "font-bold text-ink" : "text-ink-mute"}`} aria-current={active ? "step" : undefined}>
      <span
        className={`flex size-6 items-center justify-center rounded-full text-xs ${
          active ? "bg-primary text-white" : done ? "bg-primary-soft text-primary" : "bg-subtle"
        }`}
      >
        {no}
      </span>
      {label}
    </li>
  );
}

function OptionCard({ title, description, selected, onClick }: { title: string; description: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex flex-col items-start gap-1 rounded-2xl border px-4 py-4 text-left ${
        selected ? "border-primary bg-primary-soft/40" : "border-line active:bg-subtle"
      }`}
    >
      <span className="text-base font-bold">{title}</span>
      <span className="text-sm text-ink-soft">{description}</span>
    </button>
  );
}
