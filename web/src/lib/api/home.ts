import { request } from "./client";
import type { HomeSummary, Topic } from "./types";

/** H110 홈: 최근 소재 3개 · 글쓰기 제안 카드 · 분석 중 여부 */
export function getHomeSummary() {
  return request<HomeSummary>({ method: "GET", path: "/home", mock: { key: "home.get" } });
}

/** 정해진 주제 10개 (칩·소재 정보 고치기에 사용) */
export function listTopics() {
  return request<Topic[]>({ method: "GET", path: "/topics", mock: { key: "topics.list" } });
}
