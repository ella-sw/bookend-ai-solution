"use client";

import { useRef, useState } from "react";
import { BottomSheet, ConfirmDialog, Spinner, useToast } from "@/components/ui";
import { confirmTargets, decideCollect, resumeDialogCopy, type CollectKind } from "@/lib/collectEntry";
import type { IsoTime } from "@/lib/api";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

type SheetControls = { close: () => void; closeAndGo: (href: string) => void };

/**
 * H120 소재 모으기 방식 선택 + H121 이어 쓰기 확인 (UI 설계서 v7 6쪽, 목록 17번 ⑩·⑪)
 * - [자유롭게 기록하기]: 임시 저장 없음 → W110 새로 / 있음 → H121
 * - [AI 질문에 답하기]: 진행 중 대화 있음 → H121 없이 W210 이어서 / 없고 임시 저장 있음 → H121 / 둘 다 없음 → W210 새로
 * - 확인하는 동안 고른 버튼에 로딩, 다른 버튼은 막음. 시트를 닫으면 늦게 온 결과는 버린다
 * - 실패: unauthorized·not_consented → O110 / 그 밖 → 시트에 머물고 '연결이 불안정해요'
 *   (새로 시작으로 넘기지 않는다 → 임시 저장을 덮어쓰지 않게)
 * - H121은 시트가 다 닫힌 뒤(뒤로가기 기록 정리 뒤) 연다 → 팝업의 뒤로가기 기록과 엉키지 않게
 */
export function CollectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const [checking, setChecking] = useState<CollectKind | null>(null);
  const [confirm, setConfirm] = useState<{ kind: CollectKind; updatedAt: IsoTime } | null>(null);
  /** 시트가 닫히면 열 H121 */
  const confirmAfterClose = useRef<{ kind: CollectKind; updatedAt: IsoTime } | null>(null);
  /** 진행 중인 확인 번호. 시트를 닫으면 올려서 늦게 온 결과를 버린다 */
  const runId = useRef(0);
  /** 다시 그려지기 전의 빠른 두 번째 누름도 막는다 */
  const busy = useRef(false);

  const handleSheetClose = () => {
    runId.current += 1;
    busy.current = false;
    setChecking(null);
    onClose();
    if (confirmAfterClose.current) {
      setConfirm(confirmAfterClose.current);
      confirmAfterClose.current = null;
    }
  };

  const pick = async (kind: CollectKind, controls: SheetControls) => {
    if (busy.current) return;
    busy.current = true;
    const id = ++runId.current;
    setChecking(kind);

    const decision = await decideCollect(kind);
    if (id !== runId.current) return; // 그사이 시트를 닫음

    if (decision.type === "go") {
      controls.closeAndGo(decision.href);
      return;
    }
    if (decision.type === "confirm") {
      confirmAfterClose.current = { kind, updatedAt: decision.updatedAt };
      controls.close(); // 닫힘이 끝나면 handleSheetClose가 H121을 연다
      return;
    }
    busy.current = false;
    setChecking(null);
    if (!goOnboardingIfNeeded(decision.error)) toast("연결이 불안정해요");
  };

  const targets = confirm ? confirmTargets(confirm.kind) : null;
  const copy = resumeDialogCopy(confirm?.kind ?? "free", confirm?.updatedAt ?? null);

  return (
    <>
      <BottomSheet open={open} onClose={handleSheetClose} title="어떻게 모아볼까요?">
        {(controls) => (
          <div className="flex flex-col gap-2">
            <CollectOption
              title="자유롭게 기록하기"
              description="떠오른 일을 내가 직접 적어요"
              loading={checking === "free"}
              disabled={checking !== null}
              onClick={() => void pick("free", controls)}
            />
            <CollectOption
              title="AI 질문에 답하기"
              description="AI 질문에 답하며 기억을 꺼내요"
              loading={checking === "ai"}
              disabled={checking !== null}
              onClick={() => void pick("ai", controls)}
            />
          </div>
        )}
      </BottomSheet>

      {/* H121 이어 쓰기 확인. [새로 시작]은 임시 저장·진행 중 대화를 건드리지 않음 (⑪) */}
      <ConfirmDialog
        open={targets !== null}
        onClose={() => setConfirm(null)}
        title={copy.title}
        description={copy.description}
        actions={
          targets
            ? [
                { label: copy.freshLabel, navigateTo: targets.fresh },
                { label: copy.resumeLabel, variant: "primary", navigateTo: targets.resume },
              ]
            : []
        }
      />
    </>
  );
}

function CollectOption({
  title,
  description,
  loading,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={loading || undefined}
      className="flex items-center justify-between rounded-2xl border border-line px-4 py-4 text-left active:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 aria-busy:opacity-100"
    >
      <span>
        <span className="block text-[15px] font-semibold">{title}</span>
        <span className="text-sm text-ink-mute">{description}</span>
      </span>
      {loading ? (
        <Spinner className="size-5" />
      ) : (
        <span aria-hidden className="text-ink-mute">
          ›
        </span>
      )}
    </button>
  );
}
