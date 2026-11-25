import type { EssayLength, Style } from "@/lib/api";

/** 길이 이름 (W320) */
export const LENGTH_LABEL: Record<EssayLength, string> = { short: "단문", long: "장문" };

/**
 * 글 정보 줄: 예) '초안 · 감성적 · 장문 · 1,180자 · 소재 3개'
 * 글자 수가 고른 길이 범위 밖이면(in_length_range = false) 글자 수 옆에 '목표 범위 밖'
 */
export function EssayInfoLine({
  lead,
  style,
  length,
  charCount,
  inLengthRange,
  materialCount,
}: {
  lead: string;
  style: Style | null;
  length: EssayLength | null;
  charCount: number;
  inLengthRange: boolean | null;
  materialCount?: number;
}) {
  const parts = [lead, style, length ? LENGTH_LABEL[length] : null].filter(Boolean);
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-sm text-ink-soft">
      {parts.join(" · ")}
      <span>· {charCount.toLocaleString()}자</span>
      {inLengthRange === false && (
        <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs text-accent-ink">목표 범위 밖</span>
      )}
      {materialCount !== undefined && <span>· 소재 {materialCount}개</span>}
    </p>
  );
}

/** 제목·본문 (읽기 전용) */
export function EssayText({ title, body }: { title: string | null; body: string }) {
  return (
    <article className="flex flex-col gap-4">
      <h1 className="font-serif text-[22px] font-semibold leading-snug">{title?.trim() || "(제목 없음)"}</h1>
      <p className="text-[16px] leading-loose whitespace-pre-wrap">{body}</p>
    </article>
  );
}
