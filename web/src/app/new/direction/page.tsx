import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** N120 글의 방향 확인 */
export default function NewDirectionPage() {
  return (
    <ScreenPlaceholder
      id="N120"
      title="글의 방향"
      notes={["고른 소재 순서대로 · × 빼기 · [+ 소재 추가]", "방향 한 줄(선택)", "소재를 모두 빼면 [AI로 초안 만들기] 막음"]}
      links={[
        { label: "직접 쓰기", href: routes.newDirect },
        { label: "AI로 초안 만들기", href: routes.newAiStyle },
      ]}
    />
  );
}
