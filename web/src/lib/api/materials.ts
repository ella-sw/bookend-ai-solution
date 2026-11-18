import { ANALYSIS_POLL_MS, ANALYSIS_WAIT_MS } from "./config";
import { request, type ApiResult } from "./client";
import type { AnalysisState, ConfirmMaterialInput, MaterialDetail, MaterialsOverview, Original } from "./types";

/* ---------- 소재 분석 (M120) — B routers/analysis.py ---------- */

/**
 * 분석 상태와 소재 후보. 분석은 [소재로 저장] 때 서버가 시작하고, 화면을 닫아도 계속된다.
 * 60초가 지난 분석은 서버가 이 요청 때 failed로 바꾼다. 404 record_not_found
 */
export function getAnalysis(recordId: string) {
  return request<AnalysisState>({
    method: "GET",
    path: `/records/${recordId}/analysis`,
    mock: { key: "analysis.get", params: { recordId } },
  });
}

/**
 * [다시 분석]: 실패(failed)일 때만 (소재 없음은 같은 원문이라 같은 결과). 202, 이미 분석 중이면 200.
 * 오류: 409 cannot_reanalyze(done·empty) / material_deleted, 429 daily_limit (오늘 AI 호출을 다 씀)
 */
export function reanalyze(recordId: string) {
  return request<AnalysisState>({
    method: "POST",
    path: `/records/${recordId}/analysis`,
    mock: { key: "analysis.start", params: { recordId } },
  });
}

/**
 * 분석이 끝날 때까지 기다린다 (M120).
 * - 분석 중(analyzing)이면 2.5초마다 다시 묻는다. 시간 초과(60초 → failed) 판단은 서버가 한다
 * - 부르고 나서 75초가 지나도 분석 중이면 기다림만 멈추고 마지막 상태(analyzing)를 돌려준다
 *   → 화면은 '아직 찾고 있어요' (소재함 확인 대기 카드에서 이어서 볼 수 있음)
 * - signal로 화면을 나갈 때 멈춘다. 요청이 실패하면 그 결과를 바로 돌려준다
 */
export async function waitForAnalysis(
  recordId: string,
  { signal, onUpdate }: { signal?: AbortSignal; onUpdate?: (state: AnalysisState) => void } = {},
): Promise<ApiResult<AnalysisState>> {
  const deadline = Date.now() + ANALYSIS_WAIT_MS;
  while (true) {
    const result = await getAnalysis(recordId);
    if (signal?.aborted || !result.ok) return result;
    onUpdate?.(result.data);
    if (result.data.analysis_status !== "analyzing" || Date.now() >= deadline) return result;
    const stopped = await wait(ANALYSIS_POLL_MS, signal);
    if (stopped) return result;
  }
}

/** ms만큼 기다린다. 그 사이 signal이 멈추면 바로 true */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* ---------- 보관 (M120) — B routers/materials.py ---------- */

/**
 * [소재함에 보관] · [직접 정리하기] (같은 함수): AI 후보가 있으면 고친 값으로 보관 확정,
 * 없으면 직접 쓴 값으로 새 소재(origin = manual). 201, 이미 보관됐으면 200 + 그 소재 (다시 보내도 안전).
 * 오류: 404 record_not_found, 409 material_deleted, 422 unknown_topic·입력 오류(코드 없음)
 */
export function confirmMaterial(recordId: string, input: ConfirmMaterialInput) {
  return request<MaterialDetail>({
    method: "POST",
    path: `/records/${recordId}/material`,
    body: input,
    mock: { key: "material.confirm", params: { recordId } },
  });
}

/** 원문 (읽기 전용): 자유 기록 본문 또는 문답 (답한 질문만). 404 record_not_found */
export function getOriginal(recordId: string) {
  return request<Original>({
    method: "GET",
    path: `/records/${recordId}/original`,
    mock: { key: "records.original", params: { recordId } },
  });
}

/* ---------- 소재함 (M110) · 소재 상세 (M130) ---------- */

/** 확인 대기 · 임시 저장 · 보관한 소재 · 원본만 보관을 한 번에 (A 임시안 — M110 개발 때 B MaterialBox로) */
export function getMaterialsOverview() {
  return request<MaterialsOverview>({ method: "GET", path: "/materials", mock: { key: "materials.list" } });
}

/** 보관한 소재 상세. 404 material_not_found (삭제했거나 보관 전) */
export function getMaterial(materialId: string) {
  return request<MaterialDetail>({
    method: "GET",
    path: `/materials/${materialId}`,
    mock: { key: "material.get", params: { materialId } },
  });
}
