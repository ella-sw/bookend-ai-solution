import Link from "next/link";
import { Tag } from "./Chip";

/**
 * 소재 카드 상태 (M110 문구 기준)
 * - kept: 보관한 소재 → 제목·요약·주제·날짜·'글 N편에 사용'
 * - review: '확인해 주세요' / analyzing: '분석 중' / empty: '소재 없음' / failed: '분석 실패'
 * - draft: 임시 저장 기록 / rawOnly: '원본만 보관'
 */
export type MaterialCardStatus = "kept" | "review" | "analyzing" | "empty" | "failed" | "draft" | "rawOnly";

const statusLabel: Record<Exclude<MaterialCardStatus, "kept">, string> = {
  review: "확인해 주세요",
  analyzing: "분석 중",
  empty: "소재 없음",
  failed: "분석 실패",
  draft: "임시 저장",
  rawOnly: "원본만 보관",
};

export function MaterialCard({
  href,
  title,
  summary,
  topics = [],
  date,
  usedCount,
  status = "kept",
  selected,
}: {
  href?: string;
  title: string;
  summary?: string;
  topics?: string[];
  /** 화면 표시용 날짜 (예: '11.12') */
  date?: string;
  usedCount?: number;
  status?: MaterialCardStatus;
  /** N110 고르기에서 체크 표시 */
  selected?: boolean;
}) {
  const body = (
    <div
      className={`rounded-2xl border p-4 ${selected ? "border-primary bg-primary-soft/40" : "border-line bg-surface"} ${
        href ? "active:bg-subtle" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="line-clamp-1 text-[15px] font-semibold">{title}</h3>
        {status !== "kept" && (
          <Tag tone={status === "review" ? "accent" : status === "failed" ? "default" : "primary"}>
            {status === "analyzing" && <span aria-hidden className="mr-1 size-1.5 animate-pulse rounded-full bg-current" />}
            {statusLabel[status]}
          </Tag>
        )}
      </div>
      {summary && <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-ink-soft">{summary}</p>}
      {(topics.length > 0 || date || usedCount !== undefined) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-mute">
          {topics.map((topic) => (
            <Tag key={topic}>{topic}</Tag>
          ))}
          {date && <span className="ml-auto">{date}</span>}
          {usedCount !== undefined && usedCount > 0 && <span>· 글 {usedCount}편에 사용</span>}
        </div>
      )}
    </div>
  );

  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}
