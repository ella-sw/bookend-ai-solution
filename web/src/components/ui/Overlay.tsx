"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/** 팝업·아래 시트의 어두운 배경. 480px 틀 안에 맞춰 띄운다. */
export function Overlay({
  onBackdropClick,
  align,
  children,
}: {
  onBackdropClick?: () => void;
  align: "center" | "bottom";
  children: React.ReactNode;
}) {
  // 팝업이 열린 동안 뒤 화면 스크롤 막기
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div
      className={`fixed inset-y-0 left-1/2 z-50 flex w-full max-w-(--app-max-width) -translate-x-1/2 bg-black/40 ${
        align === "center" ? "items-center justify-center px-6" : "items-end"
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onBackdropClick?.();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
