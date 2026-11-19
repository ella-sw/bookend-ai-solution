"use client";

import { useRouter } from "next/navigation";

/**
 * 화면 위 제목 줄. 예) '‹ 자유롭게 기록하기  [임시 저장]'
 * - back: true면 ‹ 버튼 (기본: 이전 화면). onBack을 주면 그걸 부름 (예: 나가기 확인 팝업 띄우기)
 * - right: 오른쪽 자리 (임시 저장, ⋯ 더보기 등)
 * 터치 영역: [뒤로]와 오른쪽의 버튼·링크는 보이는 크기는 그대로 두고 ::after로 44×44px 이상 (가운데 기준으로 넓힘)
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
          className="relative flex size-10 items-center justify-center rounded-full text-2xl text-ink after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] active:bg-subtle"
        >
          ‹
        </button>
      ) : (
        <span className="w-3" />
      )}
      {title && <h1 className="flex-1 truncate text-[17px] font-bold">{title}</h1>}
      {!title && <span className="flex-1" />}
      {right && (
        <div
          className={
            "flex items-center gap-1 pr-1 " +
            "[&_a]:relative [&_a]:after:absolute [&_a]:after:top-1/2 [&_a]:after:left-1/2 [&_a]:after:h-full [&_a]:after:min-h-11 [&_a]:after:w-full [&_a]:after:min-w-11 [&_a]:after:-translate-x-1/2 [&_a]:after:-translate-y-1/2 [&_a]:after:content-[''] " +
            "[&_button]:relative [&_button]:after:absolute [&_button]:after:top-1/2 [&_button]:after:left-1/2 [&_button]:after:h-full [&_button]:after:min-h-11 [&_button]:after:w-full [&_button]:after:min-w-11 [&_button]:after:-translate-x-1/2 [&_button]:after:-translate-y-1/2 [&_button]:after:content-['']"
          }
        >
          {right}
        </div>
      )}
    </header>
  );
}
