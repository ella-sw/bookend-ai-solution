"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLeaveGuard } from "@/components/collect/useLeaveGuard";
import {
  BottomActionBar,
  BottomActionBarSpacer,
  Button,
  ConfirmDialog,
  Loading,
  RetryNotice,
  ScreenHeader,
  useToast,
} from "@/components/ui";
import {
  ESSAY_RULES,
  getEssayDraft,
  getMaterialBox,
  getSuggestion,
  logEvent,
  newSaveToken,
  saveEssay,
  saveEssayDraft,
  type ApiResult,
  type EssayDraft,
  type SaveEssayDraftInput,
} from "@/lib/api";
import { isNewEssayDone, markNewEssayDone, useLeaveFinishedFlow } from "@/lib/finishedFlow";
import { readNewEssayParams, writingStartedProps, type NewEssayParams } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

type Snapshot = { title: string; body: string };
type ExitChoice = "saveAndLeave" | "leave" | null;

/** 참고 칸·저장에 쓰는 값 (이어 쓰기면 임시 저장의 값, 새로 쓰면 주소의 m·s) */
interface Context {
  essayId: string | null;
  /** 저장에 넘길 소재 id (고른 순서, 삭제된 소재 제외) */
  materialIds: string[];
  /** 참고 칸에 보일 소재 제목 */
  materialTitles: string[];
  suggestionId: string | null;
  title: string;
  body: string;
}

const titleOrNull = (title: string) => (title.trim() ? title : null);

/** 처음 열 때 값 모으기 */
async function loadContext(params: NewEssayParams, resume: boolean): Promise<{ ok: true; ctx: Context; notice?: string } | { ok: false; res: ApiResult<unknown> }> {
  if (resume) {
    const draft = await getEssayDraft();
    if (!draft.ok) return { ok: false, res: draft };
    if (draft.data) return { ok: true, ctx: fromDraft(draft.data) };
    // 이어 쓸 글이 없으면 소재 없이 새로 (지금 고른 값은 주소에 없음)
    return { ok: true, ctx: emptyContext(), notice: "이어 쓸 글이 없어요" };
  }
  if (params.m.length === 0 && !params.s) return { ok: true, ctx: emptyContext() };
  const [box, sg] = await Promise.all([getMaterialBox(), params.s ? getSuggestion(params.s) : Promise.resolve(null)]);
  if (!box.ok) return { ok: false, res: box };
  const byId = new Map(box.data.materials.map((m) => [m.id, m]));
  const usable = params.m.filter((id) => byId.has(id));
  return {
    ok: true,
    ctx: {
      essayId: null,
      materialIds: usable,
      materialTitles: usable.map((id) => byId.get(id)?.title?.trim() || "(제목 없음)"),
      suggestionId: sg && sg.ok ? sg.data.id : null,
      title: "",
      body: "",
    },
    notice: usable.length !== params.m.length ? "삭제된 소재는 뺐어요" : undefined,
  };
}

const emptyContext = (): Context => ({ essayId: null, materialIds: [], materialTitles: [], suggestionId: null, title: "", body: "" });

function fromDraft(d: EssayDraft): Context {
  const live = d.materials.filter((m) => !m.deleted);
  return {
    essayId: d.id,
    materialIds: live.map((m) => m.id),
    materialTitles: live.map((m) => m.title?.trim() || "(제목 없음)"),
    suggestionId: d.suggestion_id,
    title: d.title ?? "",
    body: d.body,
  };
}

/**
 * N140 직접 쓰기 (UI 설계서 v7 20쪽, B essays.py draft·first_save)
 * - 참고 소재 칸(접힘 ▾): 고른 소재 제목. 소재 없이 왔으면 없음 (direction은 보내지 않음, 11/24)
 * - 제목(100자, 선택)·본문(20,000자)·글자 수(본문만, 공백 포함)
 * - 열 때 save_token 하나. ?resume=draft면 임시 저장을 이어서 (그 essay_id 기억)
 * - [임시 저장] → '임시 저장했어요' 토스트. 404 draft_not_found면 essay_id 없이 한 번 더
 * - [저장] → v1 → L120. draft_not_found면 essay_id 없이 같은 토큰으로 다시, material_not_available은 안내,
 *   그 밖의 실패는 입력 유지 + [다시 시도](같은 토큰)
 * - 나가기 확인 (useLeaveGuard): 바뀐 게 없으면 바로 나감
 * - 들어올 때마다 1번 writing_started (write_mode = direct, entry_path = from)
 * - 첫 저장 성공 → 'newEssayDone:{f}' (목록 7번). 새로 쓰기(resume 아님)를 뒤로 가기로 다시 열었는데 그 흐름이 끝났으면 내 서재로
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + 주소 검색값)
 */
export default function DirectWriterScreen() {
  const { bfcacheId } = useRouter();
  const query = useSearchParams().toString();
  // 주소 문자열이 같으면 같은 객체 (다시 그려져도 불러오기가 다시 돌지 않게)
  const params = useMemo(() => readNewEssayParams(new URLSearchParams(query)), [query]);
  const resume = new URLSearchParams(query).get("resume") === "draft";
  return <DirectWriter key={`${bfcacheId}:${query}`} params={params} resume={resume} />;
}

function DirectWriter({ params, resume }: { params: NewEssayParams; resume: boolean }) {
  useLeaveFinishedFlow(() => !resume && isNewEssayDone(params.f));
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [ctx, setCtx] = useState<Context | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState<Snapshot>({ title: "", body: "" });
  const [refOpen, setRefOpen] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingEssay, setSavingEssay] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);

  /** 이어 쓰는 임시 저장 id (임시 저장 성공 때마다 갱신) */
  const essayId = useRef<string | null>(null);
  /** 열 때 한 번. [다시 시도]도 같은 값 */
  const [saveToken] = useState(newSaveToken);
  const busy = useRef(false);
  const exitChoice = useRef<ExitChoice>(null);
  const eventLogged = useRef(false);

  const ready = ctx !== null;
  const dirty = ready && (title !== saved.title || body !== saved.body);
  const { leave } = useLeaveGuard({ dirty, onBlocked: () => setExitOpen(true) });

  /* ---------- 열기 ---------- */

  useEffect(() => {
    let cancelled = false;
    void loadContext(params, resume).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        const error = result.res.ok ? null : result.res.error;
        if (!error || !goOnboardingIfNeeded(error)) setLoadFailed(true);
        return;
      }
      essayId.current = result.ctx.essayId;
      setCtx(result.ctx);
      setTitle(result.ctx.title);
      setBody(result.ctx.body);
      setSaved({ title: result.ctx.title, body: result.ctx.body });
      setLoadFailed(false);
      if (result.notice) toast(result.notice);
    });
    return () => {
      cancelled = true;
    };
  }, [params, resume, attempt, goOnboardingIfNeeded, toast]);

  // 들어올 때마다 1번 (목록 24번). 결과는 기다리지 않음
  useEffect(() => {
    if (!ctx || eventLogged.current) return;
    eventLogged.current = true;
    void logEvent("writing_started", writingStartedProps("direct", { s: ctx.suggestionId, from: params.from }, ctx.materialIds.length));
  }, [ctx, params.from]);

  /* ---------- 임시 저장 ---------- */

  const draftInput = (): SaveEssayDraftInput => ({
    title: titleOrNull(title),
    body,
    material_ids: ctx?.materialIds ?? [],
    suggestion_id: ctx?.suggestionId ?? null,
  });

  const saveDraft = async (): Promise<boolean> => {
    if (busy.current || !ctx) return false;
    busy.current = true;
    setSavingDraft(true);
    const sent: Snapshot = { title, body }; // 보낸 내용 (요청 중에 더 쓴 것은 바뀐 것으로 남김)
    const input = draftInput();
    let res = await saveEssayDraft({ ...input, essay_id: essayId.current });
    if (!res.ok && res.error.code === "draft_not_found" && essayId.current) {
      essayId.current = null;
      res = await saveEssayDraft(input);
    }
    busy.current = false;
    setSavingDraft(false);
    if (res.ok) {
      essayId.current = res.data.id;
      setSaved(sent);
      return true;
    }
    if (goOnboardingIfNeeded(res.error)) return false;
    toast(res.error.code === "material_not_available" ? "삭제된 소재가 있어요. 소재를 다시 골라 주세요" : "임시 저장하지 못했어요");
    return false;
  };

  /* ---------- 저장 → v1 ---------- */

  const canSave = body.trim().length > 0;

  const saveFinal = async () => {
    if (busy.current || !ctx || !canSave) return;
    busy.current = true;
    setSavingEssay(true);
    setSaveFailed(false);
    const input = { ...draftInput(), save_token: saveToken };
    let res = await saveEssay({ ...input, essay_id: essayId.current });
    // 이어 쓰던 임시 저장이 사라졌으면 새 글로 (같은 save_token이라 중복 저장 없음)
    if (!res.ok && res.error.code === "draft_not_found" && essayId.current) {
      essayId.current = null;
      res = await saveEssay(input);
    }
    if (res.ok) {
      if (params.f) markNewEssayDone(params.f);
      leave(routes.essay(res.data.id)); // 이동하는 동안 막힌 채로 둔다
      return;
    }
    busy.current = false;
    setSavingEssay(false);
    if (goOnboardingIfNeeded(res.error)) return;
    if (res.error.code === "material_not_available") {
      toast("삭제된 소재가 있어요. 소재를 다시 골라 주세요");
      return;
    }
    setSaveFailed(true);
  };

  /* ---------- 나가기 ---------- */

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
  };

  /* ---------- 화면 ---------- */

  if (loadFailed && !ctx) {
    return (
      <>
        <ScreenHeader title="직접 쓰기" back />
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!ctx) {
    return (
      <>
        <ScreenHeader title="직접 쓰기" back />
        <Loading fullScreen />
      </>
    );
  }

  const hasReference = ctx.materialTitles.length > 0;
  const locked = savingEssay;

  return (
    <>
      <ScreenHeader
        title="직접 쓰기"
        back
        onBack={requestExit}
        right={
          <Button variant="ghost" className="h-9 px-3 text-sm" loading={savingDraft} disabled={locked} onClick={async () => {
            if (await saveDraft()) toast("임시 저장했어요");
          }}>
            임시 저장
          </Button>
        }
      />

      <div className="flex flex-1 flex-col px-5 pt-4">
        {hasReference && (
          <section className="mb-3 rounded-xl bg-subtle px-4 py-3 text-sm">
            <button type="button" aria-expanded={refOpen} onClick={() => setRefOpen((o) => !o)} className="flex w-full items-center justify-between font-semibold">
              참고 소재 <span aria-hidden>{refOpen ? "▴" : "▾"}</span>
            </button>
            {refOpen && (
              <div className="mt-2 flex flex-col gap-1 leading-relaxed text-ink-soft">
                <p>{ctx.materialTitles.join(" · ")}</p>
              </div>
            )}
          </section>
        )}

        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={ESSAY_RULES.titleMax}
          disabled={locked}
          placeholder="제목"
          aria-label="제목"
          className="h-12 border-b border-line bg-transparent text-lg font-semibold outline-none placeholder:text-ink-mute disabled:opacity-60"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={ESSAY_RULES.bodyMax}
          disabled={locked}
          placeholder="떠오르는 대로 써 보세요"
          aria-label="본문"
          className="min-h-64 flex-1 resize-none bg-transparent py-4 text-[16px] leading-relaxed outline-none placeholder:text-ink-mute disabled:opacity-60"
        />
        {/* 본문만, 공백 포함 */}
        <p className="pb-4 text-right text-xs text-ink-mute" aria-live="polite">
          {body.length.toLocaleString()}자
        </p>
        {saveFailed && !savingEssay && (
          <div className="pb-4">
            <RetryNotice message="연결이 불안정해요" onRetry={() => void saveFinal()} />
          </div>
        )}
      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        <Button block size="lg" disabled={!canSave || savingDraft} loading={savingEssay} onClick={() => void saveFinal()}>
          저장
        </Button>
      </BottomActionBar>

      {/* 나가기 확인. 고른 동작은 팝업이 닫힌 뒤 실행 */}
      <ConfirmDialog
        open={exitOpen}
        onClose={() => void onExitDialogClosed()}
        title="글쓰기를 그만할까요?"
        description="임시 저장하지 않은 내용은 사라져요."
        actions={[
          { label: "임시 저장하고 나가기", variant: "primary", onClick: () => (exitChoice.current = "saveAndLeave") },
          { label: "저장하지 않고 나가기", onClick: () => (exitChoice.current = "leave") },
          { label: "계속 쓰기", variant: "ghost", onClick: () => (exitChoice.current = null) },
        ]}
      />
    </>
  );
}
