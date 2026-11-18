"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui";
import { logEvent, type Suggestion } from "@/lib/api";
import { newEssayHref } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";

/**
 * 홈 글쓰기 제안 카드 (UI 설계서 v7 5쪽, 목록 24번)
 * - '글쓰기 제안 · {주제}', 제목, 이유, '사용할 소재: a / b / c'
 * - [자세히] → N130 / [이 주제로 글쓰기] → suggestion_selected 1번 → N120 (m = 제안 소재, s, from = suggestion)
 * - 카드가 화면에 실제로 보이면(절반 이상) 1번 suggestion_shown(placement = home).
 *   같은 화면에서 같은 제안은 1번 (shownIds는 홈 화면이 들고 있다)
 */
export function SuggestionCard({ suggestion, shownIds }: { suggestion: Suggestion; shownIds: Set<string> }) {
  const router = useRouter();
  const cardRef = useRef<HTMLElement>(null);
  const selected = useRef(false);

  useEffect(() => {
    const el = cardRef.current;
    if (!el || shownIds.has(suggestion.id)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || shownIds.has(suggestion.id)) return;
        shownIds.add(suggestion.id);
        observer.disconnect();
        void logEvent("suggestion_shown", { suggestion_id: suggestion.id, placement: "home" });
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [suggestion.id, shownIds]);

  const writeWithThis = () => {
    // 빠른 연속 클릭은 1번
    if (!selected.current) {
      selected.current = true;
      void logEvent("suggestion_selected", { suggestion_id: suggestion.id });
    }
    router.push(
      newEssayHref(routes.newDirection, { m: suggestion.materials.map((m) => m.id), s: suggestion.id, from: "suggestion" }),
    );
  };

  return (
    <section ref={cardRef} className="flex flex-col gap-2 rounded-2xl border border-primary/30 bg-primary-soft/30 p-4">
      <p className="text-xs font-semibold text-primary">글쓰기 제안 · {suggestion.topic.name}</p>
      <h2 className="text-base font-bold leading-snug">{suggestion.title}</h2>
      <p className="text-sm leading-relaxed text-ink-soft">{suggestion.reason}</p>
      {suggestion.materials.length > 0 && (
        <p className="text-xs text-ink-mute">
          사용할 소재: {suggestion.materials.map((m) => m.title?.trim() || "(제목 없음)").join(" / ")}
        </p>
      )}
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-2">
        <ButtonLink href={routes.suggestion(suggestion.id)} variant="secondary">
          자세히
        </ButtonLink>
        <Button onClick={writeWithThis}>이 주제로 글쓰기</Button>
      </div>
    </section>
  );
}
