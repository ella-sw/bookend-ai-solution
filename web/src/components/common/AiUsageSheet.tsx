"use client";

import { BottomSheet } from "@/components/ui";

/**
 * AI 사용 안내 시트 (O110 [자세히 보기], S110 [AI 사용 안내]).
 * 약관·개인정보 처리방침 화면은 두지 않고 이 안내 하나만 둔다 (팀 결정 11/19).
 * 문구는 아래 상수에서만 고친다 (C 확인 뒤 바뀔 수 있음).
 */
const AI_USAGE_TITLE = "AI는 이렇게 쓰여요";

const AI_USAGE_SECTIONS: { heading: string; items: string[] }[] = [
  {
    heading: "무엇을 AI에 보내나요",
    items: [
      "자유 기록의 본문과 AI 문답의 답변을 보내요. 글감(소재)을 찾고 다음 질문을 만들 때 써요.",
      "글을 만들 때는 고른 소재와 원래 기록(소재마다 1,500자까지)을 보내요.",
      "다시 만들 때는 지금 보고 있는 글도 보내요.",
      "이름·연락처는 받지 않아요. 기록에 직접 적은 내용은 그대로 전달되니, 다른 사람의 이름이나 연락처는 적지 말아 주세요.",
    ],
  },
  {
    heading: "어디로 보내나요",
    items: ["OpenAI(미국)의 AI 모델로 보내요.", "OpenAI는 받은 내용을 최대 30일 보관하고, AI 학습에 쓰지 않아요."],
  },
  {
    heading: "내 기록은 어떻게 되나요",
    items: [
      "로그인 없이 이 브라우저로 내 기록을 찾아요. 브라우저 데이터를 지우면 다시 들어올 수 없어요.",
      "설정 > [모든 기록 삭제]로 언제든 지울 수 있어요.",
      "마지막으로 들어온 뒤 1달이 지나면 기록을 자동으로 지워요.",
    ],
  },
];

/** 내용이 길면 시트 안에서 스크롤. 맨 아래 [닫기]는 BottomSheet 기본 버튼 */
export function AiUsageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={AI_USAGE_TITLE}>
      <div className="-mx-5 max-h-[60dvh] overflow-y-auto px-5" tabIndex={0} aria-label="AI 사용 안내 내용">
        <div className="flex flex-col gap-6 pb-2">
          {AI_USAGE_SECTIONS.map((section) => (
            <section key={section.heading} className="flex flex-col gap-2">
              <h3 className="text-[15px] font-bold text-ink">{section.heading}</h3>
              <ul className="flex list-disc flex-col gap-2 pl-5 text-[15px] leading-relaxed text-ink-soft">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </BottomSheet>
  );
}
