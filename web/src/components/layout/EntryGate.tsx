"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loading, RetryNotice } from "@/components/ui";
import { getMe, hasSession } from "@/lib/api";
import { routes } from "@/lib/routes";
import { needsOnboarding } from "@/lib/useOnboardingRedirect";

type GateState = "checking" | "ready" | "failed";
type EntryResult = "ready" | "onboarding" | "failed";

/** 판단만 한다 (화면 상태는 바꾸지 않음) */
async function checkEntry(): Promise<EntryResult> {
  if (!(await hasSession())) return "onboarding";
  const res = await getMe();
  if (res.ok) return "ready";
  return needsOnboarding(res.error) ? "onboarding" : "failed";
}

/**
 * 첫 화면 확인 (목록 19번 ②). 홈을 보여 주기 전에 시작할 수 있는 사용자인지 본다.
 * 1. hasSession() false → O110 (서버를 부르지 않음)
 * 2. getMe()
 *    · ok → 홈(children)
 *    · unauthorized·not_consented → O110
 *    · 그 밖(network·timeout·server) → '연결이 불안정해요' + [다시 시도]. 세션은 그대로
 * 확인하는 동안·O110으로 넘어가는 동안은 화면 전체(하단 탭 포함)를 가려 홈이 먼저 보이지 않게 한다.
 */
export default function EntryGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<GateState>("checking");
  const [retrying, setRetrying] = useState(false);

  const apply = useCallback(
    (result: EntryResult) => {
      if (result === "onboarding") router.replace(routes.onboarding);
      else setState(result);
    },
    [router],
  );

  useEffect(() => {
    let cancelled = false;
    void checkEntry().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const retry = async () => {
    setRetrying(true);
    apply(await checkEntry());
    setRetrying(false);
  };

  if (state === "ready") return <>{children}</>;

  return (
    <div className="fixed inset-y-0 left-1/2 z-40 flex w-full max-w-(--app-max-width) -translate-x-1/2 flex-col bg-surface">
      {state === "checking" ? (
        <Loading fullScreen />
      ) : (
        <div className="flex flex-1 flex-col justify-center px-5">
          <RetryNotice message="연결이 불안정해요" onRetry={retry} retrying={retrying} />
        </div>
      )}
    </div>
  );
}
