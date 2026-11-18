"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ApiError } from "@/lib/api";
import { routes } from "@/lib/routes";

/**
 * 처음부터 다시 시작해야 하는 오류인가 (목록 19번)
 * - unauthorized: 세션이 없음 (없었거나 SDK가 지움)
 * - not_consented: 동의 전 (세션은 남아 있음 → O110에서 같은 사용자로 동의)
 */
export function needsOnboarding(error: ApiError): boolean {
  return error.kind === "unauthorized" || error.kind === "not_consented";
}

/**
 * 다른 화면에서 API 오류를 받았을 때 쓰는 공통 처리.
 * unauthorized·not_consented면 O110으로 보내고 true를 돌려준다 (화면은 다른 처리를 하지 않으면 됨).
 * 그 밖의 오류면 false → 화면이 RetryNotice 등으로 처리.
 *
 *   const goOnboardingIfNeeded = useOnboardingRedirect();
 *   if (!res.ok) { if (goOnboardingIfNeeded(res.error)) return; 실패 안내… }
 *
 * 각 화면 연결은 그 화면 개발 때 한다.
 */
export function useOnboardingRedirect() {
  const router = useRouter();
  return useCallback(
    (error: ApiError) => {
      if (!needsOnboarding(error)) return false;
      router.replace(routes.onboarding);
      return true;
    },
    [router],
  );
}
