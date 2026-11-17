"use client";

import { useEffect } from "react";

/**
 * 휴대폰 키보드가 가리는 높이를 CSS 변수 --keyboard-inset 으로 알려 준다.
 * - iOS Safari: 키보드가 떠도 화면 높이가 그대로라, 아래 고정 버튼이 가려짐 → 이 값만큼 올림
 * - Android Chrome: viewport의 interactive-widget=resizes-content로 이미 줄어들어 값이 0에 가까움
 * 아래 고정 버튼 줄은 BottomActionBar를 쓰면 자동으로 적용된다.
 */
export default function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // 주소창 접힘 같은 작은 변화는 무시
      const value = inset > 80 ? inset : 0;
      document.documentElement.style.setProperty("--keyboard-inset", `${value}px`);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return null;
}
