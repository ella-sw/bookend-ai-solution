import { Suspense } from "react";
import DirectWriterScreen from "@/components/newEssay/DirectWriter";
import { Loading } from "@/components/ui";

/** N140 직접 쓰기 (+ W111 임시 저장됨, 나가기 확인). 주소 검색값(m·s·from·resume)을 읽으므로 Suspense로 감싼다 */
export default function NewDirectPage() {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <DirectWriterScreen />
    </Suspense>
  );
}
