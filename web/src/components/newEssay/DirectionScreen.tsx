"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BottomActionBar, BottomActionBarSpacer, Button, Loading, RetryNotice, ScreenHeader, useToast } from "@/components/ui";
import { getMaterialBox, getSuggestion, type MaterialCard } from "@/lib/api";
import { newEssayHref, readNewEssayParams, type NewEssayParams } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/**
 * N120 글의 방향 확인 (UI 설계서 v7 19쪽 + 목록 20번: 방향 입력칸 없음)
 * - 고른 소재: 고른 순서대로, ×로 빼기, [+ 소재 추가] → N110 (지금 m 그대로)
 *   소재 정보는 소재함(GET /materials)에서 찾는다. 없는 id(삭제됨)는 빼고 '삭제된 소재는 뺐어요'
 * - s가 있으면 제안의 '글의 방향'을 읽기 전용으로. 없으면 방향 영역 없음
 * - 소재 0개: [AI로 초안 만들기] 막고 '소재를 1개 이상 골라 주세요'. [직접 쓰기]는 됨
 * - 빼거나 정리한 값은 주소(m·s)에도 바로 반영 → 새로고침해도 유지
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId). 주소만 바꾸는 갱신에서는 그대로
 */
export default function DirectionScreen() {
  const { bfcacheId } = useRouter();
  const search = useSearchParams();
  // 새로 들어올 때(bfcacheId가 바뀔 때)의 주소 값으로 시작한다.
  // 이 화면이 주소를 바꾸는(replace) 동안에는 bfcacheId가 그대로라 다시 시작하지 않는다
  const [snapshot, setSnapshot] = useState(() => ({ id: bfcacheId, params: readNewEssayParams(search) }));
  if (snapshot.id !== bfcacheId) setSnapshot({ id: bfcacheId, params: readNewEssayParams(search) });
  return <Direction key={snapshot.id} initial={snapshot.params} />;
}

function Direction({ initial }: { initial: NewEssayParams }) {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [params, setParams] = useState<NewEssayParams>(initial);
  const [materials, setMaterials] = useState<MaterialCard[] | null>(null);
  const [direction, setDirection] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cleaned = useRef(false);

  /** 값을 바꾸고 주소에도 반영 (방문 기록은 늘리지 않음) */
  const update = (next: NewEssayParams) => {
    setParams(next);
    router.replace(newEssayHref(routes.newDirection, next), { scroll: false });
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getMaterialBox(), initial.s ? getSuggestion(initial.s) : Promise.resolve(null)]).then(([box, sg]) => {
      if (cancelled) return;
      if (!box.ok) {
        if (!goOnboardingIfNeeded(box.error)) setFailed(true);
        return;
      }
      setMaterials(box.data.materials);
      setFailed(false);
      if (sg && sg.ok) setDirection(sg.data.direction);
      if (sg && !sg.ok && goOnboardingIfNeeded(sg.error)) return;

      // 처음 한 번: 없는 소재(삭제됨)·없는 제안을 정리
      if (cleaned.current) return;
      cleaned.current = true;
      const usable = initial.m.filter((id) => box.data.materials.some((m) => m.id === id));
      const dropSuggestion = !!sg && !sg.ok && sg.error.code === "suggestion_not_found";
      if (usable.length !== initial.m.length) toast("삭제된 소재는 뺐어요");
      if (usable.length !== initial.m.length || dropSuggestion) {
        const next = { ...initial, m: usable, s: dropSuggestion ? null : initial.s };
        setParams(next);
        router.replace(newEssayHref(routes.newDirection, next), { scroll: false });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, initial, goOnboardingIfNeeded, router, toast]);

  const header = <ScreenHeader title="글의 방향" back />;

  if (failed && !materials) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!materials) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  const byId = new Map(materials.map((m) => [m.id, m]));
  const chosen = params.m.map((id) => byId.get(id)).filter((m): m is MaterialCard => !!m);
  const empty = chosen.length === 0;

  return (
    <>
      {header}
      <div className="flex flex-col gap-6 px-5 pt-5 pb-4">
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink-soft">고른 소재 {chosen.length}개</h2>
          {empty && <p className="text-sm text-danger">소재를 1개 이상 골라 주세요</p>}
          {chosen.length > 0 && (
            <ol className="divide-y divide-line rounded-2xl border border-line">
              {chosen.map((m, i) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="text-sm text-ink-mute">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate text-[15px]">{m.title?.trim() || "(제목 없음)"}</span>
                  <button
                    type="button"
                    aria-label={`${m.title ?? "소재"} 빼기`}
                    onClick={() => update({ ...params, m: params.m.filter((x) => x !== m.id) })}
                    className="flex size-8 items-center justify-center rounded-full text-ink-mute active:bg-subtle"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
          )}
          <Button variant="ghost" className="self-start" onClick={() => router.push(newEssayHref(routes.newSelect, params))}>
            + 소재 추가
          </Button>
        </section>

        {params.s && direction && (
          <section className="flex flex-col gap-1.5">
            <h2 className="text-sm font-semibold text-ink-soft">글의 방향</h2>
            <p className="rounded-xl bg-subtle px-4 py-3 text-[15px] leading-relaxed">{direction}</p>
          </section>
        )}
      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" onClick={() => router.push(newEssayHref(routes.newDirect, params))}>
            직접 쓰기
          </Button>
          <Button size="lg" disabled={empty} onClick={() => router.push(newEssayHref(routes.newAiStyle, params))}>
            AI로 초안 만들기
          </Button>
        </div>
      </BottomActionBar>
    </>
  );
}
