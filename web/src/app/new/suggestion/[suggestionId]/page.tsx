import { Suspense } from "react";
import SuggestionDetailScreen from "@/components/newEssay/SuggestionDetail";
import { Loading } from "@/components/ui";

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
  return <SuggestionDetailScreen suggestionId={suggestionId} />;
}
