import { request } from "./client";
import type { EventName, EventProps } from "./types";

/**
 * 최소 사용 이벤트 기록. 본문은 넣지 않는다. 실패해도 화면 흐름은 막지 않는다 (결과를 기다리지 않아도 됨).
 *
 * body_shared (목록 13·15번, 합의):
 * - [복사] 성공 뒤 → share_method = "copy"
 * - [다른 앱으로 공유] navigator.share()가 오류 없이 끝난 뒤 → share_method = "share_sheet"
 * - 취소(AbortError)·실패는 기록하지 않는다
 * share_method를 빠뜨리면 타입 검사에서 걸린다 (화면 흐름을 멈추는 throw는 쓰지 않음)
 */
export function logEvent<N extends EventName>(
  name: N,
  ...[props]: N extends "body_shared" ? [props: EventProps<N>] : [props?: EventProps<N>]
) {
  return request<null>({ method: "POST", path: "/events", body: { name, ...props }, mock: { key: "events.log" } });
}
