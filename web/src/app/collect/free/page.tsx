import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** W110 자유롭게 기록하기 (+ W111 임시 저장됨, W113 나가기 확인 팝업) */
export default function CollectFreePage() {
  return (
    <ScreenPlaceholder
      id="W110"
      title="자유롭게 기록하기"
      notes={["제목(선택)·본문·글자 수", "임시 저장(W111) · 소재로 저장 → M120", "뒤로가기 → 나가기 확인(W113)"]}
      links={[{ label: "소재로 저장 → 소재 확인", href: routes.materialReview("sample") }]}
    />
  );
}
