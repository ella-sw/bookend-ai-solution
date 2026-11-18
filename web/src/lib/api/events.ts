import { request, type ApiResult } from "./client";
import type { EventName, EventProps } from "./types";

/**
 * 최소 사용 이벤트 기록 (B server/app/routers/events.py, 목록 23~27번).
 * - 화면이 보내는 이벤트는 5개뿐. 칸은 이벤트마다 정해져 있고 그 밖의 칸은 타입에서 막힌다 (서버도 422)
 * - 성공하면 204 빈 응답 → data = null
 * - 실패해도 다시 보내지 않는다 (목록 25번: 잃어버린 이벤트는 괜찮지만 두 번 기록되면 안 됨).
 *   401만 client.ts가 새 토큰으로 1회 다시 보낸다. 화면 흐름은 결과를 기다리지 않아도 된다
 * - 개발 중 로그는 이벤트 이름·응답 코드만 남긴다 (본문·토큰은 남기지 않음)
 *
 * body_shared (목록 13·15번): [복사] 성공 → share_method = "copy",
 * navigator.share()가 오류 없이 끝남 → "share_sheet". 취소(AbortError)·실패는 보내지 않는다.
 */
export async function logEvent<N extends EventName>(name: N, props: EventProps<N>): Promise<ApiResult<null>> {
  const res = await request<null>({ method: "POST", path: "/events", body: { name, ...props }, mock: { key: "events.log" } });
  if (process.env.NODE_ENV !== "production") {
    const code = res.ok ? 204 : (res.error.status ?? res.error.kind);
    console.debug(`[event] ${name} ${code}`);
  }
  return res;
}
