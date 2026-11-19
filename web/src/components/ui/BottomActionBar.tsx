/**
 * 화면 아래 고정 버튼 줄. 예) [소재로 저장](W110), 답변 입력창(W210), [다음](N110)
 * 휴대폰 키보드가 올라오면 키보드 바로 위로 올라간다 (--keyboard-inset).
 * 이 줄이 있는 화면은 본문 끝에 <BottomActionBarSpacer />를 넣어 내용이 가려지지 않게 한다.
 */
export function BottomActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed bottom-(--keyboard-inset) left-1/2 z-20 w-full max-w-(--app-max-width) -translate-x-1/2 border-t border-line/60 bg-page px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {children}
    </div>
  );
}

export function BottomActionBarSpacer({ height = "6rem" }: { height?: string }) {
  return <div aria-hidden style={{ height }} />;
}
