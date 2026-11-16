import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** W340 다시 만든 결과 (+ W341 저장 팝업) */
export default function DraftRegeneratePage() {
  return (
    <ScreenPlaceholder
      id="W340"
      title="다시 만든 글"
      notes={["다시 만들기 n회째 · 문체·길이·글자 수", "저장 → 새 버전 번호 안내(W341) → 글 상세"]}
      links={[{ label: "저장하기 → 글 상세", href: routes.essay("sample") }]}
    />
  );
}
