"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ButtonLink, Loading, RetryNotice, ScreenHeader } from "@/components/ui";
import { getEssays, type EssayCard } from "@/lib/api";
import { formatMonthDay } from "@/lib/format";
import { newEssayHref } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

const METHOD_LABEL: Record<EssayCard["method"], string> = { direct: "직접 쓰기", ai: "AI 초안" };

/**
 * L110 내 서재 (UI 설계서 v7 24쪽, B GET /essays)
 * - 글만 모음. 직접 쓰기 임시 저장(1개)은 맨 위, 나머지는 최근에 고친 순서 (서버가 정렬)
 * - 카드: 제목(없으면 '(제목 없음)'), '직접 쓰기/AI 초안 · {상태} · M.DD · 소재 N개'
 * - 임시 저장 → N140 이어 쓰기, 나머지 → L120
 * - 빈 상태: '아직 쓴 글이 없어요' + [새 글 쓰기]
 * 화면에 다시 올 때마다 새로 불러온다
 */
export default function LibraryScreen() {
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const [essays, setEssays] = useState<EssayCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void getEssays().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setEssays(res.data);
        setFailed(false);
      } else if (!goOnboardingIfNeeded(res.error)) {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, goOnboardingIfNeeded]);

  const header = <ScreenHeader title="내 서재" />;

  if (failed && !essays) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!essays) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  if (essays.length === 0) {
    return (
      <>
        {header}
        <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div>
            <p className="text-[15px] font-semibold">아직 쓴 글이 없어요</p>
            <p className="mt-1 text-sm text-ink-soft">모은 소재로 첫 글을 써 볼까요?</p>
          </div>
          <ButtonLink href={newEssayHref(routes.newSelect, { from: "home" })} variant="secondary">
            새 글 쓰기
          </ButtonLink>
        </section>
      </>
    );
  }

  return (
    <>
      {header}
      <ul className="flex flex-col gap-2 px-5 pt-4 pb-6">
        {essays.map((e) => (
          <li key={e.id}>
            <Link
              href={e.is_draft ? newEssayHref(routes.newDirect, { resume: "draft" }) : routes.essay(e.id)}
              className="block rounded-2xl border border-line p-4 active:bg-subtle"
            >
              <p className="truncate text-[15px] font-semibold">{e.title?.trim() || "(제목 없음)"}</p>
              <p className="mt-1 text-xs text-ink-mute">
                {[METHOD_LABEL[e.method], e.state, formatMonthDay(e.updated_at), `소재 ${e.material_count}개`].join(" · ")}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
