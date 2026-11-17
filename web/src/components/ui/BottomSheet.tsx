"use client";

import { useId } from "react";
import { Overlay } from "./Overlay";
import { useBackToClose } from "./useBackToClose";

type SheetControls = {
  /** 시트만 닫기 */
  close: () => void;
  /** 시트를 닫고 다른 화면으로 (뒤로가기 시 시트를 연 화면으로 돌아옴) */
  closeAndGo: (href: string) => void;
};

/**
 * 아래 시트. 예) 소재 모으기 방식 선택(H120), 더보기(M131·L121), 공유 창(L123)
 * children 자리에 함수를 주면 close / closeAndGo를 받아 쓸 수 있다.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  showCloseButton = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode | ((controls: SheetControls) => React.ReactNode);
  showCloseButton?: boolean;
}) {
  const controls = useBackToClose(open, onClose);
  const titleId = useId();

  if (!open) return null;

  return (
    <Overlay align="bottom" onBackdropClick={controls.close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="pb-safe w-full rounded-t-3xl bg-surface px-5 pt-3 shadow-xl"
      >
        <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        {title && (
          <h2 id={titleId} className="mb-4 text-lg font-bold">
            {title}
          </h2>
        )}
        {typeof children === "function" ? children(controls) : children}
        {showCloseButton && (
          <button
            type="button"
            onClick={controls.close}
            className="mt-2 mb-3 h-12 w-full rounded-xl text-[15px] text-ink-soft active:bg-subtle"
          >
            닫기
          </button>
        )}
      </div>
    </Overlay>
  );
}
