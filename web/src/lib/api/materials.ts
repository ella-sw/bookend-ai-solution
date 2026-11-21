import { ANALYSIS_POLL_MS, ANALYSIS_WAIT_MS } from "./config";
import { request, type ApiResult } from "./client";
import type {
  AnalysisState,
  ConfirmMaterialInput,
  EditMaterialInput,
  MaterialBox,
  MaterialDeleted,
  MaterialDetail,
  Original,
  RelatedMaterial,
} from "./types";

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

/* ---------- 소재함 (M110) · 소재 상세 (M130) · 더보기 (M131) — B routers/materials.py ---------- */

/** M110: 확인 대기 · 임시 저장 기록 · 보관한 소재 · 원본만 보관한 기록 */
export function getMaterialBox() {
  return request<MaterialBox>({ method: "GET", path: "/materials", mock: { key: "materials.list" } });
}

/**
 * M130 소재 상세: 소재 정보, 원문, 사용한 글, 다시 분석 진행·결과(reanalysis).
 * 404 material_not_found (삭제했거나 보관 전)
 */
export function getMaterial(materialId: string) {
  return request<MaterialDetail>({
    method: "GET",
    path: `/materials/${materialId}`,
    mock: { key: "material.get", params: { materialId } },
  });
}

/** M131 소재 정보 고치기: 요약·키워드·주제만, 바뀐 칸만 보낸다 (제목·원본은 그대로) */
export function editMaterial(materialId: string, input: EditMaterialInput) {
  return request<MaterialDetail>({
    method: "PATCH",
    path: `/materials/${materialId}`,
    body: input,
    mock: { key: "material.edit", params: { materialId } },
  });
}

/**
 * M131 다시 분석: 같은 원본으로 다시 추출. 소재는 바뀌지 않고 결과가 reanalysis에 나란히 온다
 * → [바꾸기] applyReanalysis / [그대로 두기] dismissReanalysis. 202, 이미 분석 중이면 200.
 * 오류: 429 daily_limit, 404 material_not_found
 */
export function reanalyzeMaterial(materialId: string) {
  return request<MaterialDetail>({
    method: "POST",
    path: `/materials/${materialId}/reanalyze`,
    mock: { key: "material.reanalyze", params: { materialId } },
  });
}

/** [바꾸기]: 다시 분석한 결과로 소재 정보를 바꾼다. 결과가 없으면 409 no_result */
export function applyReanalysis(materialId: string) {
  return request<MaterialDetail>({
    method: "POST",
    path: `/materials/${materialId}/reanalysis/apply`,
    mock: { key: "material.reanalysis.apply", params: { materialId } },
  });
}

/** [그대로 두기] (소재 없음·실패 안내의 [확인]도): 소재를 그대로 두고 결과를 비운다 */
export function dismissReanalysis(materialId: string) {
  return request<MaterialDetail>({
    method: "POST",
    path: `/materials/${materialId}/reanalysis/dismiss`,
    mock: { key: "material.reanalysis.dismiss", params: { materialId } },
  });
}

/**
 * M131 소재 삭제 (200 + { record_deleted }, B delete_material, 팀 결정 11/19).
 * 글(직접 쓰기 임시 저장 포함)에 쓴 소재는 숨김(원본 유지), 안 쓴 소재는 원본까지 실제 삭제.
 * 숨긴 소재는 이미 쓴 글에 '삭제된 소재'로 남고, 그 원본은 소재함 목록에 다시 나오지 않는다.
 * 오류: 404 material_not_found
 */
export function deleteMaterial(materialId: string) {
  return request<MaterialDeleted>({
    method: "DELETE",
    path: `/materials/${materialId}`,
    mock: { key: "material.delete", params: { materialId } },
  });
}

/**
 * N110 함께 쓰면 좋은 소재: 고른 소재와 주제·키워드가 같은 보관 확정 소재 (AI 없음, 최대 5개).
 * 아무것도 안 골랐으면 []. 고른 id 중 쓸 수 없는 소재가 있으면 404 material_not_found
 */
export function getRelatedMaterials(selectedIds: readonly string[]) {
  return request<RelatedMaterial[]>({
    method: "GET",
    path: "/materials/related",
    query: { selected: selectedIds },
    mock: { key: "materials.related" },
  });
}
