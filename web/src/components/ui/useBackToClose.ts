"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * 팝업·아래 시트용. 모바일 웹 공통 규칙 2:
 * "뒤로가기를 누르면 열린 팝업이 먼저 닫히고, 그다음 이전 화면으로 간다."
 *
 * 열릴 때 방문 기록을 하나 쌓고, 뒤로가기(popstate)가 오면 onClose를 부른다.
 * - close(): 버튼으로 닫을 때. 쌓은 기록을 되돌려(history.back) 뒤로가기와 같은 길로 닫는다.
 * - closeAndGo(href): 팝업 안에서 다른 화면으로 갈 때. 쌓은 기록을 새 화면으로 바꿔
 *   다음 뒤로가기가 팝업이 아니라 원래 화면으로 가게 한다.
 */
export function useBackToClose(open: boolean, onClose: () => void) {
  const router = useRouter();
  const onCloseRef = useRef(onClose);
  const pushedRef = useRef(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    window.history.pushState({ rowflowOverlay: true }, "");
    pushedRef.current = true;

    const onPopState = () => {
      if (!pushedRef.current) return;
      pushedRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [open]);

  const close = useCallback(() => {
    if (pushedRef.current) {
      window.history.back(); // popstate → onClose
    } else {
      onCloseRef.current();
    }
  }, []);

  const closeAndGo = useCallback(
    (href: string) => {
      const wasPushed = pushedRef.current;
      pushedRef.current = false;
      onCloseRef.current();
      if (wasPushed) router.replace(href);
      else router.push(href);
    },
    [router],
  );

  return { close, closeAndGo };
}
