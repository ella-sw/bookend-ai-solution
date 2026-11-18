import { request } from "./client";
import type { Suggestion, SuggestionList } from "./types";

/*
 * 글쓰기 제안 (H110 홈 카드 · N130 제안 상세) — B routers/suggestions.py
 * 준비된(ready) 제안만 온다. 없음·실패·계산 중이면 카드를 숨긴다
 */

/** 홈: 제안 카드 (최근에 만든 순) + 계산 중 여부 */
export function getSuggestions() {
  return request<SuggestionList>({ method: "GET", path: "/suggestions", mock: { key: "suggestions.list" } });
}

/** N130 제안 상세. 없거나 준비되지 않았으면 404 suggestion_not_found */
export function getSuggestion(suggestionId: string) {
  return request<Suggestion>({
    method: "GET",
    path: `/suggestions/${suggestionId}`,
    mock: { key: "suggestion.get", params: { suggestionId } },
  });
}
