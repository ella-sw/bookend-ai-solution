"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { inExitChain, markTraversalHandled, openedByHistoryTraversal, skipBack, startExitChain } from "@/lib/navDirection";
import { hrefWithFlowId } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";

/**
 * 끝난 글쓰기 흐름 표시 (목록 7번). 이 탭의 sessionStorage에 둔다.
 * - newEssayDone:{f}: 새 글 흐름(f = 흐름 id, 주소의 ?f=)에서 글이 저장됨 (W310 초안 생성 · N140 첫 저장 성공)
 * - essayDetailSeen:{essayId}: 그 글의 글 상세(L120)를 열었음
 * 저장이 막힌 환경이면 이 탭 메모리에만 둔다.
 */
const DONE_PREFIX = "newEssayDone:";
const SEEN_PREFIX = "essayDetailSeen:";
const memory = new Set<string>();

function mark(key: string) {
  memory.add(key);
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // 메모리에만
  }
}

function has(key: string) {
  if (memory.has(key)) return true;
  try {
    return window.sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export const markNewEssayDone = (flowId: string) => mark(DONE_PREFIX + flowId);
export const isNewEssayDone = (flowId: string | null | undefined) => !!flowId && has(DONE_PREFIX + flowId);
export const markEssayDetailSeen = (essayId: string) => mark(SEEN_PREFIX + essayId);
export const isEssayDetailSeen = (essayId: string | null | undefined) => !!essayId && has(SEEN_PREFIX + essayId);

/** 모든 기록 지우기(S120) 뒤: 표시를 모두 지운다 */
export function clearFinishedFlowMarks() {
  memory.clear();
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(DONE_PREFIX) || key?.startsWith(SEEN_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // 무시
  }
}

/** 새 글 흐름 id (?f=). 주소에 붙으므로 짧게 */
export function newFlowId(): string {
  const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(16).slice(2);
  return raw.replace(/-/g, "").slice(0, 12);
}

/**
 * 흐름 첫 화면(N110·N130·N120): 주소에 흐름 id(f)가 없으면 만들어 붙인다 (replace, 방문 기록은 늘지 않음).
 * 그 뒤 화면들은 newEssayHref로 f를 그대로 넘긴다
 */
export function useEnsureFlowId(pathname: string, query: string) {
  const router = useRouter();
  useEffect(() => {
    const href = hrefWithFlowId(pathname, query, newFlowId());
    if (href) router.replace(href, { scroll: false });
  }, [pathname, query, router]);
}

/** 내 서재로 나간다. 다음 뒤로 가기는 남은 흐름 화면을 건너뛴다 (lib/navDirection.ts) */
export function useExitToLibrary() {
  const router = useRouter();
  return () => {
    startExitChain();
    router.replace(routes.library);
  };
}

/**
 * 뒤로/앞으로 가기로 열렸는데 이미 끝난 흐름 화면이면 내 서재(L110)로 보낸다.
 * 이미 내 서재로 나가는 중이면(그 뒤 또 뒤로 가기) 이 화면도 건너뛰고 한 칸 더 뒤로 간다.
 * push로 들어온 정상 이동은 막지 않는다. 화면에 들어올 때(뒤로 가기로 다시 보일 때 포함)마다 1번 본다.
 * 다른 effect(나가기 확인의 기록 쌓기 등)보다 먼저 돌도록 화면 컴포넌트의 맨 앞에서 부른다.
 */
export function useLeaveFinishedFlow(finished: () => boolean) {
  const router = useRouter();
  const finishedRef = useRef(finished);

  useEffect(() => {
    finishedRef.current = finished;
  });

  useEffect(() => {
    if (!openedByHistoryTraversal() || !finishedRef.current()) return;
    markTraversalHandled();
    if (inExitChain() && window.history.length > 1) {
      skipBack();
      return;
    }
    startExitChain();
    router.replace(routes.library);
  }, [router]);
}
