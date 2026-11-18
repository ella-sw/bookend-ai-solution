"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { routes } from "@/lib/routes";

const GUARD_KEY = "rowflowLeaveGuard";

const onGuardEntry = () => (window.history.state as Record<string, unknown> | null)?.[GUARD_KEY] === true;

/**
 * 나가기 확인용 뒤로가기 가로채기 (W113·W211 등. 모바일 웹 공통 규칙 2)
 * - dirty가 되면 방문 기록에 '가드'를 하나 쌓는다. 그 상태에서 뒤로가기(브라우저·휴대폰)를 누르면
 *   가드를 다시 쌓고 onBlocked()를 부른다 → 화면이 나가기 확인 팝업을 연다
 * - dirty가 아니면 뒤로가기는 그대로 나간다 (팝업 없음)
 * - 팝업(useBackToClose)이 닫혀 가드로 돌아온 경우는 무시한다
 * - leave(to?): 가드를 걷고 나간다. to가 있으면 그 화면으로 바꾸고, 없으면 이전 화면으로
 *   (이전 화면이 없으면 홈)
 * Next 앱 라우터가 pushState를 감싸 내부 상태(__NA)를 가드에도 복사하므로, 가드로 돌아와도 새로고침되지 않는다.
 */
export function useLeaveGuard({ dirty, onBlocked }: { dirty: boolean; onBlocked: () => void }) {
  const router = useRouter();
  const pushed = useRef(false);
  /** 나가는 중이면 가는 곳 (null = 이전 화면) */
  const leaving = useRef<{ to: string | null } | null>(null);
  const mounted = useRef(true);
  const dirtyRef = useRef(dirty);
  const onBlockedRef = useRef(onBlocked);

  useEffect(() => {
    dirtyRef.current = dirty;
    onBlockedRef.current = onBlocked;
  });

  const pushGuard = useCallback(() => {
    window.history.pushState({ [GUARD_KEY]: true }, "");
    pushed.current = true;
  }, []);

  /** 이전 화면으로. 앱 안에 이전 화면이 없어 그대로 남아 있으면 홈으로 */
  const goBackOrHome = useCallback(() => {
    window.history.back();
    setTimeout(() => {
      if (mounted.current) router.replace(routes.home);
    }, 500);
  }, [router]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (dirty && !pushed.current && !leaving.current) pushGuard();
  }, [dirty, pushGuard]);

  useEffect(() => {
    const onPopState = () => {
      if (onGuardEntry()) return; // 팝업이 닫혀 가드로 돌아옴
      if (!pushed.current) return; // 가드가 없으면 그대로 이동
      pushed.current = false;

      const exit = leaving.current;
      if (exit) {
        leaving.current = null;
        if (exit.to) router.replace(exit.to);
        else goBackOrHome();
        return;
      }
      if (dirtyRef.current) {
        pushGuard();
        onBlockedRef.current();
        return;
      }
      goBackOrHome();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [router, pushGuard, goBackOrHome]);

  const leave = useCallback(
    (to?: string) => {
      if (pushed.current) {
        leaving.current = { to: to ?? null };
        window.history.back(); // → popstate에서 이어서 이동
        return;
      }
      if (to) router.replace(to);
      else goBackOrHome();
    },
    [router, goBackOrHome],
  );

  return { leave };
}
