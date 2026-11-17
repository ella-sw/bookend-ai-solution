import { Suspense } from "react";
import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { Loading } from "@/components/ui/Loading";
import { routes } from "@/lib/routes";

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
  return (
    <ScreenPlaceholder
      id="M130"
      title="보관한 원본"
      param={{ name: "recordId", value: recordId }}
      notes={[
        "M130 재사용: 소재 정보·사용한 글 숨김",
        "버튼은 M120과 같은 규칙 (실패: 다시 분석 / 소재 없음: 직접 정리하기 강조)",
        "더보기: [기록 삭제] → M132",
        "[직접 정리하기] 입력 규칙: 수정 대기 목록 10번 (제안 → 목업만)",
      ]}
      links={[
        { label: "다시 분석 → 소재 확인", href: routes.materialReview(recordId) },
        { label: "기록 삭제 후 → 소재함", href: routes.materials },
      ]}
    />
  );
}
