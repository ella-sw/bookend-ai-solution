"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BottomActionBar, BottomActionBarSpacer, Button, Loading, RetryNotice, ScreenHeader, Tag, useToast } from "@/components/ui";
import { getSuggestion, logEvent, type Suggestion } from "@/lib/api";
import { isNewEssayDone, useEnsureFlowId, useLeaveFinishedFlow } from "@/lib/finishedFlow";
import { newEssayHref, readNewEssayParams } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/**
 * N130 글쓰기 제안 상세 (UI 설계서 v7 18쪽, 목록 20·24번, B GET /suggestions/{id})
 * - 주제·제목·글의 방향·추천 이유·사용할 소재(순서대로 → M130)
 * - 화면에 보이면 1번 suggestion_shown(placement = suggestion_detail)
 * - [소재 바꾸기] → N110 (제안 소재가 선택된 채) / [이 주제로 글쓰기] → suggestion_selected 1번 → N120
 * - [닫기] → 뒤로 (없으면 홈). 제안·소재는 건드리지 않음
 * - 흐름 id(?f=): 없으면 만들어 주소에 붙이고 N110·N120으로 넘긴다.
 *   이 흐름에서 글을 저장한 뒤 뒤로 가기로 오면 내 서재로 (목록 7번)
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + suggestionId)
 */
export default function SuggestionDetailScreen({ suggestionId }: { suggestionId: string }) {
  const { bfcacheId } = useRouter();
  const query = useSearchParams().toString();
  return <SuggestionDetail key={`${bfcacheId}:${suggestionId}`} suggestionId={suggestionId} query={query} />;
}

function SuggestionDetail({ suggestionId, query }: { suggestionId: string; query: string }) {
  const flowId = readNewEssayParams(new URLSearchParams(query)).f;
  useLeaveFinishedFlow(() => isNewEssayDone(flowId));
  useEnsureFlowId(routes.suggestion(suggestionId), query);
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const shownLogged = useRef(false);
  const selectedLogged = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getSuggestion(suggestionId).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setSuggestion(res.data);
        setFailed(false);
        return;
      }
      if (goOnboardingIfNeeded(res.error)) return;
      if (res.error.code === "suggestion_not_found") {
        toast("이 제안은 더 이상 없어요");
        router.replace(routes.home);
        return;
      }
      setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [suggestionId, attempt, goOnboardingIfNeeded, router, toast]);

  // 화면에 보이면 1번 (재렌더링·개발 모드 이중 실행에도 1번). 결과는 기다리지 않음
  useEffect(() => {
    if (!suggestion || shownLogged.current) return;
    shownLogged.current = true;
    void logEvent("suggestion_shown", { suggestion_id: suggestion.id, placement: "suggestion_detail" });
  }, [suggestion]);

  const close = () => {
    if (window.history.length > 1) router.back();
    else router.replace(routes.home);
  };

  const header = (
    <ScreenHeader
      title="글쓰기 제안"
      back
      right={
        <Button variant="ghost" className="h-9 px-3 text-sm" onClick={close}>
          닫기
        </Button>
      }
    />
  );

  if (failed && !suggestion) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!suggestion) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  const params = { m: suggestion.materials.map((m) => m.id), s: suggestion.id, from: "suggestion" as const, f: flowId };

  const writeWithThis = () => {
    // [이 주제로 글쓰기] 1번 (빠른 연속 클릭 제외)
    if (!selectedLogged.current) {
      selectedLogged.current = true;
      void logEvent("suggestion_selected", { suggestion_id: suggestion.id });
    }
    router.push(newEssayHref(routes.newDirection, params));
  };

  return (
    <>
      {header}
      <div className="flex flex-col gap-6 px-5 pt-5 pb-4">
        <section className="flex flex-col gap-2">
          <div>
            <Tag tone="primary">{suggestion.topic.name}</Tag>
          </div>
          <h1 className="text-xl font-bold leading-snug">{suggestion.title}</h1>
        </section>

        <section className="flex flex-col gap-1.5">
          <h2 className="text-sm font-semibold text-ink-soft">글의 방향</h2>
          <p className="text-[15px] leading-relaxed">{suggestion.direction}</p>
        </section>

        <section className="flex flex-col gap-1.5">
          <h2 className="text-sm font-semibold text-ink-soft">추천 이유</h2>
          <p className="text-[15px] leading-relaxed text-ink-soft">{suggestion.reason}</p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink-soft">사용할 소재 {suggestion.materials.length}개</h2>
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {suggestion.materials.map((m) => (
              <li key={m.id}>
                <Link href={routes.material(m.id)} className="flex items-center justify-between gap-3 px-4 py-3 active:bg-subtle">
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold">{m.title?.trim() || "(제목 없음)"}</span>
                    {m.summary && <span className="block truncate text-sm text-ink-soft">{m.summary}</span>}
                  </span>
                  <span aria-hidden className="text-ink-mute">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" onClick={() => router.push(newEssayHref(routes.newSelect, params))}>
            소재 바꾸기
          </Button>
          <Button size="lg" onClick={writeWithThis}>
            이 주제로 글쓰기
          </Button>
        </div>
      </BottomActionBar>
    </>
  );
}
