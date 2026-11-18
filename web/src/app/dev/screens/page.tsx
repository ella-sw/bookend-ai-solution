import Link from "next/link";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { screens } from "@/lib/routes";

/** 개발용: 화면 ID 목록에서 바로 이동 (실제 서비스 메뉴에는 없음) */
export default function DevScreensPage() {
  return (
    <>
      <ScreenHeader title="화면 목록 (개발용)" back />
      <Link href="/dev/components" className="mx-5 mt-3 block rounded-xl bg-subtle px-4 py-3 text-sm font-semibold">
        공통 부품 미리보기 ›
      </Link>
      <Link href="/dev/mock" className="mx-5 mt-2 block rounded-xl bg-subtle px-4 py-3 text-sm font-semibold">
        목업 API 상황 고르기 · 시험 호출 ›
      </Link>
      <ul className="divide-y divide-line px-5">
        {screens.map((screen) => (
          <li key={screen.href}>
            <Link href={screen.href} className="flex h-12 items-center gap-3 text-[15px]">
              <span className="w-12 font-mono text-xs font-semibold text-ink-mute">{screen.id}</span>
              <span className="flex-1">{screen.name}</span>
              <span className="font-mono text-xs text-ink-mute">{screen.href}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
