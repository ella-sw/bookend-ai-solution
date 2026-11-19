"use client";

import Link from "next/link";
import { Suspense, useEffect, useLayoutEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import EntryGate from "@/components/layout/EntryGate";
import { CollectSheet } from "@/components/home/CollectSheet";
import { SuggestionCard } from "@/components/home/SuggestionCard";
import { Button, ButtonLink, Loading, MaterialCard, RetryNotice, Spinner } from "@/components/ui";
import { getMaterialBox, getSuggestions, USE_MOCK, type MaterialCard as MaterialCardData, type SuggestionList } from "@/lib/api";
import { newEssayHref } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/**
 * 같은 주제 소재가 이만큼 모이면 서버가 글쓰기 제안을 만든다.
 * B 설정 suggest_min_records의 기본값 (서버 값이 바뀌면 같이 고친다)
 */
const SUGGEST_MIN_RECORDS = 3;

/**
 * H110 홈 (UI 설계서 v7 5쪽, 목록 24번)
 * - 들어오기 전에 EntryGate가 세션·동의를 확인한다 (목록 19번). 확인 전에는 홈을 그리지 않음
 * - [+ 소재 모으기] → H120 시트 (임시 저장이 있으면 H121) / [✎ 새 글 쓰기] → N110 (from = home)
 * - 글쓰기 제안: 계산 중이면 '소재를 정리하고 있어요', 있으면 첫 번째 카드, 실패면 숨김.
 *   제안이 없고 소재가 1개 이상이면 그 자리에 회색 한 줄 '같은 주제 소재가 3개 모이면 글쓰기 제안을 드려요' (목록 27번)
 * - 최근 소재: 보관한 소재 앞 3개 → M130, [전체 보기 ›] → M110. 0개면 첫 소재 안내 + [소재 모으기]
 * - ?collect=1 (빈 상태의 [소재 모으기], 목록 14번): H120 시트를 연 채로 시작하고 주소에서 그 값을 지운다 (replace)
 * - 들어올 때마다 새로 불러온다 (Activity로 다시 보이면 effect가 다시 돈다)
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId): 제안 노출 이벤트도 화면마다 새로 센다
 */
export default function HomePage() {
  return (
    <EntryGate>
      <Suspense fallback={<Loading fullScreen />}>
        <HomeScreen />
      </Suspense>
    </EntryGate>
  );
}

function HomeScreen() {
  const { bfcacheId } = useRouter();
  const openCollect = useSearchParams().get("collect") === "1";
  return <Home key={bfcacheId} openCollect={openCollect} />;
}

function Home({ openCollect }: { openCollect: boolean }) {
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const [collectOpen, setCollectOpen] = useState(false);

  // ?collect=1은 한 번만: 주소에서 먼저 지운 뒤(replace) 시트를 연다 → 시트를 닫고 돌아와도 다시 열리지 않는다.
  // 화면을 그린 직후에 연다 (처음부터 열린 채로 그리면 개발 모드에서 시트의 뒤로가기 기록이 두 번 쌓임)
  useLayoutEffect(() => {
    if (!openCollect) return;
    if (window.location.search) window.history.replaceState(null, "", routes.home);
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setCollectOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [openCollect]);
  const [materials, setMaterials] = useState<MaterialCardData[] | null>(null);
  const [boxFailed, setBoxFailed] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionList | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 이 화면에서 이미 보인 제안 (suggestion_shown 1번)
  const [shownIds] = useState(() => new Set<string>());

  useEffect(() => {
    let cancelled = false;
    void getMaterialBox().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setMaterials(res.data.materials);
        setBoxFailed(false);
      } else if (!goOnboardingIfNeeded(res.error)) {
        setBoxFailed(true);
      }
    });
    // 제안은 실패해도 안내 없이 카드만 숨긴다
    void getSuggestions().then((res) => {
      if (!cancelled) setSuggestions(res.ok ? res.data : null);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, goOnboardingIfNeeded]);

  const suggestion = suggestions && !suggestions.computing ? suggestions.suggestions[0] : undefined;

  return (
    <>
      <header className="flex h-14 items-center px-5">
        <h1 className="text-xl font-extrabold tracking-tight">Rowflow</h1>
      </header>

      <section className="grid grid-cols-2 gap-3 px-5 pt-2">
        <button
          type="button"
          onClick={() => setCollectOpen(true)}
          className="flex h-28 flex-col items-start justify-between rounded-2xl bg-primary p-4 text-left text-white active:brightness-90"
        >
          <span className="text-2xl leading-none">＋</span>
          <span>
            <span className="block text-base font-bold">소재 모으기</span>
            <span className="text-xs opacity-80">떠오른 경험을 적거나 AI 질문에 답해요</span>
          </span>
        </button>
        <Link
          href={newEssayHref(routes.newSelect, { from: "home" })}
          className="flex h-28 flex-col items-start justify-between rounded-2xl border border-line bg-surface p-4 active:bg-subtle"
        >
          <span className="text-2xl leading-none">✎</span>
          <span>
            <span className="block text-base font-bold">새 글 쓰기</span>
            <span className="text-xs text-ink-mute">모인 소재를 골라 글로 엮어요</span>
          </span>
        </Link>
      </section>

      {/* 글쓰기 제안: 계산 중이면 한 줄, 있으면 첫 번째 카드, 없거나 실패면 숨김 */}
      {suggestions?.computing && (
        <p className="mx-5 mt-6 flex items-center gap-2 rounded-xl bg-subtle px-4 py-3 text-sm text-ink-soft" role="status">
          <Spinner className="size-4" /> 소재를 정리하고 있어요
        </p>
      )}
      {suggestion && (
        <div className="mt-6 px-5">
          <SuggestionCard suggestion={suggestion} shownIds={shownIds} />
        </div>
      )}
      {/* 제안이 아직 없을 때 (불러온 뒤에만, 소재 0개인 빈 상태에는 넣지 않음) */}
      {suggestions && !suggestions.computing && !suggestion && materials && materials.length > 0 && (
        <p className="mx-5 mt-6 text-[13px] text-ink-mute">같은 주제 소재가 {SUGGEST_MIN_RECORDS}개 모이면 글쓰기 제안을 드려요</p>
      )}

      <section className="mt-8 px-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-bold">최근 소재</h2>
          <Link href={routes.materials} className="text-sm text-ink-mute">
            전체 보기 ›
          </Link>
        </div>
        {boxFailed && !materials ? (
          <div className="mt-3">
            <RetryNotice
              message="연결이 불안정해요"
              onRetry={() => {
                setBoxFailed(false);
                setAttempt((n) => n + 1);
              }}
            />
          </div>
        ) : !materials ? (
          <Loading />
        ) : materials.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-3 rounded-2xl bg-subtle px-5 py-10 text-center">
            <div>
              <p className="text-[15px] font-semibold">아직 모은 소재가 없어요</p>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                오늘 있었던 일 하나를 적어 볼까요?
                <br />
                적은 기록에서 글감을 찾아 드려요.
              </p>
            </div>
            <Button variant="secondary" onClick={() => setCollectOpen(true)}>
              소재 모으기
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {materials.slice(0, 3).map((m) => (
              <MaterialCard key={m.id} href={routes.material(m.id)} title={m.title?.trim() || "(제목 없음)"} topics={m.topics.map((t) => t.name)} />
            ))}
          </div>
        )}
      </section>

      {/* H120 소재 모으기 방식 선택 + H121 이어 쓰기 확인 */}
      <CollectSheet open={collectOpen} onClose={() => setCollectOpen(false)} />

      {(process.env.NODE_ENV !== "production" || USE_MOCK) && (
        <div className="mt-auto px-5 pt-10 pb-4">
          <ButtonLink href="/dev/screens" variant="ghost" block>
            화면 목록 (개발용)
          </ButtonLink>
        </div>
      )}
    </>
  );
}
