"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, RetryNotice, ScreenHeader, Spinner, useToast } from "@/components/ui";
import { clearAllData } from "@/lib/api";
import { clearAllRegenResults } from "@/lib/regenResultStore";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/**
 * S110 설정 + S120 모든 기록 지우기 (UI 설계서 v7 27쪽, B DELETE /me/data)
 * - 기록 보관 안내, 이용약관·개인정보 처리방침 ('준비 중이에요', O110 [자세히 보기]와 같음)
 * - [모든 기록 지우기] → 확인 → clearAllData → 이 탭의 다시 만들기 결과도 비움 → '모든 기록을 지웠어요' + 홈
 *   실패 → '지우지 못했어요' + [다시 시도]. 요청 중 막음. 익명 사용자(세션)·동의는 그대로
 */
export default function SettingsPage() {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const clearChosen = useRef(false);
  const [clearing, setClearing] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);

  const clearAll = async () => {
    if (busy.current) return;
    busy.current = true;
    setClearing(true);
    setFailed(false);
    const res = await clearAllData();
    busy.current = false;
    setClearing(false);
    if (res.ok) {
      clearAllRegenResults();
      toast("모든 기록을 지웠어요");
      router.replace(routes.home);
      return;
    }
    if (!goOnboardingIfNeeded(res.error)) setFailed(true);
  };

  return (
    <>
      <ScreenHeader title="설정" />

      <section className="px-5 pt-4">
        <div className="rounded-2xl bg-subtle p-4 text-sm leading-relaxed text-ink-soft">
          이 브라우저로 내 기록을 찾아요.
          <br />
          1달 동안 접속하지 않거나 브라우저 데이터를 지우면 다시 볼 수 없어요.
        </div>
      </section>

      <ul className="mt-4 divide-y divide-line border-y border-line">
        <SettingsRow label="이용약관" onClick={() => toast("준비 중이에요")} />
        <SettingsRow label="개인정보 처리방침" onClick={() => toast("준비 중이에요")} />
        <SettingsRow label="모든 기록 지우기" danger busy={clearing} onClick={() => setConfirmOpen(true)} />
      </ul>

      {failed && !clearing && (
        <div className="px-5 pt-4">
          <RetryNotice message="지우지 못했어요" onRetry={() => void clearAll()} />
        </div>
      )}

      {/* S120 모든 기록 지우기 확인. 고른 뒤 팝업이 다 닫히면 지운다 */}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
          if (clearChosen.current) {
            clearChosen.current = false;
            void clearAll();
          }
        }}
        title="모든 기록을 지울까요?"
        description="소재·글·대화·임시 저장이 모두 지워지고 되돌릴 수 없어요."
        actions={[
          { label: "취소", onClick: () => (clearChosen.current = false) },
          { label: "지우기", variant: "danger", onClick: () => (clearChosen.current = true) },
        ]}
      />
    </>
  );
}

function SettingsRow({ label, onClick, danger, busy }: { label: string; onClick: () => void; danger?: boolean; busy?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-busy={busy || undefined}
        className={`flex h-14 w-full items-center justify-between px-5 text-left text-[15px] active:bg-subtle disabled:opacity-60 ${
          danger ? "text-danger" : "text-ink"
        }`}
      >
        {label}
        {busy ? (
          <Spinner className="size-4" />
        ) : (
          <span aria-hidden className="text-ink-mute">
            ›
          </span>
        )}
      </button>
    </li>
  );
}
