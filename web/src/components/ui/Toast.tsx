"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

/**
 * 짧은 알림. 예) '복사했어요'(L123), '질문을 바꾸지 못했어요'(W210)
 * 사용: const toast = useToast(); toast('복사했어요');
 */
type ToastFn = (message: string) => void;

const ToastContext = createContext<ToastFn | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback<ToastFn>((next) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(next);
    timerRef.current = setTimeout(() => setMessage(null), 2200);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        // 하단 탭(3.5rem)·아래 고정 버튼 줄(약 4.5rem) 어느 쪽에도 겹치지 않는 높이
        className="pointer-events-none fixed bottom-[calc(6rem+env(safe-area-inset-bottom)+var(--keyboard-inset))] left-1/2 z-[60] w-full max-w-(--app-max-width) -translate-x-1/2 px-5"
      >
        {message && (
          <div className="mx-auto w-fit max-w-full rounded-xl bg-ink/90 px-4 py-3 text-center text-sm text-white shadow-lg">
            {message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast는 ToastProvider 안에서만 쓸 수 있어요");
  return ctx;
}
