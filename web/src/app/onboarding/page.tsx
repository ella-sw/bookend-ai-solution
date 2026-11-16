import ScreenPlaceholder from "@/components/layout/ScreenPlaceholder";
import { routes } from "@/lib/routes";

/** O110 첫 실행 안내 · AI 사용 안내 동의 */
export default function OnboardingPage() {
  return (
    <ScreenPlaceholder
      id="O110"
      title="Rowflow 시작하기"
      back={false}
      notes={[
        "서비스 소개: 소재 모으기 → 새 글 쓰기",
        "AI 사용 안내 + [자세히 보기] 개인정보 처리방침",
        "기록 보관 안내 (브라우저 접속 정보, 1달 미접속 시 정리)",
        "동의 체크해야 [동의하고 시작하기] 눌림 → 이름 없는 사용자 만들고 홈으로",
      ]}
      links={[{ label: "동의하고 시작하기 (목업)", href: routes.home }]}
    />
  );
}
