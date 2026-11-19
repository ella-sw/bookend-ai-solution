import { Suspense } from "react";
import DirectionScreen from "@/components/newEssay/DirectionScreen";
import { Loading } from "@/components/ui";

/** N120 고른 소재. 주소 검색값(m·s·from)을 읽으므로 Suspense로 감싼다 */
export default function NewDirectionPage() {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <DirectionScreen />
    </Suspense>
  );
}
