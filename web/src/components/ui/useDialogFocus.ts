"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** 지금 열려 있는 팝업 (맨 위 것만 Esc를 받는다) */
const openStack: object[] = [];

/**
 * 팝업·아래 시트의 포커스 (BottomSheet·ConfirmDialog가 쓴다)
 * - 열 때: 안의 첫 버튼으로 포커스 (버튼이 없으면 제목 → 그것도 없으면 상자). 열기 전 포커스를 기억
 * - 열린 동안: Tab / Shift+Tab이 안에서만 돈다
 * - Esc: onEscape (맨 위 팝업만). onEscape가 없으면 아무것도 하지 않음
 * - 닫을 때: 열기 전에 포커스가 있던 요소로 돌려준다 (그 요소가 아직 화면에 있으면)
 * 반환한 ref를 상자(role="dialog"/"alertdialog") 요소에 단다.
 */
export function useDialogFocus<T extends HTMLElement>(open: boolean, onEscape?: () => void) {
  const ref = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!open) return;
    const box = ref.current;
    if (!box) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = {};
    openStack.push(token);

    // 열 때: 첫 버튼 → 제목 → 상자
    const first = box.querySelector<HTMLElement>("button:not([disabled])");
    const heading = box.querySelector<HTMLElement>("h1, h2, h3");
    const target = first ?? heading ?? box;
    if (target !== first && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== token) return;
      if (e.key === "Escape") {
        if (onEscapeRef.current) {
          e.preventDefault();
          onEscapeRef.current();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        box.focus({ preventScroll: true });
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && box.contains(active);
      if (e.shiftKey && (active === firstItem || !inside)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !inside)) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const i = openStack.indexOf(token);
      if (i >= 0) openStack.splice(i, 1);
      // 닫을 때: 열기 전 요소로 (다른 화면으로 넘어가 사라졌으면 그대로 둠)
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  return ref;
}
