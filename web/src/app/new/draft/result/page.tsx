import { Suspense } from "react";
import DraftResultScreen from "@/components/aiDraft/DraftResultScreen";
import { Loading } from "@/components/ui";

/** W330 초안 결과 (?essay=). 주소 검색값을 읽으므로 Suspense로 감싼다 */
export default function DraftResultPage() {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <DraftResultScreen />
    </Suspense>
  );
}
