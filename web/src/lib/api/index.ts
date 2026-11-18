/**
 * 화면에서 부르는 API 함수 모음. 화면 코드는 여기서만 가져다 쓴다.
 *   import { getHomeSummary } from "@/lib/api";
 *   const res = await getHomeSummary();
 *   if (!res.ok) { 실패 처리: res.error.message } else { res.data 사용 }
 *
 * 서버 주소(NEXT_PUBLIC_API_BASE_URL)가 비어 있으면 목업, 있으면 실제 FastAPI를 부른다 (config.ts).
 * 주소(path)·응답 모양은 목록 16번(서버 구조) 합의 전 A의 임시안 — 합의되면 각 함수의 path와 types.ts만 맞춘다.
 */
export * from "./client";
export * from "./config";
export * from "./types";
export * from "./users";
export * from "./home";
export * from "./records";
export * from "./qna";
export * from "./materials";
export * from "./settings";
export * from "./events";
