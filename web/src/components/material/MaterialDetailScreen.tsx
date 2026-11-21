"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BottomActionBar,
  BottomActionBarSpacer,
  BottomSheet,
  Button,
  ButtonLink,
  ConfirmDialog,
  Loading,
  RetryNotice,
  ScreenHeader,
  Spinner,
  Tag,
  useToast,
} from "@/components/ui";
import {
  ANALYSIS_POLL_MS,
  ANALYSIS_WAIT_MS,
  applyReanalysis,
  deleteMaterial,
  dismissReanalysis,
  editMaterial,
  getMaterial,
  reanalyzeMaterial,
  type ApiError,
  type ApiResult,
  type Candidate,
  type EditMaterialInput,
  type MaterialDetail,
} from "@/lib/api";
import { formatMonthDay, RECORD_TYPE_LABEL } from "@/lib/format";
import { newEssayHref } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { formOf, MaterialFields, OriginalText, sameForm, validate, type FieldErrors, type Form } from "./MaterialFields";
import { SheetItem } from "./RecordMenu";

const LIMIT_MESSAGE = "오늘 사용할 수 있는 횟수를 다 썼어요";

type SheetChoice = "edit" | "reanalyze" | "delete" | null;

/** ms만큼 기다린다. 그 사이 signal이 멈추면 true */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(true);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * M130 소재 상세 + M131 더보기 (UI 설계서 v7 14쪽, 목록 11·22번, B materials.py)
 * - 소재 정보 · 원문(읽기 전용) · 사용한 글 · [이 소재로 글쓰기]
 * - ⋯ → M131: [소재 정보 고치기](요약·키워드·주제만) / [다시 분석] / [소재 삭제]
 * - 소재 삭제 (B delete_material): 글(직접 쓰기 임시 저장 포함)에 쓴 소재는 숨기기만(원본 유지),
 *   안 쓴 소재는 원본 기록까지 지운다. record_deleted로 토스트를 나눈다
 * - 다시 분석: 소재는 그대로, 결과가 reanalysis에 온다. 분석 중이면 2.5초마다 다시 불러온다 (최대 75초, 나가면 멈춤).
 *   done → 나란히 [바꾸기]/[그대로 두기], empty·failed → '새 결과가 없어 그대로 두었어요' [확인].
 *   서버가 결과를 들고 있으므로 화면을 나갔다 와도 비교가 이어진다
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + materialId)
 */
export default function MaterialDetailScreen({ materialId }: { materialId: string }) {
  const { bfcacheId } = useRouter();
  return <MaterialDetailView key={`${bfcacheId}:${materialId}`} materialId={materialId} />;
}

function MaterialDetailView({ materialId }: { materialId: string }) {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** 다시 불러오기 (다시 분석을 시작한 뒤 등) */
  const [refreshKey, setRefreshKey] = useState(0);
  /** 다시 분석이 75초가 지나도 진행 중 */
  const [reSlow, setReSlow] = useState(false);

  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetChoice = useRef<SheetChoice>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteChosen = useRef(false);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(formOf(null));
  const [initialForm, setInitialForm] = useState<Form>(formOf(null));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [acting, setActing] = useState<"save" | "reanalyze" | "apply" | "dismiss" | "delete" | null>(null);
  const busy = useRef(false);

  /** 공통 오류: O110 / 삭제된 소재 → 소재함. 처리했으면 true */
  const handleCommonError = useCallback(
    (error: ApiError) => {
      if (goOnboardingIfNeeded(error)) return true;
      if (error.code === "material_not_found") {
        toast("이미 지운 소재예요");
        router.replace(routes.materials);
        return true;
      }
      return false;
    },
    [goOnboardingIfNeeded, router, toast],
  );

  /* ---------- 불러오기 (+ 다시 분석 중이면 이어서 확인) ---------- */

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const deadline = Date.now() + ANALYSIS_WAIT_MS;
      for (let first = true; ; first = false) {
        if (!first && (await sleep(ANALYSIS_POLL_MS, signal))) return;
        const res = await getMaterial(materialId);
        if (signal.aborted) return;
        if (!res.ok) {
          if (!handleCommonError(res.error)) setLoadFailed(true);
          return;
        }
        setDetail(res.data);
        setLoadFailed(false);
        if (res.data.reanalysis?.status !== "analyzing") {
          setReSlow(false);
          return;
        }
        if (Date.now() >= deadline) {
          setReSlow(true);
          return;
        }
      }
    })();
    return () => controller.abort(); // 화면을 나가면 멈춘다 (분석은 서버에서 계속)
  }, [materialId, refreshKey, handleCommonError]);

  /* ---------- 동작 ---------- */

  const run = async <T,>(kind: NonNullable<typeof acting>, fn: () => Promise<ApiResult<T>>) => {
    if (busy.current) return null;
    busy.current = true;
    setActing(kind);
    const res = await fn();
    busy.current = false;
    setActing(null);
    return res;
  };

  const startEdit = (d: MaterialDetail) => {
    const initial = formOf(d);
    setForm(initial);
    setInitialForm(initial);
    setErrors({});
    setEditing(true);
  };

  const saveEdit = async () => {
    const found = validate(form);
    delete found.title; // 제목은 고칠 수 없음
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    // 바뀐 칸만 보낸다
    const input: EditMaterialInput = {};
    if (form.summary.trim() !== initialForm.summary.trim()) input.summary = form.summary.trim();
    if (form.keywords.join("\n") !== initialForm.keywords.join("\n")) input.keywords = form.keywords;
    if ([...form.topics].sort().join(",") !== [...initialForm.topics].sort().join(",")) input.topics = form.topics;
    if (Object.keys(input).length === 0) {
      setEditing(false);
      return;
    }
    const res = await run("save", () => editMaterial(materialId, input));
    if (!res) return;
    if (res.ok && res.data) {
      setDetail(res.data);
      setEditing(false);
      toast("소재 정보를 고쳤어요");
      return;
    }
    if (res.ok || handleCommonError(res.error)) return;
    if (res.error.code === "unknown_topic") setErrors({ topics: "주제를 다시 골라 주세요" });
    else if (res.error.kind === "bad_request") setErrors({ form: "입력한 내용을 확인해 주세요" });
    else toast("고치지 못했어요");
  };

  const startReanalysis = async () => {
    const res = await run("reanalyze", () => reanalyzeMaterial(materialId));
    if (!res) return;
    if (res.ok && res.data) {
      setDetail(res.data);
      setRefreshKey((n) => n + 1); // 분석 중이면 이어서 확인
      return;
    }
    if (res.ok || handleCommonError(res.error)) return;
    toast(res.error.code === "daily_limit" ? LIMIT_MESSAGE : "다시 분석하지 못했어요");
  };

  /** [바꾸기] / [그대로 두기]·[확인] */
  const decide = async (kind: "apply" | "dismiss") => {
    const res = await run(kind, () => (kind === "apply" ? applyReanalysis(materialId) : dismissReanalysis(materialId)));
    if (!res) return;
    if (res.ok && res.data) {
      setDetail(res.data);
      if (kind === "apply") toast("새 결과로 바꿨어요");
      return;
    }
    if (res.ok || handleCommonError(res.error)) return;
    if (res.error.code === "no_result") {
      toast("바꿀 결과가 없어요");
      setRefreshKey((n) => n + 1);
      return;
    }
    toast("처리하지 못했어요");
  };

  const removeMaterial = async () => {
    const res = await run("delete", () => deleteMaterial(materialId));
    if (!res) return;
    if (res.ok) {
      toast(res.data.record_deleted ? "소재와 원본 기록을 지웠어요" : "소재를 지웠어요. 글에 쓴 원본은 남아 있어요");
      router.replace(routes.materials);
      return;
    }
    if (handleCommonError(res.error)) return;
    toast("지우지 못했어요");
  };

  /** M131 시트가 다 닫힌 뒤 고른 것을 한다 (팝업·화면 전환이 뒤로가기 기록과 엉키지 않게) */
  const onSheetClosed = () => {
    setSheetOpen(false);
    const choice = sheetChoice.current;
    sheetChoice.current = null;
    if (choice === "edit" && detail) startEdit(detail);
    if (choice === "reanalyze") void startReanalysis();
    if (choice === "delete") setDeleteOpen(true);
  };

  /* ---------- 화면 ---------- */

  const header = (
    <ScreenHeader
      title="소재 상세"
      back
      right={
        detail && !editing ? (
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

  if (loadFailed && !detail) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setRefreshKey((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!detail) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  const re = detail.reanalysis;

  return (
    <>
      {header}
      <div className="flex flex-col gap-7 px-5 pt-5 pb-4">
        {editing ? (
          <section className="flex flex-col gap-6">
            <MaterialFields form={form} setForm={setForm} errors={errors} disabled={acting === "save"} titleEditable={false} />
            {errors.form && <p className="text-sm text-danger">{errors.form}</p>}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" disabled={acting === "save"} onClick={() => setEditing(false)}>
                취소
              </Button>
              <Button loading={acting === "save"} disabled={sameForm(form, initialForm)} onClick={() => void saveEdit()}>
                저장
              </Button>
            </div>
          </section>
        ) : (
          <MaterialInfo detail={detail} />
        )}

        {re && !editing && (
          <ReanalysisPanel
            detail={detail}
            slow={reSlow}
            acting={acting}
            onApply={() => void decide("apply")}
            onDismiss={() => void decide("dismiss")}
          />
        )}

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink-soft">원문 · 읽기 전용</h2>
          <div className="rounded-2xl border border-line px-4 py-3 text-sm leading-relaxed text-ink-soft">
            <OriginalText original={detail.original} />
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink-soft">사용한 글 {detail.essays.length}편</h2>
          {detail.essays.length === 0 ? (
            <p className="text-sm text-ink-mute">아직 이 소재로 쓴 글이 없어요</p>
          ) : (
            <ul className="divide-y divide-line rounded-2xl border border-line">
              {detail.essays.map((e) => (
                <li key={e.id}>
                  <Link href={routes.essay(e.id)} className="flex items-center justify-between px-4 py-3 text-[15px] active:bg-subtle">
                    {e.title?.trim() || "(제목 없음)"}
                    <span aria-hidden className="text-ink-mute">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {!editing && (
        <>
          <BottomActionBarSpacer />
          <BottomActionBar>
            <ButtonLink href={newEssayHref(routes.newSelect, { m: [detail.id], from: "material_detail" })} block size="lg">
              이 소재로 글쓰기
            </ButtonLink>
          </BottomActionBar>
        </>
      )}

      {/* M131 더보기 */}
      <BottomSheet open={sheetOpen} onClose={onSheetClosed} ariaLabel="소재 메뉴">
        {({ close }) => (
          <div className="flex flex-col">
            <SheetItem
              label="소재 정보 고치기"
              onClick={() => {
                sheetChoice.current = "edit";
                close();
              }}
            />
            <SheetItem
              label="다시 분석"
              disabled={re?.status === "analyzing"}
              onClick={() => {
                sheetChoice.current = "reanalyze";
                close();
              }}
            />
            <SheetItem
              label="소재 삭제"
              danger
              onClick={() => {
                sheetChoice.current = "delete";
                close();
              }}
            />
            <p className="mt-2 px-1 text-xs text-ink-mute">글에 쓴 소재만 원본이 남아요</p>
          </div>
        )}
      </BottomSheet>

      {/* 소재 삭제 확인 (목록 22번) */}
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          if (deleteChosen.current) {
            deleteChosen.current = false;
            void removeMaterial();
          }
        }}
        title="소재를 지울까요?"
        description="글에 쓰지 않은 소재는 원본 기록까지 지워지고 되돌릴 수 없어요. 글에 쓴 소재는 소재만 지워지고 원본은 남아요."
        actions={[
          { label: "취소", onClick: () => (deleteChosen.current = false) },
          { label: "삭제", variant: "danger", onClick: () => (deleteChosen.current = true) },
        ]}
      />
    </>
  );
}

/* ---------- 소재 정보 ---------- */

function MaterialInfo({ detail }: { detail: MaterialDetail }) {
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-xl font-bold">{detail.title?.trim() || "(제목 없음)"}</h1>
      <p className="text-[15px] leading-relaxed text-ink">{detail.summary}</p>
      <TopicsAndKeywords topics={detail.topics.map((t) => t.name)} keywords={detail.keywords} />
      <p className="text-xs text-ink-mute">
        {formatMonthDay(detail.original.saved_at ?? detail.created_at)} 모음 · {RECORD_TYPE_LABEL[detail.original.record_type]}
      </p>
    </section>
  );
}

function TopicsAndKeywords({ topics, keywords }: { topics: string[]; keywords: string[] }) {
  if (topics.length === 0 && keywords.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {topics.map((t) => (
        <Tag key={t} tone="primary">
          {t}
        </Tag>
      ))}
      {keywords.map((k) => (
        <Tag key={k}>#{k}</Tag>
      ))}
    </div>
  );
}

/* ---------- 다시 분석 (목록 11번) ---------- */

function ReanalysisPanel({
  detail,
  slow,
  acting,
  onApply,
  onDismiss,
}: {
  detail: MaterialDetail;
  slow: boolean;
  acting: string | null;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const re = detail.reanalysis!;

  if (re.status === "analyzing") {
    return (
      <section className="flex items-center gap-3 rounded-2xl bg-subtle px-4 py-4 text-sm" role="status">
        <Spinner className="size-5" />
        {slow ? "아직 다시 분석하고 있어요. 나중에 다시 확인해 주세요." : "같은 원본으로 다시 분석하고 있어요…"}
      </section>
    );
  }

  if (re.status === "done" && re.result) {
    return (
      <section className="flex flex-col gap-3 rounded-2xl border border-primary/40 p-4">
        <p className="text-[15px] font-semibold">새 결과가 나왔어요. 바꿀까요?</p>
        <div className="grid grid-cols-2 gap-3">
          <CompareColumn label="지금 소재" summary={detail.summary} keywords={detail.keywords} topics={detail.topics.map((t) => t.name)} />
          <CompareColumn label="새 결과" result={re.result} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" loading={acting === "dismiss"} disabled={acting !== null} onClick={onDismiss}>
            그대로 두기
          </Button>
          <Button loading={acting === "apply"} disabled={acting !== null} onClick={onApply}>
            바꾸기
          </Button>
        </div>
      </section>
    );
  }

  // empty·failed: 기존 소재 유지
  return (
    <section className="flex items-center justify-between gap-3 rounded-2xl bg-subtle px-4 py-3 text-sm">
      <span>새 결과가 없어 그대로 두었어요</span>
      <Button variant="secondary" className="h-9 shrink-0 px-3 text-sm" loading={acting === "dismiss"} onClick={onDismiss}>
        확인
      </Button>
    </section>
  );
}

function CompareColumn({
  label,
  summary,
  keywords,
  topics,
  result,
}: {
  label: string;
  summary?: string | null;
  keywords?: string[];
  topics?: string[];
  result?: Candidate;
}) {
  const s = result ? result.summary : summary;
  const k = result ? result.keywords : (keywords ?? []);
  const t = result ? result.topics.map((x) => x.name) : (topics ?? []);
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-subtle p-3">
      <span className="text-xs font-semibold text-ink-mute">{label}</span>
      <p className="text-sm leading-relaxed">{s}</p>
      <TopicsAndKeywords topics={t} keywords={k} />
      {result?.evidence && <p className="text-xs leading-relaxed text-ink-soft">“{result.evidence}”</p>}
    </div>
  );
}
