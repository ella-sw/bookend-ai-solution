"use client";

import { useRouter } from "next/navigation";

/**
 * 화면 위 제목 줄. 예) '‹ 자유롭게 기록하기  [임시 저장]'
 * - back: true면 ‹ 버튼 (기본: 이전 화면). onBack을 주면 그걸 부름 (예: 나가기 확인 팝업 띄우기)
 * - right: 오른쪽 자리 (임시 저장, ⋯ 더보기 등)
 */
export function ScreenHeader({
  title,
  back = false,
  onBack,
  right,
}: {
  title?: string;
  back?: boolean;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  const router = useRouter();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-line/60 bg-surface/95 px-2 backdrop-blur">
      {back ? (
        <button
          type="button"
          aria-label="뒤로"
          onClick={onBack ?? (() => router.back())}
          className="flex size-10 items-center justify-center rounded-full text-2xl text-ink active:bg-subtle"
        >
          ‹
        </button>
      ) : (
        <span className="w-3" />
      )}
      {title && <h1 className="flex-1 truncate text-[17px] font-bold">{title}</h1>}
      {!title && <span className="flex-1" />}
      {right && <div className="flex items-center gap-1 pr-1">{right}</div>}
    </header>
  );
}
