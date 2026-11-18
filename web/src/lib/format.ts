import type { IsoTime, RecordType } from "@/lib/api";

/** 화면 날짜 'M.DD' (예: 11.08). 이 기기의 시간대 기준 */
export function formatMonthDay(iso: IsoTime | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, "0")}`;
}

/** 기록 방식 이름 (M110·M130 카드 문구) */
export const RECORD_TYPE_LABEL: Record<RecordType, string> = {
  free: "자유롭게 기록하기",
  qna: "AI 질문에 답하기",
};

/** 제목이 없으면 원문 앞부분, 그것도 없으면 '(제목 없음)' */
export function titleOrPreview(title: string | null, preview?: string, length = 20): string {
  if (title?.trim()) return title;
  const p = preview?.trim();
  if (p) return p.length > length ? `${p.slice(0, length)}…` : p;
  return "(제목 없음)";
}
