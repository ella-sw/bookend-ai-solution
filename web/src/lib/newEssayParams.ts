import { ESSAY_RULES, type EntryPath, type EventProps } from "@/lib/api";

/**
 * 새 글 쓰기 화면 사이 값 (N110 → N130 → N120 → N140 / W310). 주소로 넘겨 새로고침해도 남는다.
 * - m: 고른 소재 id, 고른 순서대로 (?m=a&m=b, 최대 20개)
 * - s: 제안 id (N130에서 왔을 때)
 * - from: writing_started의 entry_path (home | materials | material_detail | suggestion | no_material, 없으면 home)
 */
export interface NewEssayParams {
  m: string[];
  s: string | null;
  from: EntryPath;
}

const ENTRY_PATHS: readonly EntryPath[] = ["home", "materials", "material_detail", "suggestion", "no_material"];

/** 주소 검색값에서 읽기 (모르는 from은 home, m은 중복 빼고 고른 순서) */
export function readNewEssayParams(search: { get(name: string): string | null; getAll(name: string): string[] }): NewEssayParams {
  const m = Array.from(new Set(search.getAll("m").filter(Boolean))).slice(0, ESSAY_RULES.materialsMax);
  const from = search.get("from");
  return {
    m,
    s: search.get("s") || null,
    from: ENTRY_PATHS.includes(from as EntryPath) ? (from as EntryPath) : "home",
  };
}

/**
 * 화면 주소 만들기. 넘기지 않은 값은 붙이지 않는다 (from = home은 생략).
 * resume = "draft": N140 이어 쓰기 (H121 [예])
 */
export function newEssayHref(base: string, params: Partial<NewEssayParams> & { resume?: "draft" }): string {
  const q = new URLSearchParams();
  for (const id of params.m ?? []) q.append("m", id);
  if (params.s) q.set("s", params.s);
  if (params.from && params.from !== "home") q.set("from", params.from);
  if (params.resume) q.set("resume", params.resume);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * writing_started 값 (목록 24·25번). suggestion_id는 from = suggestion일 때만.
 * from = suggestion인데 제안 id가 없으면 서버가 422를 주므로 home으로 보낸다
 */
export function writingStartedProps(
  writeMode: "direct" | "ai",
  params: Pick<NewEssayParams, "s" | "from">,
  materialCount: number,
): EventProps<"writing_started"> {
  const count = Math.max(0, Math.min(100, Math.trunc(materialCount)));
  if (params.from === "suggestion" && params.s) {
    return { write_mode: writeMode, entry_path: "suggestion", material_count: count, suggestion_id: params.s };
  }
  return { write_mode: writeMode, entry_path: params.from === "suggestion" ? "home" : params.from, material_count: count };
}

/* ---------- AI 초안 화면 주소 (W310·W330·W340) ---------- */

/** 다시 만들기 바탕: 보고 있던 버전 또는 직전에 다시 만든(저장 안 한) 결과 */
export type RegenBaseParam = { version: string } | { request: number };

/** W310 다시 만들기 모드: ?regen={essayId}&version={versionId} 또는 &request={requestId} */
export function regenStyleHref(base: string, essayId: string, from: RegenBaseParam): string {
  const q = new URLSearchParams({ regen: essayId });
  if ("version" in from) q.set("version", from.version);
  else q.set("request", String(from.request));
  return `${base}?${q.toString()}`;
}

/** W310 주소에서 다시 만들기 모드 값 읽기. 다시 만들기가 아니면 null */
export function readRegenParams(search: { get(name: string): string | null }): { essayId: string; base: RegenBaseParam | null } | null {
  const essayId = search.get("regen");
  if (!essayId) return null;
  const version = search.get("version");
  const request = Number(search.get("request"));
  if (version) return { essayId, base: { version } };
  if (Number.isInteger(request) && request > 0) return { essayId, base: { request } };
  return { essayId, base: null };
}

/** W330 초안 결과 주소 */
export const draftResultHref = (base: string, essayId: string) => `${base}?essay=${encodeURIComponent(essayId)}`;

/** W340 다시 만든 결과 주소 */
export const draftRegenerateHref = (base: string, essayId: string, requestId: number) =>
  `${base}?essay=${encodeURIComponent(essayId)}&request=${requestId}`;
