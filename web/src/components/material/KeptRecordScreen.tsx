"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BottomActionBar,
  BottomActionBarSpacer,
  BottomSheet,
  Button,
  ConfirmDialog,
  Loading,
  RetryNotice,
  ScreenHeader,
  Tag,
  useToast,
} from "@/components/ui";
import {
  deleteRecord,
  getAnalysis,
  getOriginal,
  reanalyze,
  type AnalysisState,
  type ApiError,
  type Original,
} from "@/lib/api";
import { formatMonthDay, RECORD_TYPE_LABEL, titleOrPreview } from "@/lib/format";
import { collectRoutes, routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { OriginalText } from "./MaterialFields";

const LIMIT_MESSAGE = "오늘 사용할 수 있는 횟수를 다 썼어요";

type Loaded = { state: AnalysisState; original: Original };

/** 원문 앞부분 (제목이 없을 때) */
const previewOf = (o: Original) => (o.record_type === "free" ? (o.body ?? "") : o.messages.map((m) => m.answer).join(" "));

/**
 * M130 보관한 원본 (원본만 보관한 기록, UI 설계서 v7 15·16쪽, 목록 21·22번) + M132 기록 삭제
 * - 소재 상세 화면 모양을 다시 쓰고, 소재 정보·사용한 글 영역은 없다
 * - 상태: '원본만 보관' (분석 중이면 '분석 중', 후보가 있으면 '확인해 주세요')
 * - 버튼 (M120과 같은 규칙):
 *   · 분석 중·후보 있음 → [소재 확인하기] (M120)
 *   · 실패였던 원본 → [다시 분석] (→ M120에서 기다림) / [직접 정리하기] (M120 ?manual=1). 하루 한도면 다시 분석 막음
 *   · 소재 없음이었던 원본 → [새로 기록하기]/[새 대화 시작하기] (이 원본은 그대로 남음). [직접 정리하기]는 두지 않음 (21번)
 * - ⋯ → [기록 삭제] → M132 확인 → 소재함
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + recordId)
 */
export default function KeptRecordScreen({ recordId }: { recordId: string }) {
  const { bfcacheId } = useRouter();
  return <KeptRecord key={`${bfcacheId}:${recordId}`} recordId={recordId} />;
}

function KeptRecord({ recordId }: { recordId: string }) {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [limitHit, setLimitHit] = useState(false);
  const [acting, setActing] = useState<"reanalyze" | "delete" | null>(null);
  const busy = useRef(false);

  const [sheetOpen, setSheetOpen] = useState(false);
  const deleteFromSheet = useRef(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteChosen = useRef(false);

  /** 공통 오류: O110 / 기록 없음 → 소재함. 처리했으면 true */
  const handleCommonError = useCallback(
    (error: ApiError) => {
      if (goOnboardingIfNeeded(error)) return true;
      if (error.code === "record_not_found") {
        toast("기록을 찾을 수 없어요");
        router.replace(routes.materials);
        return true;
      }
      return false;
    },
    [goOnboardingIfNeeded, router, toast],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAnalysis(recordId), getOriginal(recordId)]).then(([state, original]) => {
      if (cancelled) return;
      if (!state.ok || !original.ok) {
        const error = !state.ok ? state.error : !original.ok ? original.error : null;
        if (!error || !handleCommonError(error)) setLoadFailed(true);
        return;
      }
      setData({ state: state.data, original: original.data });
      setLoadFailed(false);
    });
    return () => {
      cancelled = true;
    };
  }, [recordId, attempt, handleCommonError]);

  /** [다시 분석]: 시작하고 M120에서 기다린다 */
  const retryAnalysis = async () => {
    if (busy.current) return;
    busy.current = true;
    setActing("reanalyze");
    const res = await reanalyze(recordId);
    busy.current = false;
    setActing(null);
    if (res.ok) {
      router.push(routes.materialReview(recordId));
      return;
    }
    if (handleCommonError(res.error)) return;
    if (res.error.code === "daily_limit") {
      setLimitHit(true);
      toast(LIMIT_MESSAGE);
      return;
    }
    if (res.error.code === "cannot_reanalyze") {
      setAttempt((n) => n + 1); // 상태가 바뀜 → 다시 불러오기
      return;
    }
    toast("다시 분석하지 못했어요");
  };

  const removeRecord = async () => {
    if (busy.current) return;
    busy.current = true;
    setActing("delete");
    const res = await deleteRecord(recordId);
    busy.current = false;
    setActing(null);
    if (res.ok) {
      toast("기록을 지웠어요");
      router.replace(routes.materials);
      return;
    }
    if (handleCommonError(res.error)) return;
    toast(res.error.code === "material_confirmed" || res.error.code === "material_deleted" ? "이 기록은 지울 수 없어요" : "지우지 못했어요");
  };

  const header = (
    <ScreenHeader
      title="보관한 원본"
      back
      right={
        data ? (
          <button
            type="button"
            aria-label="더보기"
            onClick={() => setSheetOpen(true)}
            className="flex size-10 items-center justify-center rounded-full text-xl text-ink active:bg-subtle"
          >
            ⋯
          </button>
        ) : undefined
      }
    />
  );

  if (loadFailed && !data) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  const { state, original } = data;
  const status = state.analysis_status;
  const hasCandidate = !!state.material && !state.material.confirmed_at;
  const badge = status === "analyzing" ? "분석 중" : hasCandidate ? "확인해 주세요" : "원본만 보관";
  const pastResult = status === "failed" ? "분석 실패였음" : status === "empty" ? "소재 없음이었음" : null;
  const limit = state.daily_limit_reached || limitHit;

  return (
    <>
      {header}
      <div className="flex flex-col gap-6 px-5 pt-5 pb-4">
        <section className="flex flex-col gap-2">
          <div>
            <Tag tone={badge === "확인해 주세요" ? "accent" : "default"}>{badge}</Tag>
          </div>
          <h1 className="text-xl font-bold">{titleOrPreview(original.title, previewOf(original))}</h1>
          <p className="text-xs text-ink-mute">
            {[`${formatMonthDay(original.saved_at)} 저장`, RECORD_TYPE_LABEL[original.record_type], pastResult].filter(Boolean).join(" · ")}
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink-soft">원문 · 읽기 전용</h2>
          <div className="rounded-2xl border border-line px-4 py-3 text-sm leading-relaxed text-ink-soft">
            <OriginalText original={original} />
          </div>
        </section>

        {status === "failed" && limit && <p className="rounded-xl bg-subtle px-4 py-3 text-sm text-ink-soft">{LIMIT_MESSAGE}</p>}
      </div>

      <BottomActionBarSpacer height="8rem" />
      <BottomActionBar>
        <div className="flex flex-col gap-2">
          {(status === "analyzing" || hasCandidate) && (
            <Button block size="lg" onClick={() => router.push(routes.materialReview(recordId))}>
              소재 확인하기
            </Button>
          )}
          {status === "failed" && !hasCandidate && (
            <>
              <Button block size="lg" loading={acting === "reanalyze"} disabled={limit || acting !== null} onClick={() => void retryAnalysis()}>
                다시 분석
              </Button>
              <Button block variant="secondary" disabled={acting !== null} onClick={() => router.push(`${routes.materialReview(recordId)}?manual=1`)}>
                직접 정리하기
              </Button>
            </>
          )}
          {status === "empty" && (
            <Button
              block
              size="lg"
              onClick={() => router.push(original.record_type === "qna" ? collectRoutes.ai() : collectRoutes.free())}
            >
              {original.record_type === "qna" ? "새 대화 시작하기" : "새로 기록하기"}
            </Button>
          )}
        </div>
      </BottomActionBar>

      {/* 더보기: [기록 삭제]만. 시트가 닫힌 뒤 확인 창을 연다 */}
      <BottomSheet
        open={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          if (deleteFromSheet.current) {
            deleteFromSheet.current = false;
            setDeleteOpen(true);
          }
        }}
      >
        {({ close }) => (
          <button
            type="button"
            onClick={() => {
              deleteFromSheet.current = true;
              close();
            }}
            className="flex h-13 w-full items-center rounded-xl px-1 text-left text-[15px] text-danger active:bg-subtle"
          >
            기록 삭제
          </button>
        )}
      </BottomSheet>

      {/* M132 기록 삭제 확인 */}
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
        description="원본과 문답이 지워지고 되돌릴 수 없어요."
        actions={[
          { label: "취소", onClick: () => (deleteChosen.current = false) },
          { label: "지우기", variant: "danger", onClick: () => (deleteChosen.current = true) },
        ]}
      />
    </>
  );
}
