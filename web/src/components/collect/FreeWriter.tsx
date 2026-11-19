"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  getFreeDraft,
  logEvent,
  newSaveToken,
  saveFreeDraft,
  saveFreeRecord,
  type ApiResult,
  type RecordItem,
} from "@/lib/api";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { useLeaveGuard } from "./useLeaveGuard";

/** B records.py: 제목 최대 100자(선택, 빈 값은 null), 본문 최대 20,000자 */
export const TITLE_MAX = 100;
export const BODY_MAX = 20_000;

type Phase = "loading" | "ready" | "loadFailed";
type Snapshot = { title: string; body: string };
type ExitChoice = "saveAndLeave" | "leave" | null;

const EMPTY: Snapshot = { title: "", body: "" };

/** 제목은 비우면 null로 보낸다 */
const titleOrNull = (title: string) => (title.trim() ? title : null);

/**
 * W110 자유롭게 기록하기 + W111 임시 저장됨(토스트 '임시 저장했어요', 목록 18번) + W113 나가기 확인 (UI 설계서 v7 7쪽)
 * - ?resume=draft: getFreeDraft()로 채우고 그 record_id를 기억 (없으면 빈 화면 + '이어 쓸 기록이 없어요')
 * - [임시 저장]: 성공하면 받은 id를 기억하고 '임시 저장했어요' 토스트. 404 draft_not_found면 record_id 없이 한 번 더
 * - [소재로 저장]: 열 때 만든 save_token으로 저장 → M120. 실패하면 입력 유지 + [다시 시도](같은 save_token, 목록 17번 ⑨)
 * - 뒤로가기(헤더·브라우저·휴대폰): 마지막 임시 저장 뒤 바뀐 게 있으면 W113, 없으면 바로 나감
 * - 기록 시작 이벤트: 화면에 들어올 때마다 1번 (목록 23·24번)
 *
 * 새로 들어올 때마다 처음부터 시작한다 (key = bfcacheId + resume).
 * cacheComponents는 다녀온 화면의 state를 남겨 두므로(Activity), key가 없으면 H121 [아니오]로 와도
 * 전에 불러온 내용이 그대로 보인다. 브라우저 뒤로·앞으로 가기에서는 보존된다.
 */
export default function FreeWriterScreen() {
  const { bfcacheId } = useRouter();
  const resume = useSearchParams().get("resume") === "draft";
  return <FreeWriter key={`${bfcacheId}:${resume ? "draft" : "new"}`} resume={resume} />;
}

function FreeWriter({ resume }: { resume: boolean }) {
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [phase, setPhase] = useState<Phase>(resume ? "loading" : "ready");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  /** 마지막으로 서버에 임시 저장된(또는 불러온) 내용 → 바뀜 여부 */
  const [saved, setSaved] = useState<Snapshot>(EMPTY);
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingRecord, setSavingRecord] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);

  /** 이어 쓰는 임시 저장 id (임시 저장 성공 때마다 갱신) */
  const recordId = useRef<string | null>(null);
  /** 화면을 열 때 한 번 만든다. [다시 시도]도 같은 값 */
  const [saveToken] = useState(newSaveToken);
  /** 요청 하나만 (다시 그려지기 전의 빠른 두 번째 누름도 막음) */
  const busy = useRef(false);
  /** W113에서 고른 것. 팝업이 다 닫힌 뒤(뒤로가기 기록 정리 뒤) 실행 */
  const exitChoice = useRef<ExitChoice>(null);
  const eventLogged = useRef(false);

  const dirty = phase === "ready" && (title !== saved.title || body !== saved.body);
  const { leave } = useLeaveGuard({ dirty, onBlocked: () => setExitOpen(true) });

  /* ---------- 이어 쓰기 불러오기 ---------- */

  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (!resume) return;
    let cancelled = false;
    void getFreeDraft().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        if (!goOnboardingIfNeeded(res.error)) setPhase("loadFailed");
        return;
      }
      if (res.data) {
        recordId.current = res.data.id;
        const snap = { title: res.data.title ?? "", body: res.data.body ?? "" };
        setTitle(snap.title);
        setBody(snap.body);
        setSaved(snap);
      } else {
        toast("이어 쓸 기록이 없어요");
      }
      setPhase("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [resume, loadAttempt, goOnboardingIfNeeded, toast]);

  /* ---------- 기록 시작 이벤트 (23·24번) ---------- */

  // 화면이 준비되면 1번. 재렌더링·개발 모드 이중 실행에도 1번 (ref는 그대로 남음). 결과는 기다리지 않음
  useEffect(() => {
    if (phase !== "ready" || eventLogged.current) return;
    eventLogged.current = true;
    void logEvent(
      "record_started",
      recordId.current ? { record_type: "free", record_id: recordId.current } : { record_type: "free" },
    );
  }, [phase]);

  /* ---------- 임시 저장 ---------- */

  /** 임시 저장 요청. 이어 쓰던 기록이 사라졌으면(draft_not_found) record_id 없이 한 번 더 */
  const requestDraftSave = async (): Promise<ApiResult<RecordItem>> => {
    const input = { title: titleOrNull(title), body };
    let res = await saveFreeDraft({ ...input, ...(recordId.current ? { record_id: recordId.current } : {}) });
    if (!res.ok && res.error.code === "draft_not_found" && recordId.current) {
      recordId.current = null;
      res = await saveFreeDraft(input);
    }
    if (res.ok) {
      recordId.current = res.data.id;
      setSaved({ title, body });
    }
    return res;
  };

  /** 임시 저장. 성공 여부를 돌려준다 (실패 안내는 여기서) */
  const saveDraft = async (): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setSavingDraft(true);
    const res = await requestDraftSave();
    busy.current = false;
    setSavingDraft(false);
    if (res.ok) return true;
    if (!goOnboardingIfNeeded(res.error)) toast("임시 저장하지 못했어요");
    return false;
  };

  const onSaveDraftClick = async () => {
    if (await saveDraft()) toast("임시 저장했어요");
  };

  /* ---------- 소재로 저장 ---------- */

  const canSaveRecord = body.trim().length > 0;

  const saveRecord = async () => {
    if (busy.current || !canSaveRecord) return;
    busy.current = true;
    setSavingRecord(true);
    const input = { title: titleOrNull(title), body, save_token: saveToken };
    let res = await saveFreeRecord({ ...input, ...(recordId.current ? { record_id: recordId.current } : {}) });
    // 이어 쓰던 임시 저장이 사라졌으면 새 기록으로 (같은 save_token이라 중복 저장 없음)
    if (!res.ok && res.error.code === "draft_not_found" && recordId.current) {
      recordId.current = null;
      res = await saveFreeRecord(input);
    }
    if (res.ok) {
      // 저장 끝: 나가기 확인 없이 M120으로 (busy는 풀지 않음 → 이동하는 동안 막힘)
      leave(routes.materialReview(res.data.id));
      return;
    }
    busy.current = false;
    setSavingRecord(false);
    if (!goOnboardingIfNeeded(res.error)) setSaveFailed(true);
  };

  /* ---------- 나가기 (W113) ---------- */

  const onHeaderBack = () => {
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

  if (phase === "loading") return <Loading fullScreen />;

  if (phase === "loadFailed") {
    return (
      <>
        <ScreenHeader title="자유롭게 기록하기" back />
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

  const locked = savingRecord;

  return (
    <>
      <ScreenHeader
        title="자유롭게 기록하기"
        back
        onBack={onHeaderBack}
        right={
          <Button
            variant="ghost"
            className="h-9 px-3 text-sm"
            loading={savingDraft}
            disabled={locked}
            onClick={() => void onSaveDraftClick()}
          >
            임시 저장
          </Button>
        }
      />

      <div className="flex flex-1 flex-col px-5 pt-4">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX}
          disabled={locked}
          placeholder="제목 (선택)"
          aria-label="제목 (선택)"
          className="h-12 border-b border-line bg-transparent text-lg font-semibold outline-none placeholder:text-ink-mute disabled:opacity-60"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={BODY_MAX}
          disabled={locked}
          placeholder="떠오른 경험이나 생각을 자유롭게 적어 보세요"
          aria-label="본문"
          className="min-h-64 flex-1 resize-none bg-transparent py-4 text-[16px] leading-relaxed outline-none placeholder:text-ink-mute disabled:opacity-60"
        />
        {/* 공백 포함 글자 수 */}
        <p className="pb-4 text-right text-xs text-ink-mute" aria-live="polite">
          {body.length.toLocaleString()}자
        </p>
        {saveFailed && !savingRecord && (
          <div className="pb-4">
            <RetryNotice message="연결이 불안정해요" onRetry={() => void saveRecord()} />
          </div>
        )}
      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        <Button block size="lg" disabled={!canSaveRecord || savingDraft} loading={savingRecord} onClick={() => void saveRecord()}>
          소재로 저장
        </Button>
      </BottomActionBar>

      {/* W113 나가기 확인. 고른 동작은 팝업이 닫힌 뒤 onExitDialogClosed에서 실행 */}
      <ConfirmDialog
        open={exitOpen}
        onClose={() => void onExitDialogClosed()}
        title="기록을 그만할까요?"
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
