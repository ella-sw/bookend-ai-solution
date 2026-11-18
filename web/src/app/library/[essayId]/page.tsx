import { Suspense } from "react";
import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { Loading } from "@/components/ui/Loading";
import { routes } from "@/lib/routes";

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
  return (
    <ScreenPlaceholder
      id="L120"
      title="글 상세"
      param={{ name: "essayId", value: essayId }}
      notes={[
        "버전 고르기 (초안 · v1 · v2…) · 사용한 소재 칩 · 본문",
        "직접 고치기 → 저장 방식 선택(L122)",
        "더보기(L121) → 공유 창(L123): [복사] / [다른 앱으로 공유] (목록 13·15번 합의: share_method)",
      ]}
      links={[
        { label: "다시 만들기 → 문체 선택", href: routes.newAiStyle },
        { label: "사용한 소재 → 소재 상세", href: routes.material("sample") },
      ]}
    />
  );
}
