import { notFound } from "next/navigation";
import { USE_MOCK } from "@/lib/api/config";

/**
 * 개발용 화면(/dev/*)은 개발 중이거나 목업으로 돌 때만 연다.
 * 실제 서버에 연결된 배포 사이트에서는 '찾을 수 없음' — /dev/mock의 [모든 기록 지우기]가
 * 실제 데이터를 지우지 않게 하려는 것.
 */
export default function DevLayout({ children }: LayoutProps<"/dev">) {
  if (process.env.NODE_ENV === "production" && !USE_MOCK) notFound();
  return children;
}
