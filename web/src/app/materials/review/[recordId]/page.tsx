import { Suspense } from "react";
import MaterialReviewScreen from "@/components/material/MaterialReview";
import { Loading } from "@/components/ui/Loading";

/** M120 소재 확인 (분석 중 · 후보 · 소재 없음 · 실패) */
export default function MaterialReviewPage({ params }: PageProps<"/materials/review/[recordId]">) {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <MaterialReview params={params} />
    </Suspense>
  );
}

async function MaterialReview({ params }: Pick<PageProps<"/materials/review/[recordId]">, "params">) {
  const { recordId } = await params;
  return <MaterialReviewScreen recordId={recordId} />;
}
