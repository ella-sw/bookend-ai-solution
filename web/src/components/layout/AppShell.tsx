import { Suspense } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import KeyboardInset from "./KeyboardInset";
import TabBarSlot from "./TabBarSlot";

/**
 * 모든 화면의 바깥 틀.
 * - 휴대폰: 화면 전체 폭 / PC: 최대 480px 가운데, 양옆은 비움
 * - 하단 탭은 탭 화면에서만 보이고, 기록·글쓰기 화면에서는 숨김 (lib/routes.ts)
 *   주소에 따라 달라지는 부분은 TabBarSlot 하나뿐이라 Suspense로 감쌈 (cacheComponents 대응)
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <KeyboardInset />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-(--app-max-width) flex-col bg-page shadow-[0_0_0_1px_var(--color-line)]">
        <main className="flex flex-1 flex-col">{children}</main>
        <Suspense fallback={null}>
          <TabBarSlot />
        </Suspense>
      </div>
    </ToastProvider>
  );
}
