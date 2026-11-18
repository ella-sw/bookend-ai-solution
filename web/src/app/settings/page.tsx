"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { useToast } from "@/components/ui/Toast";

/**
 * S110 설정 (0단계: 최소 화면)
 * - 실제 '모든 기록 지우기'(S120 동작)는 6단계에서 연결
 * - 약관 화면은 아직 없음
 */
export default function SettingsPage() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toast = useToast();

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
        <SettingsRow label="모든 기록 지우기" danger onClick={() => setConfirmOpen(true)} />
      </ul>

      {/* S120 모든 기록 지우기 확인 */}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="모든 기록을 지울까요?"
        // 화면 문구는 설계서 그림 기준. 실제로 지우는 범위(AI 요청 기록·이용 기록 포함)는 6단계 API에서 처리
        description="소재·글·대화·임시 저장이 모두 지워지고 되돌릴 수 없어요."
        actions={[
          { label: "취소", onClick: () => {} },
          { label: "지우기", variant: "danger", onClick: () => toast("목업: 실제 지우기는 6단계에서 연결해요") },
        ]}
      />
    </>
  );
}

function SettingsRow({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex h-14 w-full items-center justify-between px-5 text-left text-[15px] active:bg-subtle ${
          danger ? "text-danger" : "text-ink"
        }`}
      >
        {label}
        <span aria-hidden className="text-ink-mute">
          ›
        </span>
      </button>
    </li>
  );
}
