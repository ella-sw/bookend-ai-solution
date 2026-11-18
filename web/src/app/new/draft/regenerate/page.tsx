import { Suspense } from "react";
import RegenResultScreen from "@/components/aiDraft/RegenResultScreen";
import { Loading } from "@/components/ui";

/** W340 다시 만든 결과 (+ W341 저장 창). 주소 검색값(essay·request)을 읽으므로 Suspense로 감싼다 */
export default function DraftRegeneratePage() {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <RegenResultScreen />
    </Suspense>
  );
}
