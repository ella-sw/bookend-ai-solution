import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** L110 내 서재 (내 글 목록) */
export default function LibraryPage() {
  return (
    <ScreenPlaceholder
      id="L110"
      title="내 서재"
      back={false}
      notes={["직접 쓰기 임시 저장은 맨 위, 나머지는 최근에 고친 순", "빈 상태: '아직 쓴 글이 없어요' + [새 글 쓰기]"]}
      links={[
        { label: "글 → 글 상세", href: routes.essay("sample") },
        { label: "새 글 쓰기", href: routes.newSelect },
      ]}
    />
  );
}
