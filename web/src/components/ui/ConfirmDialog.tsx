"use client";

import { useId } from "react";
import { Button } from "./Button";
import { Overlay } from "./Overlay";
import { useBackToClose } from "./useBackToClose";

export type DialogAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

/**
 * 확인 팝업. 예) 나가기 확인(W113·W211), 기록 삭제(M132), 모든 기록 지우기(S120), 임시 저장됨(W111)
 * - 버튼 2개: 가로 / 3개 이상: 세로로 쌓음
 * - 뒤로가기나 바깥을 누르면 onClose (dismissible=false면 바깥 누름은 무시)
 * - 버튼을 누르면 팝업을 닫은 뒤 그 버튼의 onClick을 부른다.
 *   다른 화면으로 가는 버튼은 onClick 대신 navigateTo를 쓴다.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  actions,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  actions: (DialogAction | (Omit<DialogAction, "onClick"> & { navigateTo: string }))[];
  dismissible?: boolean;
}) {
  const { close, closeAndGo } = useBackToClose(open, onClose);
  const titleId = useId();

  if (!open) return null;

  const stacked = actions.length > 2;

  return (
    <Overlay align="center" onBackdropClick={dismissible ? close : undefined}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-[17px] font-bold leading-snug">
          {title}
        </h2>
        {description && <div className="mt-2 text-sm leading-relaxed text-ink-soft">{description}</div>}
        <div
          className={`mt-5 ${
            stacked ? "flex flex-col gap-2" : actions.length === 1 ? "grid grid-cols-1" : "grid grid-cols-2 gap-2"
          }`}
        >
          {actions.map((action) => (
            <Button
              key={action.label}
              variant={action.variant ?? "secondary"}
              block
              onClick={() => {
                if ("navigateTo" in action) {
                  closeAndGo(action.navigateTo);
                } else {
                  close();
                  action.onClick();
                }
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
