/** 로딩 표시. 예) '기록에서 소재를 찾고 있어요'(M120), '생각 중…'(W210), '소재를 엮어 글을 쓰고 있어요…'(W330) */
export function Spinner({ className = "size-6" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`animate-spin ${className.includes("text-") ? "" : "text-primary"} ${className}`} fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Loading({ message, fullScreen = false }: { message?: string; fullScreen?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center gap-3 text-sm text-ink-soft ${fullScreen ? "flex-1 py-24" : "py-10"}`}
    >
      <Spinner className="size-8" />
      {message ?? <span className="sr-only">불러오는 중</span>}
      {message && <p>{message}</p>}
    </div>
  );
}
