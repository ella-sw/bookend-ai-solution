import { Suspense } from "react";
import MaterialSelectScreen from "@/components/newEssay/MaterialSelect";
import { Loading } from "@/components/ui";

/** N110 소재 고르기. 주소 검색값(m·s·from)을 읽으므로 Suspense로 감싼다 */
export default function NewSelectPage() {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <MaterialSelectScreen />
    </Suspense>
  );
}
