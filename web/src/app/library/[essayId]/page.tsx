import { Suspense } from "react";
import EssayDetailScreen from "@/components/library/EssayDetailScreen";
import { Loading } from "@/components/ui/Loading";

/** L120 글 상세 (+ L121 더보기, L122 저장 방식 선택, L123 공유 창) */
export default function EssayPage({ params }: PageProps<"/library/[essayId]">) {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <Essay params={params} />
    </Suspense>
  );
}

async function Essay({ params }: Pick<PageProps<"/library/[essayId]">, "params">) {
  const { essayId } = await params;
  return <EssayDetailScreen essayId={essayId} />;
}
