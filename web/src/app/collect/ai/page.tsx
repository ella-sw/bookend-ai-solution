import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** W210 AI 질문에 답하기 (+ W211 나가기 확인, W212 질문 마무리) */
export default function CollectAiPage() {
  return (
    <ScreenPlaceholder
      id="W210"
      title="AI 질문"
      notes={[
        "진행도 n/7 · 첫 질문 바꾸기 1/30 (30/30 다음은 1/30)",
        "다른 질문 보기 6회 · 최소 답변 2개 전 [소재로 저장] 막음",
        "답변 7개면 질문 마무리(W212) — 주소 없이 이 화면의 상태로 만듦",
        "[다른 질문 보기] 실패·차감 규칙: 수정 대기 목록 12번 (제안, C 합의 전 → 목업만)",
      ]}
      links={[{ label: "소재로 저장 → 소재 확인", href: routes.materialReview("sample") }]}
    />
  );
}
