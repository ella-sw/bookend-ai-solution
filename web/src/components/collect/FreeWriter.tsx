"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, ConfirmDialog, Loading, RetryNotice, ScreenHeader, useToast } from "@/components/ui";
import { getFreeDraft, saveFreeDraft, type ApiResult, type RecordItem } from "@/lib/api";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/** B records.py: 제목 최대 100자(선택, 빈 값은 null), 본문 최대 20,000자 */
export const TITLE_MAX = 100;
export const BODY_MAX = 20_000;

type Phase = "loading" | "ready" | "loadFailed";
type Snapshot = { title: string; body: string };

const EMPTY: Snapshot = { title: "", body: "" };

/** 제목은 비우면 null로 보낸다 */
const titleOrNull = (title: string) => (title.trim() ? title : null);

/**
 * W110 자유롭게 기록하기 + W111 임시 저장됨 (UI 설계서 v7 7쪽)
 * - ?resume=draft: getFreeDraft()로 채우고 그 record_id를 기억 (없으면 빈 화면 + '이어 쓸 기록이 없어요')
 * - [임시 저장]: 성공하면 받은 id를 기억하고 W111. 404 draft_not_found면 record_id 없이 한 번 더
 */
export default function FreeWriter() {
  const resume = useSearchParams().get("resume") === "draft";
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [phase, setPhase] = useState<Phase>(resume ? "loading" : "ready");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  /** 마지막으로 서버에 임시 저장된(또는 불러온) 내용 */
  // 바뀜 여부(나가기 확인)에 쓴다 — 커밋 B
  const [, setSaved] = useState<Snapshot>(EMPTY);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSavedOpen, setDraftSavedOpen] = useState(false);

  /** 이어 쓰는 임시 저장 id (임시 저장 성공 때마다 갱신) */
  const recordId = useRef<string | null>(null);
  const busy = useRef(false);

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

  const saveDraft = async () => {
    if (busy.current) return;
    busy.current = true;
    setSavingDraft(true);
    const res = await requestDraftSave();
    busy.current = false;
    setSavingDraft(false);
    if (res.ok) {
      setDraftSavedOpen(true);
    } else if (!goOnboardingIfNeeded(res.error)) {
      toast("임시 저장하지 못했어요");
    }
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

  return (
    <>
      <ScreenHeader
        title="자유롭게 기록하기"
        back
        right={
          <Button variant="ghost" className="h-9 px-3 text-sm" loading={savingDraft} onClick={saveDraft}>
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
          placeholder="제목 (선택)"
          aria-label="제목 (선택)"
          className="h-12 border-b border-line bg-transparent text-lg font-semibold outline-none placeholder:text-ink-mute"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={BODY_MAX}
          placeholder="떠오른 경험이나 생각을 자유롭게 적어 보세요"
          aria-label="본문"
          className="min-h-64 flex-1 resize-none bg-transparent py-4 text-[16px] leading-relaxed outline-none placeholder:text-ink-mute"
        />
        {/* 공백 포함 글자 수 */}
        <p className="pb-4 text-right text-xs text-ink-mute" aria-live="polite">
          {body.length.toLocaleString()}자
        </p>
      </div>

      {/* W111 임시 저장됨 */}
      <ConfirmDialog
        open={draftSavedOpen}
        onClose={() => setDraftSavedOpen(false)}
        title="임시 저장됐습니다."
        actions={[{ label: "확인", variant: "primary", onClick: () => {} }]}
      />
    </>
  );
}
