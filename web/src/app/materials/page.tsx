import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** M110 소재함 */
export default function MaterialsPage() {
  return (
    <ScreenPlaceholder
      id="M110"
      title="소재함"
      back={false}
      notes={[
        "확인 대기 · 임시 저장 기록 · 주제 칩 · 보관한 소재 카드",
        "소재 없음·실패로 나간 기록도 확인 대기 카드로 (목록 5번, v7 반영)",
        "맨 아래 '원본만 보관한 기록 N개 ▾'",
      ]}
      links={[
        { label: "소재 카드 → 소재 상세", href: routes.material("sample") },
        { label: "확인 대기 카드 → 소재 확인", href: routes.materialReview("sample") },
        { label: "원본만 보관 → 보관한 원본", href: routes.keptRecord("sample") },
        { label: "새 글 쓰기", href: routes.newSelect },
      ]}
    />
  );
}
