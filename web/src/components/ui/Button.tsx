import Link from "next/link";
import type { ComponentProps } from "react";
import { Spinner } from "./Loading";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-colors select-none disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40";

const variants: Record<Variant, string> = {
  primary: "bg-primary text-white active:brightness-90",
  secondary: "border border-line bg-surface text-ink active:bg-subtle",
  ghost: "text-ink-soft active:bg-subtle",
  danger: "bg-danger text-white active:brightness-90",
};

const sizes: Record<Size, string> = {
  md: "h-11 px-4 text-[15px]",
  lg: "h-13 px-5 text-base",
};

type StyleProps = { variant?: Variant; size?: Size; block?: boolean };

export function buttonClass({ variant = "primary", size = "md", block }: StyleProps = {}) {
  return [base, variants[variant], sizes[size], block ? "w-full" : ""].join(" ");
}

/**
 * 공통 버튼. 막힌 상태는 disabled.
 * loading: 요청 중 — 돌아가는 표시와 함께 막아서 두 번 눌리지 않게 한다 (예: 소재로 저장, 다른 질문 보기)
 */
export function Button({
  variant,
  size,
  block,
  loading = false,
  disabled,
  className = "",
  type = "button",
  children,
  ...props
}: ComponentProps<"button"> & StyleProps & { loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${buttonClass({ variant, size, block })} ${className}`}
      {...props}
    >
      {loading && <Spinner className="size-4 text-current" />}
      {children}
    </button>
  );
}

/** 화면 이동용 버튼 모양 링크 */
export function ButtonLink({
  variant,
  size,
  block,
  className = "",
  ...props
}: ComponentProps<typeof Link> & StyleProps) {
  return <Link className={`${buttonClass({ variant, size, block })} ${className}`} {...props} />;
}
