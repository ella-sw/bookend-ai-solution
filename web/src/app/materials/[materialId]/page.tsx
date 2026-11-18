import { Suspense } from "react";
import MaterialDetailScreen from "@/components/material/MaterialDetailScreen";
import { Loading } from "@/components/ui/Loading";

/** M130 소재 상세 (+ M131 더보기 팝업) */
export default function MaterialDetailPage({ params }: PageProps<"/materials/[materialId]">) {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <MaterialDetail params={params} />
    </Suspense>
  );
}

async function MaterialDetail({ params }: Pick<PageProps<"/materials/[materialId]">, "params">) {
  const { materialId } = await params;
  return <MaterialDetailScreen materialId={materialId} />;
}
