import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** N110 소재 고르기 */
export default function NewSelectPage() {
  return (
    <ScreenPlaceholder
      id="N110"
      title="소재 고르기"
      notes={["보관 확정 소재만 · 함께 쓰면 좋은 소재 · 주제 칩", "1개 이상 골라야 [다음]", "[소재 없이 직접 쓰기]는 소재 0개여도 보임"]}
      links={[
        { label: "다음 → 글의 방향 확인", href: routes.newDirection },
        { label: "소재 없이 직접 쓰기", href: routes.newDirect },
      ]}
    />
  );
}
