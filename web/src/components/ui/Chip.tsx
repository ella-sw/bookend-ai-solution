import type { ComponentProps } from "react";

/** 주제 칩. 예) 전체 / 가족 / 일상 (M110·N110 거르기, 소재 카드 주제 표시) */
export function Chip({
  selected = false,
  className = "",
  type = "button",
  ...props
}: ComponentProps<"button"> & { selected?: boolean }) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={`inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[13px] transition-colors ${
        selected ? "border-ink bg-ink font-semibold text-white" : "border-line bg-surface text-ink-soft active:bg-subtle"
      } ${className}`}
      {...props}
    />
  );
}

/** 누를 수 없는 작은 표시용 칩 (카드 안 주제 등) */
export function Tag({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "primary" | "accent" }) {
  const tones = {
    default: "bg-subtle text-ink-soft",
    primary: "bg-primary-soft text-primary",
    accent: "bg-accent-soft text-[#843c0c]",
  };
  return <span className={`inline-flex h-6 items-center rounded-md px-2 text-xs ${tones[tone]}`}>{children}</span>;
}

/** 칩 여러 개를 가로 스크롤 한 줄로 */
export function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none]">{children}</div>;
}
