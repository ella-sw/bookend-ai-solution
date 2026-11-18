import { Suspense } from "react";
import AiStyleScreen from "@/components/aiDraft/AiStyleScreen";
import { Loading } from "@/components/ui";

/** W310 문체 선택 · W320 길이 선택 (한 화면 2단계). 주소 검색값(m·s·from·regen…)을 읽으므로 Suspense로 감싼다 */
export default function DraftOptionsPage() {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <AiStyleScreen />
    </Suspense>
  );
}
