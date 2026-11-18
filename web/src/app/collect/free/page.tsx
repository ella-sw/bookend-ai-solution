import { Suspense } from "react";
import FreeWriter from "@/components/collect/FreeWriter";
import { Loading } from "@/components/ui";

/**
 * W110 자유롭게 기록하기 (+ W111 임시 저장됨, W113 나가기 확인 팝업)
 * ?resume=draft를 읽으므로 Suspense로 감싼다 (cacheComponents: 주소 검색값은 요청 때 정해짐)
 */
export default function CollectFreePage() {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <FreeWriter />
    </Suspense>
  );
}
