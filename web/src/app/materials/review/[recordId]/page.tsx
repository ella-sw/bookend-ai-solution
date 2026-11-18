import { Suspense } from "react";
import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { Loading } from "@/components/ui/Loading";
import { routes } from "@/lib/routes";

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
  return (
    <ScreenPlaceholder
      id="M120"
      title="소재 확인"
      param={{ name: "recordId", value: recordId }}
      notes={[
        "분석 중: '기록에서 소재를 찾고 있어요' (최대 60초 → 실패)",
        "소재 없음: [직접 정리하기] 강조 + [새 대화 시작하기]/[새로 기록하기]",
        "실패만 [다시 분석] · 원본만 보관",
        "후보: 요약·주제 고치고 [소재함에 보관]",
        "[직접 정리하기] 입력 규칙: 수정 대기 목록 10번 (제안, C 합의 전 → 입력 화면 목업만)",
        "시간 초과 뒤 늦게 온 결과 버림: 목록 9번 (전달됨, B·C 답 대기 → 실제 연결 전 확정)",
      ]}
      links={[
        { label: "소재함에 보관 → 소재함", href: routes.materials },
        { label: "새로 기록하기", href: routes.collectFree },
        { label: "새 대화 시작하기", href: routes.collectAi },
      ]}
    />
  );
}
