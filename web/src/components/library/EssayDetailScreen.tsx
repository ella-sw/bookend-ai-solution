"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LENGTH_LABEL } from "@/components/aiDraft/EssayView";
import { useLeaveGuard } from "@/components/collect/useLeaveGuard";
import {
  BottomActionBar,
  BottomActionBarSpacer,
  BottomSheet,
  Button,
  ConfirmDialog,
  Loading,
  RetryNotice,
  ScreenHeader,
  useToast,
} from "@/components/ui";
import {
  ESSAY_RULES,
  getEssay,
  newSaveToken,
  overwriteVersion,
  saveNewVersion,
  type ApiError,
  type Essay,
  type Version,
} from "@/lib/api";
import { regenStyleHref } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

type SaveAction = "overwrite" | "new";
type Snapshot = { title: string; body: string };

const titleOrNull = (title: string) => (title.trim() ? title.trim() : null);

/**
 * L120 글 상세 + L122 저장 방식 (UI 설계서 v7 25쪽, 목록 22·28번, B essays.py)
 * - 버전 칩(초안·v1·v2…), 처음엔 가장 최근 버전
 * - 사용한 소재 칩 → M130. 삭제된 소재는 '삭제된 소재'로 회색, 누를 수 없음 (22번)
 * - [직접 고치기] → 편집 → [완료] → L122: [저장 후 덮어쓰기] / [새 버전으로 저장 (v{N})] / [취소]
 *   save_token은 편집 시작 때 하나. 실패하면 고친 내용 유지 + '저장하지 못했어요' [다시 시도]
 *   편집 중 뒤로가기: 바뀐 게 있으면 '고친 내용은 저장되지 않아요'
 * - [다시 만들기] → W310 다시 만들기 모드 (보고 있는 버전 바탕)
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + essayId)
 */
export default function EssayDetailScreen({ essayId }: { essayId: string }) {
  const { bfcacheId } = useRouter();
  return <EssayDetail key={`${bfcacheId}:${essayId}`} essayId={essayId} />;
}

function EssayDetail({ essayId }: { essayId: string }) {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [essay, setEssay] = useState<Essay | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [versionId, setVersionId] = useState<string | null>(null);

  // 편집
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [original, setOriginal] = useState<Snapshot>({ title: "", body: "" });
  const saveToken = useRef<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetChoice = useRef<SaveAction | null>(null);
  const [saving, setSaving] = useState(false);
  /** 실패한 저장 (다시 시도 때 같은 방식으로) */
  const [failedAction, setFailedAction] = useState<SaveAction | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const leaveChosen = useRef(false);
  const busy = useRef(false);

  /** 글이 없으면(삭제됨) 내 서재로. 처리했으면 true */
  const handleCommonError = useCallback(
    (error: ApiError) => {
      if (goOnboardingIfNeeded(error)) return true;
      if (error.code === "essay_not_found") {
        toast("이미 삭제한 글이에요");
        router.replace(routes.library);
        return true;
      }
      return false;
    },
    [goOnboardingIfNeeded, router, toast],
  );

  useEffect(() => {
    let cancelled = false;
    void getEssay(essayId).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setEssay(res.data);
        setVersionId((id) => id ?? res.data.versions[res.data.versions.length - 1]?.id ?? null);
        setLoadFailed(false);
      } else if (!handleCommonError(res.error)) {
        setLoadFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [essayId, attempt, handleCommonError]);

  const version: Version | undefined = essay?.versions.find((v) => v.id === versionId) ?? essay?.versions[essay.versions.length - 1];
  const dirty = editing && (title !== original.title || body !== original.body);
  const { leave } = useLeaveGuard({ dirty, onBlocked: () => setLeaveOpen(true) });

  /* ---------- 편집 ---------- */

  const startEdit = () => {
    if (!version) return;
    const snap = { title: version.title ?? "", body: version.body };
    setTitle(snap.title);
    setBody(snap.body);
    setOriginal(snap);
    saveToken.current = newSaveToken(); // 편집 시작 때 하나 ([다시 시도]도 같은 값)
    setFailedAction(null);
    setEditing(true);
  };

  const save = async (action: SaveAction) => {
    if (busy.current || !essay || !version || !body.trim()) return;
    busy.current = true;
    setSaving(true);
    setFailedAction(null);
    const res =
      action === "overwrite"
        ? await overwriteVersion(essay.id, version.id, { title: titleOrNull(title), body })
        : await saveNewVersion(essay.id, {
            title: titleOrNull(title),
            body,
            based_on_version_id: version.id,
            save_token: saveToken.current ?? newSaveToken(),
          });
    busy.current = false;
    setSaving(false);
    if (res.ok) {
      setEssay(res.data);
      // 덮어쓰면 같은 버전, 새 버전이면 가장 최근 버전을 보여 준다
      setVersionId(action === "overwrite" ? version.id : (res.data.versions[res.data.versions.length - 1]?.id ?? null));
      setEditing(false);
      toast(action === "overwrite" ? "덮어썼어요" : "새 버전으로 저장했어요");
      return;
    }
    if (handleCommonError(res.error)) return;
    if (res.error.code === "version_not_found") {
      toast("고치던 버전이 없어졌어요. 새 버전으로 저장해 주세요");
    }
    setFailedAction(action);
  };

  /** L122 시트가 다 닫힌 뒤 고른 저장을 한다 */
  const onSheetClosed = () => {
    setSheetOpen(false);
    const choice = sheetChoice.current;
    sheetChoice.current = null;
    if (choice) void save(choice);
  };

  const requestExit = () => {
    if (dirty) setLeaveOpen(true);
    else leave();
  };

  /* ---------- 화면 ---------- */

  if (loadFailed && !essay) {
    return (
      <>
        <ScreenHeader title="글 상세" back />
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!essay || !version) {
    return (
      <>
        <ScreenHeader title="글 상세" back />
        <Loading fullScreen />
      </>
    );
  }

  const nextNo = Math.max(0, ...essay.versions.map((v) => v.version_no)) + 1;

  return (
    <>
      {editing ? (
        <ScreenHeader
          title="고치는 중"
          back
          onBack={requestExit}
          right={
            <Button className="h-9 px-3 text-sm" disabled={!body.trim()} loading={saving} onClick={() => setSheetOpen(true)}>
              완료
            </Button>
          }
        />
      ) : (
        <ScreenHeader title="글 상세" back />
      )}

      <div className="flex flex-1 flex-col gap-5 px-5 pt-4 pb-4">
        {/* 버전 칩 */}
        <div className="-mx-5 flex gap-2 overflow-x-auto px-5 [scrollbar-width:none]" role="tablist" aria-label="버전">
          {essay.versions.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={v.id === version.id}
              disabled={editing}
              onClick={() => setVersionId(v.id)}
              className={`h-8 shrink-0 rounded-full border px-3 text-[13px] disabled:opacity-50 ${
                v.id === version.id ? "border-ink bg-ink font-semibold text-white" : "border-line text-ink-soft active:bg-subtle"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {/* 사용한 소재 (삭제된 소재는 누를 수 없음, 22번) */}
        {essay.materials.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {essay.materials.map((m) =>
              m.deleted ? (
                <span key={m.id} className="inline-flex h-7 items-center rounded-md bg-subtle px-2 text-xs text-ink-mute" aria-disabled>
                  삭제된 소재
                </span>
              ) : (
                <Link key={m.id} href={routes.material(m.id)} className="inline-flex h-7 items-center rounded-md bg-primary-soft px-2 text-xs text-primary active:brightness-95">
                  {m.title?.trim() || "(제목 없음)"}
                </Link>
              ),
            )}
          </div>
        )}

        {editing ? (
          <>
            <p className="text-sm font-semibold text-ink-soft">{version.label} 고치는 중</p>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={ESSAY_RULES.titleMax}
              disabled={saving}
              placeholder="제목"
              aria-label="제목"
              className="h-12 border-b border-line bg-transparent text-lg font-semibold outline-none placeholder:text-ink-mute disabled:opacity-60"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={ESSAY_RULES.bodyMax}
              disabled={saving}
              aria-label="본문"
              className="min-h-72 flex-1 resize-none bg-transparent text-[16px] leading-loose outline-none disabled:opacity-60"
            />
            <p className="text-right text-xs text-ink-mute">{body.length.toLocaleString()}자</p>
            {failedAction && !saving && (
              <RetryNotice message="저장하지 못했어요" onRetry={() => void save(failedAction)} />
            )}
          </>
        ) : (
          <>
            <article className="flex flex-col gap-3">
              <h1 className="text-xl font-bold leading-snug">{version.title?.trim() || "(제목 없음)"}</h1>
              <p className="text-xs text-ink-mute">
                {[version.style, version.length ? LENGTH_LABEL[version.length] : null, `${version.char_count.toLocaleString()}자`]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <p className="text-[16px] leading-loose whitespace-pre-wrap">{version.body}</p>
            </article>
          </>
        )}
      </div>

      {!editing && (
        <>
          <BottomActionBarSpacer />
          <BottomActionBar>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="lg" onClick={startEdit}>
                직접 고치기
              </Button>
              <Button size="lg" onClick={() => router.push(regenStyleHref(routes.newAiStyle, essay.id, { version: version.id }))}>
                다시 만들기
              </Button>
            </div>
          </BottomActionBar>
        </>
      )}

      {/* L122 저장 방식 선택 */}
      <BottomSheet open={sheetOpen} onClose={onSheetClosed} title="어떻게 저장할까요?" showCloseButton={false}>
        {({ close }) => (
          <div className="flex flex-col gap-2 pb-3">
            <p className="-mt-2 mb-2 text-sm text-ink-soft">덮어쓰면 {version.label}의 이전 내용은 남지 않아요.</p>
            <Button
              block
              size="lg"
              onClick={() => {
                sheetChoice.current = "overwrite";
                close();
              }}
            >
              저장 후 덮어쓰기
            </Button>
            <Button
              block
              size="lg"
              variant="secondary"
              onClick={() => {
                sheetChoice.current = "new";
                close();
              }}
            >
              새 버전으로 저장 (v{nextNo})
            </Button>
            <Button
              block
              variant="ghost"
              onClick={() => {
                sheetChoice.current = null;
                close();
              }}
            >
              취소
            </Button>
          </div>
        )}
      </BottomSheet>

      {/* 편집 중 나가기 확인 */}
      <ConfirmDialog
        open={leaveOpen}
        onClose={() => {
          setLeaveOpen(false);
          if (leaveChosen.current) {
            leaveChosen.current = false;
            leave();
          }
        }}
        title="고친 내용은 저장되지 않아요"
        description="나가면 고친 내용이 사라져요."
        actions={[
          { label: "계속 고치기", onClick: () => (leaveChosen.current = false) },
          { label: "나가기", variant: "primary", onClick: () => (leaveChosen.current = true) },
        ]}
      />
    </>
  );
}
