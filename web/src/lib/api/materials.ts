import { ANALYSIS_GRACE_MS, ANALYSIS_POLL_MS, ANALYSIS_TIMEOUT_MS } from "./config";
import { request, type ApiResult } from "./client";
import type {
  AnalysisResult,
  Material,
  MaterialConfirmInput,
  MaterialDetail,
  MaterialManualInput,
  MaterialsOverview,
} from "./types";

/* ---------- 소재 분석 (M120) ---------- */

/** 분석 시작. 화면을 닫아도 서버에서 계속된다 (목록 16번: FastAPI 백그라운드 작업 안) */
export function startAnalysis(recordId: string) {
  return request<{ request_id: number }>({
    method: "POST",
    path: `/records/${recordId}/analysis`,
    mock: { key: "analysis.start", params: { recordId } },
  });
}

/** 지금 분석 상태·결과 (분석 중 / 후보 / 소재 없음 / 실패) */
export function getAnalysis(recordId: string) {
  return request<AnalysisResult>({
    method: "GET",
    path: `/records/${recordId}/analysis`,
    mock: { key: "analysis.get", params: { recordId } },
  });
}

/**
 * 분석이 끝날 때까지 기다린다 (M120 소재 확인).
 * - 60초 시간 초과는 서버가 판단해 status = failed, failure_reason = timeout으로 알려 준다 (ERD 규칙 3).
 *   화면은 실패를 지어내지 않는다 → 새로고침해도 서버 상태와 같다.
 * - 기다림 기준은 서버가 준 started_at(분석 시작 시각)이다. 화면을 나갔다 와도 60초를 다시 세지 않는다.
 * - 서버가 60초 + 여유(10초)가 지나도 분석 중이라고 하면 기다림만 멈추고 마지막 상태(analyzing)를 돌려준다.
 *   이때 화면은 '아직 분석 중'으로 보여 주면 된다 (소재함 확인 대기 카드에서 이어서 볼 수 있음).
 * - 늦게 도착한 결과를 버리는 판단도 서버 몫 — 목록 9번 (전달됨, B·C 답 대기)
 * - signal로 화면을 나갈 때 기다림을 멈출 수 있다.
 */
export async function waitForAnalysis(
  recordId: string,
  { signal, onUpdate }: { signal?: AbortSignal; onUpdate?: (r: AnalysisResult) => void } = {},
): Promise<ApiResult<AnalysisResult>> {
  // started_at이 없으면(서버가 아직 안 줌) 지금부터 센다
  let deadline = Date.now() + ANALYSIS_TIMEOUT_MS + ANALYSIS_GRACE_MS;

  while (true) {
    const result = await getAnalysis(recordId);
    if (signal?.aborted || !result.ok) return result;
    onUpdate?.(result.data);
    if (result.data.status !== "analyzing") return result;

    if (result.data.started_at) {
      deadline = new Date(result.data.started_at).getTime() + ANALYSIS_TIMEOUT_MS + ANALYSIS_GRACE_MS;
    }
    if (Date.now() >= deadline) return result;

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

/** [소재함에 보관]: 고친 후보를 보관 확정 */
export function confirmMaterial(recordId: string, input: MaterialConfirmInput) {
  return request<Material>({
    method: "POST",
    path: `/records/${recordId}/material`,
    body: input,
    mock: { key: "material.confirm", params: { recordId } },
  });
}

/**
 * [직접 정리하기] — 목록 10번 (제안, C 합의 전 → 목업만)
 * 제목 필수, 주제 1개 이상, 요약·키워드 선택, 근거 문장 없음 (origin = manual)
 */
export function saveManualMaterial(recordId: string, input: MaterialManualInput) {
  return request<Material>({
    method: "POST",
    path: `/records/${recordId}/material/manual`,
    body: input,
    mock: { key: "material.manual", params: { recordId } },
  });
}

/* ---------- 소재함 (M110) · 소재 상세 (M130) ---------- */

/** 확인 대기 · 임시 저장 · 보관한 소재 · 원본만 보관을 한 번에 */
export function getMaterialsOverview() {
  return request<MaterialsOverview>({ method: "GET", path: "/materials", mock: { key: "materials.list" } });
}

export function getMaterial(materialId: string) {
  return request<MaterialDetail>({
    method: "GET",
    path: `/materials/${materialId}`,
    mock: { key: "material.get", params: { materialId } },
  });
}
