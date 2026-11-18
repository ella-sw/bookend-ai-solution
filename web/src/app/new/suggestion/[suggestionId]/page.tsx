import { Suspense } from "react";
import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { Loading } from "@/components/ui/Loading";
import { routes } from "@/lib/routes";

/** N130 글쓰기 제안 상세 */
export default function SuggestionPage({ params }: PageProps<"/new/suggestion/[suggestionId]">) {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <Suggestion params={params} />
    </Suspense>
  );
}

async function Suggestion({ params }: Pick<PageProps<"/new/suggestion/[suggestionId]">, "params">) {
  const { suggestionId } = await params;
  return (
    <ScreenPlaceholder
      id="N130"
      title="글쓰기 제안"
      param={{ name: "suggestionId", value: suggestionId }}
      notes={["제안 제목·주제 · 글의 방향 · 추천 이유 · 사용할 소재", "닫기는 이 화면만 닫음"]}
      links={[
        { label: "이 주제로 글쓰기 → 글의 방향", href: routes.newDirection },
        { label: "소재 바꾸기 → 소재 고르기", href: routes.newSelect },
        { label: "닫기 → 홈", href: routes.home },
      ]}
    />
  );
}
