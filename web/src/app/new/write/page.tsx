import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** N140 직접 쓰기 */
export default function NewWritePage() {
  return (
    <ScreenPlaceholder
      id="N140"
      title="직접 쓰기"
      notes={["참고 소재 ▾ · 제목·본문·글자 수", "임시 저장 1개 · 처음 저장은 v1 → 글 상세"]}
      links={[{ label: "저장 → 글 상세", href: routes.essay("sample") }]}
    />
  );
}
