import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** W330 초안 결과 */
export default function DraftResultPage() {
  return (
    <ScreenPlaceholder
      id="W330"
      title="AI 초안"
      notes={["만드는 중 로딩 (약 20초) · 실패 시 [다시 시도]", "자동으로 '초안' 보관"]}
      links={[
        { label: "다시 만들기", href: routes.draftRegenerate },
        { label: "내 서재로 → 글 상세", href: routes.essay("sample") },
      ]}
    />
  );
}
