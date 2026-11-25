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
  deleteEssay,
  deleteEssayVersion,
  ESSAY_RULES,
  getEssay,
  logEvent,
  newSaveToken,
  overwriteVersion,
  saveNewVersion,
  type ApiError,
  type Essay,
  type Version,
} from "@/lib/api";
import { markEssayDetailSeen, useExitToLibrary } from "@/lib/finishedFlow";
import { objectParticle } from "@/lib/format";
import { startExitChain } from "@/lib/navDirection";
import { regenStyleHref } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { ThreadsShare } from "./ThreadsShare";

type SaveAction = "overwrite" | "new";
type Snapshot = { title: string; body: string };

const titleOrNull = (title: string) => (title.trim() ? title.trim() : null);

/**
 * L120 글 상세 + L122 저장 방식 (UI 설계서 v7 25쪽, 목록 22·28번, B essays.py)
 * - 버전 칩(초안·v1·v2…), 처음엔 가장 최근 버전
 * - 사용한 소재 칩 → M130. 삭제된 소재는 '삭제된 소재'로 회색, 누를 수 없음 (22번)
 * - [직접 고치기] → 편집 → [완료] → L122: [새 버전으로 저장 (v{N})](주 버튼) / [덮어써서 저장] / [취소]
 *   save_token은 편집 시작 때 하나. 실패하면 고친 내용 유지 + '저장하지 못했어요' [다시 시도]
 *   편집 중 뒤로가기: 바뀐 게 있으면 '고친 내용은 저장되지 않아요'
 * - [다시 만들기] → W310 다시 만들기 모드 (보고 있는 버전 바탕)
 * - 헤더 오른쪽 [공유] [삭제] 아이콘 (편집 중엔 숨김). [공유] → L123 (보고 있는 버전)
 * - [삭제] → L121 '삭제 메뉴': [이 버전 삭제] / [글 삭제] (확인 뒤 → L110, 사용한 소재는 소재함에 남음)
 *   [이 버전 삭제] (B delete_version): 보고 있는 버전이 초안이거나 버전이 1개뿐이면 숨김.
 *   확인 '{label}을 지울까요?' → 성공하면 받은 글로 다시 그리고 남은 버전 중 가장 큰 번호를 고름 + '{label}을 지웠어요'.
 *   실패: version_not_deletable '이 버전은 지울 수 없어요' / version_not_found 다시 불러오기 + '이미 지운 버전이에요' /
 *   essay_not_found 등 공통 오류는 handleCommonError / 그 밖 '지우지 못했어요' 
 * - L123 (목록 2·13·15번): 보고 있는 버전의 제목 + 빈 줄 + 본문.
 *   순서: [복사] → [Threads에 공유] → [다른 앱으로 공유] → [닫기].
 *   [복사] 성공 → '복사했어요' + body_shared(copy). [Threads에 공유]는 제목 없이 본문만 공식 작성창에 전달한다.
 *   긴 글은 나눠 올리기. 작성창 열기·부분 복사는 기록하지 않는다.
 *   [다른 앱으로 공유]는 navigator.share가 있을 때만, 오류 없이 끝나면 body_shared(share_sheet).
 *   취소(AbortError)·실패는 기록하지 않음
 * - 헤더 [뒤로]는 항상 내 서재(L110)로 바꿔 간다 (replace). 편집 중이면 고친 게 있을 때 확인 뒤 (목록 7번)
 * - 열면 'essayDetailSeen:{essayId}' → 뒤로 가기로 이 글의 W330·W310(다시 만들기)·W340에 가면 내 서재로
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

  const exitToLibrary = useExitToLibrary();
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

  // L123 공유 · L121 삭제 메뉴 · 글 삭제
  const [deleteMenuOpen, setDeleteMenuOpen] = useState(false);
  const deleteChoice = useRef<"deleteVersion" | "delete" | null>(null);
  /** 지우기 확인 중인 버전 (메뉴를 연 때 보고 있던 것) */
  const [versionToDelete, setVersionToDelete] = useState<Version | null>(null);
  const versionDeleteChosen = useRef(false);
  const [deletingVersion, setDeletingVersion] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteChosen = useRef(false);
  const [deleting, setDeleting] = useState(false);

  /** 글이 없으면(삭제됨) 내 서재로. 처리했으면 true */
  const handleCommonError = useCallback(
    (error: ApiError) => {
      if (goOnboardingIfNeeded(error)) return true;
      if (error.code === "essay_not_found") {
        toast("이미 지운 글이에요");
        router.replace(routes.library);
        return true;
      }
      return false;
    },
    [goOnboardingIfNeeded, router, toast],
  );

  // 이 글의 글쓰기 흐름은 끝남 (목록 7번)
  useEffect(() => {
    markEssayDetailSeen(essayId);
  }, [essayId]);

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

  /* ---------- 공유 (L123) · 삭제 메뉴 (L121) · 글 삭제 ---------- */

  /** 헤더 [공유] → L123 */
  const openShare = () => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    setShareOpen(true);
  };

  /** 시트가 다 닫힌 뒤 고른 것을 연다 (다른 시트·팝업이 뒤로가기 기록과 엉키지 않게) */
  const onDeleteMenuClosed = () => {
    setDeleteMenuOpen(false);
    const choice = deleteChoice.current;
    deleteChoice.current = null;
    if (choice === "delete") setDeleteOpen(true);
    if (choice === "deleteVersion" && version) setVersionToDelete(version);
  };

  /** 공유할 내용: 보고 있는 버전의 제목 + 빈 줄 + 본문 */
  const shareText = () => (version ? [version.title?.trim(), version.body].filter(Boolean).join("\n\n") : "");

  /** [복사]: 누른 그 자리에서 바로 (브라우저는 사용자가 누른 직후에만 허용) */
  const copy = async (close: () => void) => {
    if (!essay) return;
    try {
      await navigator.clipboard.writeText(shareText());
      toast("복사했어요");
      void logEvent("body_shared", { essay_id: essay.id, share_method: "copy" });
    } catch {
      toast("복사하지 못했어요");
    }
    close();
  };

  /** [다른 앱으로 공유]: 휴대폰 기본 공유창. 오류 없이 끝났을 때만 기록 (취소·실패는 기록 안 함) */
  const share = async (close: () => void) => {
    if (!essay || !version) return;
    try {
      await navigator.share({ title: version.title?.trim() || undefined, text: shareText() });
      void logEvent("body_shared", { essay_id: essay.id, share_method: "share_sheet" });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) toast("공유하지 못했어요");
    }
    close();
  };

  /** L121 이 버전 삭제 */
  const removeVersion = async (target: Version) => {
    if (busy.current || !essay) return;
    busy.current = true;
    setDeletingVersion(true);
    const res = await deleteEssayVersion(essay.id, target.id);
    busy.current = false;
    setDeletingVersion(false);
    const name = `${target.label}${objectParticle(target.label)}`;
    if (res.ok) {
      setEssay(res.data);
      // 남은 버전 중 가장 큰 번호
      const latest = [...res.data.versions].sort((a, b) => b.version_no - a.version_no)[0];
      setVersionId(latest?.id ?? null);
      toast(`${name} 지웠어요`);
      return;
    }
    if (handleCommonError(res.error)) return;
    if (res.error.code === "version_not_deletable") {
      toast("이 버전은 지울 수 없어요");
      return;
    }
    if (res.error.code === "version_not_found") {
      toast("이미 지운 버전이에요");
      setVersionId(null); // 다시 불러오면 가장 최근 버전
      setAttempt((n) => n + 1);
      return;
    }
    toast("지우지 못했어요");
  };

  const removeEssay = async () => {
    if (busy.current || !essay) return;
    busy.current = true;
    setDeleting(true);
    const res = await deleteEssay(essay.id);
    busy.current = false;
    setDeleting(false);
    if (res.ok) {
      toast("글을 지웠어요");
      router.replace(routes.library);
      return;
    }
    if (handleCommonError(res.error)) return;
    toast("지우지 못했어요");
  };

  /** 편집을 그만두고 내 서재로 (나가기 확인의 기록도 걷어 낸다) */
  const leaveToLibrary = () => {
    startExitChain();
    leave(routes.library);
  };

  const requestExit = () => {
    if (dirty) setLeaveOpen(true);
    else leaveToLibrary();
  };

  /* ---------- 화면 ---------- */

  if (loadFailed && !essay) {
    return (
      <>
        <ScreenHeader title="글 상세" back onBack={exitToLibrary} />
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!essay || !version) {
    return (
      <>
        <ScreenHeader title="글 상세" back onBack={exitToLibrary} />
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
        <ScreenHeader
          title="글 상세"
          back
          onBack={exitToLibrary}
          right={
            <>
              <button
                type="button"
                aria-label="공유"
                onClick={openShare}
                className="flex size-10 items-center justify-center rounded-full text-ink active:bg-subtle"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 15V3" />
                  <path d="m7.5 7.5 4.5-4.5 4.5 4.5" />
                  <path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="삭제"
                disabled={deleting || deletingVersion}
                onClick={() => setDeleteMenuOpen(true)}
                className="flex size-10 items-center justify-center rounded-full text-ink active:bg-subtle disabled:opacity-40"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 7h16" />
                  <path d="M9 7V4.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V7" />
                  <path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              </button>
            </>
          }
        />
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
                v.id === version.id ? "border-primary bg-primary font-semibold text-white" : "border-line text-ink-soft active:bg-subtle"
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
              <h1 className="font-serif text-[22px] font-semibold leading-snug">{version.title?.trim() || "(제목 없음)"}</h1>
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
            {/* 되돌릴 수 있는 새 버전이 주 버튼, 이전 내용이 사라지는 덮어쓰기는 보조 (목록 19번) */}
            <Button
              block
              size="lg"
              onClick={() => {
                sheetChoice.current = "new";
                close();
              }}
            >
              새 버전으로 저장 (v{nextNo})
            </Button>
            <Button
              block
              size="lg"
              variant="secondary"
              onClick={() => {
                sheetChoice.current = "overwrite";
                close();
              }}
            >
              덮어써서 저장
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

      {/* L121 삭제 메뉴 */}
      <BottomSheet open={deleteMenuOpen} onClose={onDeleteMenuClosed} ariaLabel="삭제 메뉴">
        {({ close }) => (
          <div className="flex flex-col">
            {/* 초안이거나 버전이 1개뿐이면 지울 수 없음 (B version_not_deletable) → 숨김 */}
            {version.version_no !== 0 && essay.versions.length > 1 && (
              <button
                type="button"
                disabled={deletingVersion}
                onClick={() => {
                  deleteChoice.current = "deleteVersion";
                  close();
                }}
                className="flex h-13 items-center rounded-xl px-1 text-left text-[15px] text-danger active:bg-subtle disabled:opacity-40"
              >
                이 버전 삭제
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                deleteChoice.current = "delete";
                close();
              }}
              className="flex h-13 items-center rounded-xl px-1 text-left text-[15px] text-danger active:bg-subtle"
            >
              글 삭제
            </button>
            <p className="mt-1 px-1 text-xs text-ink-mute">사용한 소재는 소재함에 남아요</p>
          </div>
        )}
      </BottomSheet>

      {/* L123 공유 */}
      <BottomSheet open={shareOpen} onClose={() => setShareOpen(false)} title="공유하기">
        {({ close }) => (
          <div className="flex flex-col gap-2">
            <Button block size="lg" variant="secondary" onClick={() => void copy(close)}>
              복사
            </Button>
            <ThreadsShare key={version?.id} text={version?.body ?? ""} />
            {canShare && (
              <button
                type="button"
                onClick={() => void share(close)}
                className="flex flex-col items-center rounded-xl border border-line px-4 py-3 text-center active:bg-subtle"
              >
                <span className="text-[15px] font-semibold">다른 앱으로 공유</span>
                <span className="text-xs text-ink-mute">휴대폰 공유창에서 앱을 골라요</span>
              </button>
            )}
          </div>
        )}
      </BottomSheet>

      {/* 이 버전 삭제 확인 */}
      <ConfirmDialog
        open={versionToDelete !== null}
        onClose={() => {
          const target = versionToDelete;
          setVersionToDelete(null);
          if (versionDeleteChosen.current && target) {
            versionDeleteChosen.current = false;
            void removeVersion(target);
          }
        }}
        title={versionToDelete ? `${versionToDelete.label}${objectParticle(versionToDelete.label)} 지울까요?` : ""}
        description="이 버전만 지워지고 되돌릴 수 없어요."
        actions={[
          { label: "취소", onClick: () => (versionDeleteChosen.current = false) },
          { label: "삭제", variant: "danger", onClick: () => (versionDeleteChosen.current = true) },
        ]}
      />

      {/* 글 삭제 확인 */}
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          if (deleteChosen.current) {
            deleteChosen.current = false;
            void removeEssay();
          }
        }}
        title="글을 지울까요?"
        description="모든 버전이 지워지고 되돌릴 수 없어요. 사용한 소재는 소재함에 남아요."
        actions={[
          { label: "취소", onClick: () => (deleteChosen.current = false) },
          { label: "삭제", variant: "danger", onClick: () => (deleteChosen.current = true) },
        ]}
      />

      {/* 편집 중 나가기 확인 */}
      <ConfirmDialog
        open={leaveOpen}
        onClose={() => {
          setLeaveOpen(false);
          if (leaveChosen.current) {
            leaveChosen.current = false;
            leaveToLibrary();
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
