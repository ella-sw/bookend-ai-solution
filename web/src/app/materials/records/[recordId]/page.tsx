import { Suspense } from "react";
import KeptRecordScreen from "@/components/material/KeptRecordScreen";
import { Loading } from "@/components/ui/Loading";

/** M130 보관한 원본 (원본만 보관한 기록, + M132 기록 삭제 팝업) */
export default function KeptRecordPage({ params }: PageProps<"/materials/records/[recordId]">) {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <KeptRecord params={params} />
    </Suspense>
  );
}

async function KeptRecord({ params }: Pick<PageProps<"/materials/records/[recordId]">, "params">) {
  const { recordId } = await params;
  return <KeptRecordScreen recordId={recordId} />;
}
