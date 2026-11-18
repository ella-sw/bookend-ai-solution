import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** W310 문체 선택 · W320 길이 선택 (한 화면 2단계) */
export default function DraftOptionsPage() {
  return (
    <ScreenPlaceholder
      id="W310 · W320"
      title="AI 초안"
      notes={["1단계 문체: 감성적 / 담백함", "2단계 길이: 단문 300~500자 / 장문 1,000~1,500자"]}
      links={[{ label: "에세이 만들기 → 초안 결과", href: routes.draftResult }]}
    />
  );
}
