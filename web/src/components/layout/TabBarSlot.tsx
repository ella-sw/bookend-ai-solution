"use client";

import { usePathname } from "next/navigation";
import { shouldShowTabBar } from "@/lib/routes";
import TabBar from "./TabBar";

/** 탭 화면이면 하단 탭과, 탭 높이만큼의 빈 공간(내용이 탭에 가리지 않게)을 넣는다. */
export default function TabBarSlot() {
  const pathname = usePathname();
  if (!shouldShowTabBar(pathname)) return null;

  return (
    <>
      <div aria-hidden className="h-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] shrink-0" />
      <TabBar pathname={pathname} />
    </>
  );
}
