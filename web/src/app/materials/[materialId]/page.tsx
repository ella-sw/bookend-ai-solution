import { Suspense } from "react";
import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { Loading } from "@/components/ui/Loading";
import { routes } from "@/lib/routes";

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
  return (
    <ScreenPlaceholder
      id="M130"
      title="소재 상세"
      param={{ name: "materialId", value: materialId }}
      notes={[
        "소재 정보 · 원문(읽기 전용) · 사용한 글",
        "더보기(M131): 소재 정보 고치기 · 다시 분석 · 소재 삭제",
        "다시 분석 비교([바꾸기]/[그대로 두기]) 보관 규칙: 수정 대기 목록 11번 (제안, A·B·C 합의 전 → 목업만)",
        "materials.updated_at: 목록 7번 (전달됨, B·C 답 대기)",
      ]}
      links={[
        { label: "이 소재로 글쓰기", href: routes.newSelect },
        { label: "사용한 글 → 글 상세", href: routes.essay("sample") },
      ]}
    />
  );
}
